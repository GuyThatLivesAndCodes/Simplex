<#
================================================================================
  Simplex - EXE sandbox host setup
================================================================================
  Prepares a Windows host so Simplex can run untrusted executables inside
  disposable Hyper-V guests. Run this ON THE SERVER, in an ADMINISTRATOR
  PowerShell. It is safe to re-run: every step checks before it acts.

  WHAT IT DOES
    1. Enables Hyper-V (needs a reboot the first time).
    2. Creates an internal switch + NAT so guests reach the INTERNET but are
       firewalled off from your LAN and from the Simplex host itself.
    3. Sets up guacd (the Apache Guacamole daemon) so sessions get a real mouse
       and keyboard over RDP. guacd is Linux-only, so it runs in Docker or WSL2 -
       whichever this machine already has. Without it the sandbox still works,
       but keyboard-only.
    4. Prepares the folders Simplex expects.
    5. Tells you how to produce the base Tiny11 disk (the one step that cannot
       be automated, because you must supply the Windows image yourself).

  KEEP THIS FILE PURE ASCII AND CRLF. PowerShell 5.1 reads a .ps1 as ANSI unless
  it carries a BOM, so a UTF-8 em-dash or smart quote arrives as mojibake and can
  silently break string parsing partway through the file - which shows up as
  baffling "missing terminator"/"missing closing }" errors far from the real line.

  WHAT IT DELIBERATELY DOES NOT DO
    * It does not download Windows or Tiny11 for you.
    * It does not weaken the host firewall. The rules it adds only ever RESTRICT
      the sandbox subnet.

  USAGE
    .\setup-sandbox.ps1                 # do the setup
    .\setup-sandbox.ps1 -Check          # report status only, change nothing
    .\setup-sandbox.ps1 -Uninstall      # remove the switch/NAT/rules we created
    .\setup-sandbox.ps1 -Guacd docker   # force a guacd runtime (docker|wsl|none)
    .\setup-sandbox.ps1 -StartGuacd     # (re)start guacd + refresh the port forward
    .\setup-sandbox.ps1 -PrepImage      # prepare the base image (one time)
    .\setup-sandbox.ps1 -PrepImage -GuestUser User -GuestPass pw   # fully automatic
    .\setup-sandbox.ps1 -PrepImage -Finish      # after doing the guest steps by hand
    .\setup-sandbox.ps1 -VerifyImage    # did the image edits actually stick?
================================================================================
#>

[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Uninstall,
  [string]$SwitchName = 'SimplexSandboxNAT',
  [string]$Subnet     = '192.168.211.0/24',
  [string]$HostIp     = '192.168.211.1',
  [ValidateSet('auto','docker','wsl','none')]
  [string]$Guacd      = 'auto',
  # Re-launch guacd + refresh the port forward (the WSL IP changes on every boot).
  # This is what the startup scheduled task should run.
  [switch]$StartGuacd,
  # Prepare the base image so guests get RDP and a working network without
  # Simplex ever needing to run elevated. Supply -GuestUser/-GuestPass to do it
  # fully automatically over PowerShell Direct; otherwise it boots the image and
  # tells you the handful of commands to paste inside the guest.
  [switch]$PrepImage,
  # Account INSIDE the base image. Must be the real PASSWORD - a Windows Hello
  # PIN is not accepted by PowerShell Direct.
  [string]$GuestUser = '',
  [string]$GuestPass = '',
  # Run after finishing the guest steps by hand: shuts the prep VM down, removes
  # it, and marks the base image read-only again.
  [switch]$Finish,
  # Boot the base image and report whether the static IP + Remote Desktop
  # actually took effect.
  [switch]$VerifyImage,
  [string]$Root
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is empty in some invocation paths (dot-sourcing, -Command), which
# would leave every derived path rooted at "". Fall back to the script's own file
# location, then to the working directory.
if (-not $Root) {
  if ($PSScriptRoot) { $Root = $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path } else { $Root = (Get-Location).Path }
}
function Say  ($m) { Write-Host $m }
function Ok   ($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]    $m" -ForegroundColor Yellow }
function Bad  ($m) { Write-Host "  [x]    $m" -ForegroundColor Red }
function Step ($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

$BaseDir  = Join-Path $Root 'vm\base'
$WorkDir  = Join-Path $Root 'vm\run'
$BaseVhdx = Join-Path $BaseDir 'tiny11.vhdx'
$NatName  = 'SimplexSandboxNAT'
$RuleTag  = 'Simplex sandbox'
$GuestIp        = '192.168.211.50'   # must match SX_VM_GUEST_IP in engine/sandbox-vm.js
$GuacdPort      = 4822
$GuacdContainer = 'simplex-guacd'
$GuacdImage     = 'guacamole/guacd:1.5.5'
# 22.04 LTS specifically: newer Ubuntu releases (24.04+, 26.04) do NOT package
# guacd at all, and they ship FreeRDP 3.30 which removed the ->input API that
# guacamole-server still uses, so building it from source there fails too.
# 22.04 has guacd 1.3.0 in its own repos - one apt-get and done.
$WslDistro      = 'Ubuntu-22.04'

# Is something answering on the guacd port? That is the only thing Simplex checks,
# so it is the only thing that really matters here.
function Test-Guacd {
  # $ErrorActionPreference is 'Stop' for the script, which turns the
  # AggregateException that ConnectAsync().Wait() throws on a refused connection
  # into a TERMINATING error -- it would abort the whole status report. Force it
  # back to Continue for the duration, and swallow everything.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  $ok = $false
  try {
    $c = New-Object Net.Sockets.TcpClient
    $ok = $c.ConnectAsync('127.0.0.1', $GuacdPort).Wait(1500)
    $c.Close()
  } catch { $ok = $false }
  $ErrorActionPreference = $old
  return [bool]$ok
}
# Launch guacd inside WSL and point 127.0.0.1:4822 at it. WSL2 gets its own IP on
# every boot, so the portproxy has to be (re)created each time - this is also what
# the scheduled task should call.
function Start-Guacd {
  # single-quoted so PowerShell does not try to interpret the shell redirects
  $runCmd = 'pkill guacd; nohup /usr/sbin/guacd -b 0.0.0.0 -l ' + $GuacdPort + ' -f >/tmp/guacd.log 2>&1 & sleep 1'
  wsl -d $WslDistro -u root -- bash -lc $runCmd | Out-Null
  $wslIp = ''
  try { $wslIp = ((wsl -d $WslDistro -- hostname -I 2>$null) | Out-String).Trim().Split(' ')[0] } catch {}
  if ($wslIp) {
    netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=$GuacdPort 2>&1 | Out-Null
    netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=$GuacdPort connectaddress=$wslIp connectport=$GuacdPort 2>&1 | Out-Null
    Ok "Forwarded 127.0.0.1:$GuacdPort -> WSL ($wslIp)"
  } else { Warn 'Could not read the WSL IP address.' }
  Start-Sleep -Seconds 2
  if (Test-Guacd) { Ok 'guacd is running' } else { Warn 'guacd started but is not answering - check: wsl -u root -- cat /tmp/guacd.log' }
}

# One-time preparation of the golden image. This is deliberately INSTRUCTIONS
# rather than automation: the disk has to be booted to change anything inside it,
# and doing that from a script would mean mounting it (needs elevation) or
# scripting the Hyper-V console, both of which are worse than a short checklist.
function Show-PrepImage {
  Step 'Preparing the base image'
  Say ''
  Say '  WHY: guests get no DHCP on the sandbox switch, so without a STATIC IP they'
  Say '  self-assign 169.254.x.x and can reach nothing - no Remote Desktop and no'
  Say '  internet. Baking it into the base image also means Simplex NEVER needs to'
  Say '  run as administrator.'
  Say ''

  if (-not (Test-Path -LiteralPath $BaseVhdx)) { Bad "No base image at $BaseVhdx"; return }
  $img = Get-Item -LiteralPath $BaseVhdx
  if ($img.IsReadOnly) {
    Warn 'The base image is read-only. Making it writable for this operation.'
    try { Set-ItemProperty -LiteralPath $BaseVhdx -Name IsReadOnly -Value $false } catch { Bad "Could not clear the read-only flag: $($_.Exception.Message)"; return }
  }

  # Any sandbox session holds a differencing disk against this image; the image
  # must not be booted while a child disk exists.
  $live = @(Get-VM -Name 'SimplexSandbox-*' -ErrorAction SilentlyContinue)
  if ($live.Count) {
    Bad "Stop the running sandbox session(s) first: $(($live | ForEach-Object Name) -join ', ')"
    return
  }

  $prep = 'SimplexPrepImage'
  Get-VM -Name $prep -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue
    Remove-VM -VM $_ -Force -ErrorAction SilentlyContinue
  }

  Step 'Booting the base image'
  try {
    New-VM -Name $prep -MemoryStartupBytes 2048MB -VHDPath $BaseVhdx -Generation 2 -SwitchName $SwitchName -ErrorAction Stop | Out-Null
    Set-VM -Name $prep -ProcessorCount 2 -CheckpointType Disabled -AutomaticStopAction ShutDown -ErrorAction SilentlyContinue
    Enable-VMIntegrationService -VMName $prep -Name 'Guest Service Interface' -ErrorAction SilentlyContinue
    Start-VM -Name $prep -ErrorAction Stop
    Ok "Started '$prep' on the base image"
  } catch { Bad "Could not boot the base image: $($_.Exception.Message)"; return }

  Say '  waiting for the guest to finish booting...'
  $deadline = (Get-Date).AddMinutes(4)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    $hb = (Get-VMIntegrationService -VMName $prep -Name Heartbeat -ErrorAction SilentlyContinue).PrimaryStatusDescription
    if ($hb -match 'OK') { $up = $true; break }
    Start-Sleep -Seconds 5
  }
  if ($up) { Ok 'Guest is up' } else { Warn 'Guest did not report a heartbeat; continuing anyway' }

  # The commands that actually need to run inside the guest.
  $inner = @(
    'Set-ItemProperty "HKLM:\System\CurrentControlSet\Control\Terminal Server" -Name fDenyTSConnections -Value 0'
    'Enable-NetFirewallRule -DisplayGroup "Remote Desktop"'
    '$i = (Get-NetAdapter | Where-Object Status -eq Up | Select-Object -First 1).ifIndex'
    'Remove-NetIPAddress -InterfaceIndex $i -Confirm:$false -EA SilentlyContinue'
    ('New-NetIPAddress -InterfaceIndex $i -IPAddress ' + $GuestIp + ' -PrefixLength 24 -DefaultGateway ' + $HostIp)
    'Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses 1.1.1.1,8.8.8.8'
  )

  $done = $false
  if ($GuestUser -and $GuestPass) {
    Step 'Configuring the guest over PowerShell Direct'
    try {
      $cred = New-Object PSCredential($GuestUser, (ConvertTo-SecureString $GuestPass -AsPlainText -Force))
      $sess = New-PSSession -VMName $prep -Credential $cred -ErrorAction Stop
      try {
        Invoke-Command -Session $sess -ScriptBlock ([ScriptBlock]::Create($inner -join "`n")) -ErrorAction Stop | Out-Null
        Ok 'Remote Desktop enabled and static IP set'
        $done = $true
      } finally { Remove-PSSession $sess -ErrorAction SilentlyContinue }
    } catch {
      Warn "PowerShell Direct failed: $($_.Exception.Message)"
      Warn 'That usually means the password is wrong, or 1234 is a Windows Hello PIN (PINs do not work here).'
    }
  } else {
    Warn 'No guest credentials supplied, so this cannot be done automatically.'
    Say  '  Re-run with the guest account and its REAL PASSWORD (not a Hello PIN):'
    Say  ("     .\setup-sandbox.ps1 -PrepImage -GuestUser 'User' -GuestPass 'thepassword'")
  }

  if (-not $done) {
    Step 'Finish it by hand (2 minutes)'
    Say ''
    Say ("  The VM '$prep' is RUNNING on your base image. Open it:")
    Say ("     vmconnect.exe localhost $prep")
    Say ''
    Say '  Sign in, open PowerShell AS ADMINISTRATOR inside the guest, and paste:'
    Say ''
    foreach ($l in $inner) { Say ("      " + $l) }
    Say ''
    Say '  Then come back here and run:'
    Say ("     .\setup-sandbox.ps1 -PrepImage -Finish")
    Say ''
    return
  }

  Complete-PrepImage $prep
}

# Shut the prep VM down cleanly, remove it, and re-protect the image.
function Complete-PrepImage {
  param([string]$Prep = 'SimplexPrepImage')
  Step 'Finishing up'
  if (Get-VM -Name $Prep -ErrorAction SilentlyContinue) {
    Say '  shutting the guest down cleanly...'
    Stop-VM -Name $Prep -Force -ErrorAction SilentlyContinue
    $d = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $d) { if ((Get-VM $Prep -ErrorAction SilentlyContinue).State -eq 'Off') { break }; Start-Sleep -Seconds 3 }
    if ((Get-VM $Prep -ErrorAction SilentlyContinue).State -ne 'Off') {
      Warn 'Guest did not shut down; forcing it off (the image may need a chkdsk on next boot)'
      Stop-VM -Name $Prep -TurnOff -Force -ErrorAction SilentlyContinue
    }
    Remove-VM -Name $Prep -Force -ErrorAction SilentlyContinue
    Ok 'Prep VM removed, base image kept'
  } else { Warn "No '$Prep' VM found - assuming it is already gone" }

  try { Set-ItemProperty -LiteralPath $BaseVhdx -Name IsReadOnly -Value $true; Ok 'Base image marked read-only again' }
  catch { Warn "Could not re-set read-only: $($_.Exception.Message)" }

  Say ''
  Ok 'Done. Start a sandbox session - it should come up with a real mouse.'
  Say '  (Simplex does NOT need to run as administrator for this to work.)'
}

# Boot the base image on its own and report what the guest ACTUALLY has. This
# answers "did my -PrepImage edits stick?" in about a minute, instead of finding
# out through a failed sandbox session.
function Test-BaseImage {
  Step 'Verifying the base image'
  if (-not (Test-Path -LiteralPath $BaseVhdx)) { Bad "No base image at $BaseVhdx"; return }

  $live = @(Get-VM -Name 'SimplexSandbox-*' -ErrorAction SilentlyContinue)
  if ($live.Count) { Bad "Stop the running sandbox session(s) first: $(($live | ForEach-Object Name) -join ', ')"; return }

  $name = 'SimplexVerify'
  Get-VM -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue
    Remove-VM -VM $_ -Force -ErrorAction SilentlyContinue
  }
  $wasReadOnly = (Get-Item -LiteralPath $BaseVhdx).IsReadOnly
  if ($wasReadOnly) { Set-ItemProperty -LiteralPath $BaseVhdx -Name IsReadOnly -Value $false }

  try {
    New-VM -Name $name -MemoryStartupBytes 2048MB -VHDPath $BaseVhdx -Generation 2 -SwitchName $SwitchName -ErrorAction Stop | Out-Null
    Set-VM -Name $name -ProcessorCount 2 -CheckpointType Disabled -AutomaticStopAction ShutDown -ErrorAction SilentlyContinue
    Start-VM -Name $name -ErrorAction Stop
    Say '  booting the base image...'
    $d = (Get-Date).AddMinutes(4)
    while ((Get-Date) -lt $d) {
      if (((Get-VMIntegrationService -VMName $name -Name Heartbeat -ErrorAction SilentlyContinue).PrimaryStatusDescription) -match 'OK') { break }
      Start-Sleep -Seconds 5
    }

    # give the network stack a moment past the heartbeat to settle
    $ip = ''
    $d2 = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $d2) {
      $ips = @((Get-VMNetworkAdapter -VMName $name).IPAddresses | Where-Object { $_ -notmatch ':' })
      if ($ips.Count) { $ip = $ips[0] }
      if ($ip -eq $GuestIp) { break }
      Start-Sleep -Seconds 5
    }

    if ($ip -eq $GuestIp) { Ok "Static IP is set correctly ($ip)" }
    elseif ($ip -like '169.254.*') { Bad "Guest has an APIPA address ($ip) - the static IP did NOT stick. Re-run -PrepImage and make sure New-NetIPAddress ran on the right adapter." }
    elseif ($ip) { Bad "Guest has $ip but Simplex expects $GuestIp" }
    else { Bad 'Guest reported no IPv4 address at all' }

    if ($ip -eq $GuestIp) {
      $rdp = Test-NetConnection $GuestIp -Port 3389 -InformationLevel Quiet -WarningAction SilentlyContinue
      if ($rdp) { Ok 'Remote Desktop is listening - sessions will have a mouse' }
      else { Bad 'Remote Desktop is NOT listening. fDenyTSConnections/firewall did not take.' }
    } else {
      Warn 'Skipping the Remote Desktop check - the host cannot reach the guest at that address.'
    }
  } catch {
    Bad "Verification failed: $($_.Exception.Message)"
  } finally {
    Say '  shutting the base image down...'
    Stop-VM -Name $name -Force -ErrorAction SilentlyContinue
    $d3 = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $d3) { if ((Get-VM $name -ErrorAction SilentlyContinue).State -eq 'Off') { break }; Start-Sleep -Seconds 3 }
    if ((Get-VM $name -ErrorAction SilentlyContinue).State -ne 'Off') { Stop-VM -Name $name -TurnOff -Force -ErrorAction SilentlyContinue }
    Remove-VM -Name $name -Force -ErrorAction SilentlyContinue
    if ($wasReadOnly) { Set-ItemProperty -LiteralPath $BaseVhdx -Name IsReadOnly -Value $true }
    Ok 'Base image left as it was found'
  }
}

function Get-GuacdRuntime {
  if ($Guacd -ne 'auto') { return $Guacd }
  if (Get-Command docker -ErrorAction SilentlyContinue) { return 'docker' }
  if (Get-Command wsl -ErrorAction SilentlyContinue) { return 'wsl' }
  return 'none'
}

function Test-Admin {
  (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
}

# ------------------------------------------------------------------ status ----
function Show-Status {
  Step 'Current status'
  $admin = Test-Admin
  if ($admin) { Ok 'Running as administrator' } else { Bad 'NOT running as administrator' }

  $cmdlets = [bool](Get-Command Get-VM -ErrorAction SilentlyContinue)
  if ($cmdlets) { Ok 'Hyper-V PowerShell module present' } else { Bad 'Hyper-V PowerShell module missing' }

  $hv = $false
  try { $hv = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent } catch {}
  if ($hv -and $cmdlets) { Ok 'Hyper-V is active' } elseif ($hv) { Warn 'A hypervisor is present but Hyper-V management is not installed' } else { Bad 'Hyper-V is not active' }

  if ($cmdlets) {
    if (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue) { Ok "Switch '$SwitchName' exists" } else { Bad "Switch '$SwitchName' missing" }
  }
  if (Get-NetNat -Name $NatName -ErrorAction SilentlyContinue) { Ok "NAT '$NatName' exists" } else { Bad "NAT '$NatName' missing" }

  $rules = @(Get-NetFirewallRule -DisplayName "$RuleTag*" -ErrorAction SilentlyContinue)
  if ($rules.Count -ge 1) { Ok "$($rules.Count) LAN-isolation firewall rule(s) present" } else { Bad 'LAN-isolation firewall rules missing' }

  if (Test-Path -LiteralPath $BaseVhdx) {
    $gb = [math]::Round((Get-Item -LiteralPath $BaseVhdx).Length / 1GB, 1)
    Ok "Base image present ($gb GB): $BaseVhdx"
  } else { Bad "Base image missing: $BaseVhdx" }

  if (Test-Guacd) { Ok "guacd is listening on 127.0.0.1:$GuacdPort - sessions get full mouse + keyboard" } else { Warn "guacd not reachable on port $GuacdPort - the sandbox will fall back to keyboard-only" }

  # The other half of "does RDP work": the base image must accept Remote Desktop
  # at a KNOWN address. Only testable while a session is up, so report it as a
  # hint rather than a hard pass/fail.
  $vmUp = @(Get-VM -Name 'SimplexSandbox-*' -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' })
  if ($vmUp.Count) {
    $r = Test-NetConnection -ComputerName $GuestIp -Port 3389 -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($r) { Ok "A sandbox guest is answering RDP on $GuestIp" }
    else { Warn "A sandbox guest is running but NOT answering RDP on ${GuestIp}: run this script with -PrepImage" }
  }

  # Whoever runs Simplex needs Hyper-V rights, or every VM start fails with a
  # permission error that looks nothing like a permission error in the UI.
  $me = "$env:USERDOMAIN\$env:USERNAME"
  $inGroup = $false
  try {
    $inGroup = [bool](Get-LocalGroupMember -Group 'Hyper-V Administrators' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $me })
  } catch {}
  # Group membership is stamped into a token at LOGON, so being IN the group is
  # not the same as this session HAVING it. Report the difference, or "I already
  # added myself and it still fails" is impossible to diagnose.
  $inToken = $false
  try {
    $tok = [Security.Principal.WindowsIdentity]::GetCurrent()
    foreach ($g in $tok.Groups) {
      try { if ($g.Translate([Security.Principal.NTAccount]).Value -match 'Hyper-V Administrators') { $inToken = $true } } catch {}
    }
  } catch {}
  if ($admin) { Ok "$me is elevated (Hyper-V access OK)" }
  elseif ($inToken) { Ok "$me is in Hyper-V Administrators" }
  elseif ($inGroup) { Warn "$me is in Hyper-V Administrators but THIS SESSION predates it - sign out and back in (or reboot), then restart Simplex" }
  else { Bad "$me can NOT control Hyper-V - run this script as administrator, then sign out and back in" }

  Step 'Host capacity'
  $cs = Get-CimInstance Win32_ComputerSystem
  $os = Get-CimInstance Win32_OperatingSystem
  $totalGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  $freeGB  = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
  Say "  RAM: $freeGB GB free of $totalGB GB   |   logical CPUs: $($cs.NumberOfLogicalProcessors)"
  if ($freeGB -lt 3) { Warn 'Under 3 GB free - a 2 GB guest will squeeze the host. Consider closing things or adding RAM.' }
  $drive = (Get-Item $Root).PSDrive
  if ($drive.Free) { Say "  Disk $($drive.Name): $([math]::Round($drive.Free/1GB,1)) GB free" }
}

# --------------------------------------------------------------- uninstall ----
function Invoke-Uninstall {
  Step 'Removing sandbox networking'
  Get-VM -Name 'SimplexSandbox-*' -ErrorAction SilentlyContinue | ForEach-Object {
    Warn "Removing leftover VM $($_.Name)"
    try { Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue } catch {}
    try { Remove-VM -VM $_ -Force -ErrorAction SilentlyContinue } catch {}
  }
  Get-NetFirewallRule -DisplayName "$RuleTag*" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue; Ok "Removed rule $($_.DisplayName)"
  }
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    $existing = docker ps -a --filter "name=$GuacdContainer" --format '{{.Names}}' 2>$null
    if ($existing) { docker rm -f $GuacdContainer 2>&1 | Out-Null; Ok 'Removed guacd container' }
  }
  netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=$GuacdPort 2>&1 | Out-Null
  if (Get-NetNat -Name $NatName -ErrorAction SilentlyContinue) { Remove-NetNat -Name $NatName -Confirm:$false; Ok 'Removed NAT' }
  if (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue) { Remove-VMSwitch -Name $SwitchName -Force; Ok 'Removed switch' }
  Say "`nDone. The base image and Hyper-V itself were left alone."
}

# ------------------------------------------------------------------- setup ----
function Invoke-Setup {
  if (-not (Test-Admin)) { Bad 'This must run in an ADMINISTRATOR PowerShell.'; return }

  Step 'Hyper-V'
  $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
  if (-not $feature) {
    Bad 'Hyper-V is not available on this edition of Windows (Home does not include it). Pro/Enterprise is required.'
    return
  }
  if ($feature.State -ne 'Enabled') {
    Warn 'Enabling Hyper-V - this REQUIRES A REBOOT before anything else will work.'
    Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null
    Warn 'Hyper-V enabled. REBOOT, then run this script again to finish networking.'
    return
  }
  Ok 'Hyper-V already enabled'

  Step 'Isolated network (internet yes, LAN no)'
  if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
    New-VMSwitch -Name $SwitchName -SwitchType Internal | Out-Null
    Ok "Created internal switch '$SwitchName'"
  } else { Ok "Switch '$SwitchName' already exists" }

  $ifIndex = (Get-NetAdapter | Where-Object { $_.Name -like "*$SwitchName*" } | Select-Object -First 1).ifIndex
  if (-not $ifIndex) { Bad 'Could not find the host adapter for the switch.'; return }

  if (-not (Get-NetIPAddress -IfIndex $ifIndex -IPAddress $HostIp -ErrorAction SilentlyContinue)) {
    New-NetIPAddress -IPAddress $HostIp -PrefixLength ($Subnet.Split('/')[1]) -InterfaceIndex $ifIndex | Out-Null
    Ok "Assigned $HostIp to the sandbox adapter"
  } else { Ok 'Host adapter already addressed' }

  if (-not (Get-NetNat -Name $NatName -ErrorAction SilentlyContinue)) {
    New-NetNat -Name $NatName -InternalIPInterfaceAddressPrefix $Subnet | Out-Null
    Ok "Created NAT for $Subnet (this is what gives guests internet)"
  } else { Ok 'NAT already exists' }

  # ---- the important part: the guest must not see the LAN or the host ----
  Step 'Blocking the guest from your local network'
  $private = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16')
  $existing = @(Get-NetFirewallRule -DisplayName "$RuleTag*" -ErrorAction SilentlyContinue)
  if ($existing.Count) { $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue }

  # Block sandbox -> every RFC1918 range (covers the Simplex host itself).
  New-NetFirewallRule -DisplayName "$RuleTag - block LAN" -Direction Outbound -Action Block `
    -RemoteAddress $private -LocalAddress $Subnet -Profile Any -Enabled True | Out-Null
  Ok 'Sandbox -> LAN blocked (private ranges)'

  # Block anything on the LAN from reaching into the sandbox subnet as well.
  New-NetFirewallRule -DisplayName "$RuleTag - block inbound" -Direction Inbound -Action Block `
    -RemoteAddress $Subnet -Profile Any -Enabled True | Out-Null
  Ok 'LAN -> sandbox blocked'

  # Allow the DHCP/DNS the guest needs from the host gateway only.
  New-NetFirewallRule -DisplayName "$RuleTag - allow gateway DNS" -Direction Inbound -Action Allow `
    -Protocol UDP -LocalPort 53,67 -RemoteAddress $Subnet -Profile Any -Enabled True | Out-Null
  Ok 'Gateway DNS/DHCP allowed'

  Step 'guacd (mouse + keyboard over RDP)'
  if ($Guacd -eq 'none') {
    Warn 'Skipped by request (-Guacd none). The sandbox will be keyboard-only.'
  } elseif (Test-Guacd) {
    Ok "Already listening on port $GuacdPort"
  } else {
    $runtime = Get-GuacdRuntime
    switch ($runtime) {
      'docker' {
        Say '  Using Docker.'
        try {
          docker rm -f $GuacdContainer 2>&1 | Out-Null
          docker run -d --name $GuacdContainer --restart unless-stopped -p "127.0.0.1:$($GuacdPort):4822" $GuacdImage 2>&1 | Out-Null
          Start-Sleep -Seconds 3
          if (Test-Guacd) { Ok "guacd running in Docker as '$GuacdContainer'" } else { Warn 'Container started but the port is not answering yet - check "docker logs simplex-guacd".' }
        } catch { Bad "Docker failed: $($_.Exception.Message)" }
      }
      'wsl' {
        Say '  Using WSL2.'
        # wsl --list --quiet pads its output with NULs (UTF-16 read as ANSI),
        # so strip them before deciding whether anything is actually installed.
        $distros = ''
        try { $distros = ((wsl --list --quiet 2>$null) -join "`n") -replace "`0", '' } catch {}
        # Another distro being present is not enough - guacd has to live in the
        # one we pinned above, so look for that specific name.
        if (-not ($distros -match [regex]::Escape($WslDistro))) {
          Warn "$WslDistro is not installed yet - that is why guacd never appears."
          Say  "  Installing $WslDistro now. This downloads a few hundred MB and can take a while..."
          try {
            # --no-launch avoids the interactive 'create a UNIX username' prompt,
            # which would hang this non-interactive script forever. We only ever
            # run commands as root, so no user account is needed.
            wsl --install -d $WslDistro --no-launch 2>&1 | Out-String | Write-Host
            Start-Sleep -Seconds 3
            try { $distros = ((wsl --list --quiet 2>$null) -join "`n") -replace "`0", '' } catch {}
          } catch { Bad "wsl --install failed: $($_.Exception.Message)" }

          if (-not ($distros -match '\S')) {
            Warn 'WSL could not install automatically. Most often this means either:'
            Say  '    * the Virtual Machine Platform feature is off, or'
            Say  '    * Windows needs a reboot to finish enabling WSL.'
            Say  '  Fix it with:'
            Say  '     dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart'
            Say  "     wsl --install -d $WslDistro --no-launch"
            Say  '  Reboot, then re-run this script.'
            break
          }
          Ok "$WslDistro installed"
        }

        try {
          Say '  Installing guacd inside WSL (this can take a few minutes)...'
          $aptCmd = 'DEBIAN_FRONTEND=noninteractive apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq guacd'
          wsl -d $WslDistro -u root -- bash -lc $aptCmd | Out-Null
          $haveCmd = 'command -v guacd; ls /usr/sbin/guacd'
          $have = (wsl -d $WslDistro -u root -- bash -lc $haveCmd | Out-String)
          if (-not ($have -match 'guacd')) {
            Bad 'guacd did not install. Check the distro has network access:'
            Say "     wsl -d $WslDistro -u root -- apt-get update"
            break
          }
          Start-Guacd
        } catch { Bad "WSL setup failed: $($_.Exception.Message)" }
      }
      default {
        Warn 'Neither Docker nor WSL is available on this machine.'
        Say  '  Install one of them, then re-run:'
        Say  '     Docker Desktop  ->  https://www.docker.com/products/docker-desktop/'
        Say  "     or WSL2        ->  wsl --install -d $WslDistro"
        Say  '  Without guacd the sandbox still works, but keyboard-only (no mouse).'
      }
    }
  }

  Step 'Permissions for the Simplex service account'
  # Simplex talks to Hyper-V through the PowerShell cmdlets, which refuse to run
  # for a non-elevated, non-Hyper-V-Administrators user. Adding the account that
  # RUNS Simplex to that group is what lets it create VMs without running the
  # whole server as administrator.
  $me = "$env:USERDOMAIN\$env:USERNAME"
  $inGroup = $false
  try {
    $inGroup = [bool](Get-LocalGroupMember -Group 'Hyper-V Administrators' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $me })
  } catch {}
  if ($inGroup) { Ok "$me is in Hyper-V Administrators" } else {
    try {
      Add-LocalGroupMember -Group 'Hyper-V Administrators' -Member $env:USERNAME -ErrorAction Stop
      Ok "Added $me to Hyper-V Administrators"
      Warn 'SIGN OUT AND BACK IN for this to take effect (group membership is read at logon).'
    } catch {
      Warn "Could not add $me to Hyper-V Administrators: $($_.Exception.Message)"
      Say  '  Add whichever account runs Simplex manually:'
      Say  '     Add-LocalGroupMember -Group "Hyper-V Administrators" -Member <username>'
      Say  '  ...then sign out and back in. Without this, starting a VM fails with'
      Say  '  "You do not have the required permission".'
    }
  }

  Step 'Folders'
  foreach ($d in @($BaseDir, $WorkDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null; Ok "Created $d" } else { Ok "$d exists" }
  }

  Step 'Base image'
  if (Test-Path -LiteralPath $BaseVhdx) {
    Ok "Base image already present: $BaseVhdx"
  } else {
    Warn "No base image yet. This is the one step that cannot be automated."
    Say ''
    Say '  Simplex needs a prepared Windows disk at:'
    Say ('      ' + $BaseVhdx)
    Say ''
    Say '  How to make one:'
    Say '    1. Get a Tiny11 image (a debloated Windows 11 build), or build one'
    Say '       yourself with the tiny11builder scripts from your own Windows 11'
    Say '       ISO. Using your own ISO keeps the licensing clean.'
    Say '    2. In Hyper-V Manager, make a TEMPORARY Generation 2 VM whose disk is'
    Say '       the path above, and install Tiny11 into it.'
    Say '    3. Inside the guest, once installed:'
    Say '         - turn OFF Windows Update and any auto-restart'
    Say '         - leave Defender ON (it costs little and catches the obvious)'
    Say '         - shut the guest down CLEANLY'
    Say '    4. DELETE the temporary VM but KEEP the VHDX. Simplex only reads it,'
    Say '       layering a throwaway differencing disk on top for each session.'
    Say '    5. Mark it read-only so nothing can modify the golden image:'
    Say ('         attrib +R "' + $BaseVhdx + '"')
    Say ''
    Say '  Sizing: keep the base disk lean (a 20-30 GB dynamic VHDX is plenty).'
    Say '  Each session disk starts near zero and grows only with what is written.'
  }

  Show-Status
  Step 'Next'
  Say '  Restart Simplex, then grant an account the "Can use the EXE sandbox"'
  Say '  permission in Settings -> Manage accounts.'
  if (-not (Test-Guacd)) {
    Say ''
    Warn '  guacd is not running, so sessions will be KEYBOARD-ONLY until it is.'
  }
  Say ''
  Say '  Keeping guacd running across reboots:'
  Say '    Docker: the container already uses --restart unless-stopped, so it'
  Say '            comes back with Docker Desktop.'
  Say '    WSL:    WSL gets a NEW IP on every boot, so guacd must be restarted and'
  Say '            the port forward refreshed. Register a startup task once:'
  Say ''
  Say '              schtasks /create /tn "Simplex guacd" /sc onstart /ru SYSTEM /rl HIGHEST /f /tr "..."'
  Say ('            where "..." is:  powershell -NoProfile -ExecutionPolicy Bypass -File ' + (Join-Path $Root 'setup-sandbox.ps1') + ' -StartGuacd')
  Say ''
  Say '            Or just re-run this script with -StartGuacd after a reboot.'
}

# -------------------------------------------------------------------- main ----
Say '================================================'
Say ' Simplex EXE sandbox - host setup'
Say '================================================'
if ($Uninstall) { Invoke-Uninstall }
elseif ($VerifyImage) { Test-BaseImage }
elseif ($PrepImage -and $Finish) { Complete-PrepImage }
elseif ($PrepImage) { Show-PrepImage }
elseif ($StartGuacd) { Step 'Starting guacd'; Start-Guacd }
elseif ($Check) { Show-Status }
else { Invoke-Setup }
