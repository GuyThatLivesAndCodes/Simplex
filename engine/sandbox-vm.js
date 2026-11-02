/* ============================================================
   SANDBOX VM — run an untrusted .exe inside a throwaway Hyper-V guest
   ============================================================
   A user opens an executable from their vault; instead of it ever touching the
   Simplex host, we boot a disposable Windows guest, copy the file in, and stream
   the guest's screen to the browser. When the session ends the guest is destroyed
   and its disk deleted, so nothing survives to the next session.

   WHY IT IS BUILT THIS WAY
   -----------------------
   * ONE session at a time. The pooled "keep a spare warm" idea costs a permanent
     ~2 GB + 2 vCPUs; on a box that is also serving vaults, running local AI and
     training the trading model, that is a bad trade. We build the VM on demand
     (~30-60 s from a golden checkpoint) and tear it down after. MAX_SESSIONS is a
     tunable, so a beefier host can raise it.
   * DIFFERENCING DISKS. The base Tiny11 VHDX is read-only; each session gets a
     child disk that receives every write. Discarding the child is what makes the
     reset total — the base is never modified, so no session can contaminate the
     next one.
   * NETWORK: INTERNET YES, LAN NO. The guest sits on its own internal switch
     behind NAT, and a host firewall rule blocks it from every RFC1918 range, so
     an installer can reach the internet but malware cannot see the vault server
     or anything else on the LAN. See setup-sandbox.ps1.
   * NOTHING RUNS UNSUPERVISED. A session has a hard lifetime and an idle timeout;
     both destroy the VM. Boot also sweeps VMs orphaned by a hard kill of the
     parent (same defensive pattern as the local AI engine's sweepOrphans).

   This module shells out to PowerShell's Hyper-V module rather than taking a
   native dependency, which keeps Simplex's zero-extra-dependency posture. Every
   call is funnelled through ps() so failures surface as ordinary Errors.
   ============================================================ */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const guacd = require('./guacd');   // Apache Guacamole daemon client (full mouse + keyboard over RDP)

const ENGINE_DIR = __dirname;
const ROOT = path.join(ENGINE_DIR, '..');

/* ---------- tunables (env-overridable; the defaults suit a 16 GB host) ---------- */
function intEnv(name, dflt) { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : dflt; }
function strEnv(name, dflt) { const v = process.env[name]; return v && String(v).trim() ? String(v).trim() : dflt; }

const VM_PREFIX      = 'SimplexSandbox-';                              // every VM we own is named with this
const SWITCH_NAME    = strEnv('SX_VM_SWITCH', 'SimplexSandboxNAT');    // created by setup-sandbox.ps1
const BASE_VHDX      = strEnv('SX_VM_BASE_VHDX', path.join(ROOT, 'vm', 'base', 'tiny11.vhdx'));
const WORK_DIR       = strEnv('SX_VM_WORK', path.join(ROOT, 'vm', 'run'));
const MEMORY_MB      = intEnv('SX_VM_MEMORY_MB', 2048);
const CPUS           = intEnv('SX_VM_CPUS', 2);
const MAX_SESSIONS   = intEnv('SX_VM_MAX_SESSIONS', 1);                // raise on a bigger host
const BOOT_TIMEOUT_MS= intEnv('SX_VM_BOOT_TIMEOUT_MS', 180 * 1000);
const IDLE_MS        = intEnv('SX_VM_IDLE_MS', 5 * 60 * 1000);         // no input for this long -> destroy
const MAX_LIFE_MS    = intEnv('SX_VM_MAX_LIFE_MS', 60 * 60 * 1000);    // hard ceiling per session
const PS_TIMEOUT_MS  = intEnv('SX_VM_PS_TIMEOUT_MS', 120 * 1000);

/* ---------- RDP / guacd ----------
   With guacd reachable we connect to the guest over RDP, which gives real mouse,
   keyboard and clipboard. The guest gets a fixed address on the sandbox subnet
   and a throwaway local account whose password is generated per session and never
   leaves this process. Without guacd we fall back to the frame-polling path, so
   losing the daemon degrades the feature instead of breaking it. */
const GUEST_IP       = strEnv('SX_VM_GUEST_IP', '192.168.211.50');
const RDP_PORT       = intEnv('SX_VM_RDP_PORT', 3389);
/* Where files land inside the guest. Used by both the initial payload delivery
   and "Add files from Database". */
const GUEST_DROP_DIR = 'C:\\Users\\Public\\Desktop';
const RDP_READY_MS   = intEnv('SX_VM_RDP_READY_MS', 60 * 1000);
/* Shorter budget when we did not provision the guest ourselves: a pre-baked
   image answers soon after boot, or it was never set up for RDP. */
const RDP_QUICK_MS   = intEnv('SX_VM_RDP_QUICK_MS', 45 * 1000);
/* Credentials of the account INSIDE the base image, used only for PowerShell
   Direct provisioning (see provisionViaPsDirect). Must be the account's real
   PASSWORD - a Hello PIN is not accepted. Unset by default: without it we fall
   back to the offline-mount route or a pre-baked image. */
/* Default to the base image's own account (below): the image is prepared once
   (Remote Desktop + fixed address baked in) and this account has a real password,
   so PowerShell Direct works out of the box - it is also how imported apps are
   launched inside the guest (runFile). */
const GUEST_USER     = strEnv('SX_VM_GUEST_USER', strEnv('SX_VM_RDP_USER', 'TestUser'));
const GUEST_PASS     = strEnv('SX_VM_GUEST_PASS', strEnv('SX_VM_RDP_PASS', '1234'));
/* Remembered across sessions: once an unprovisioned image has failed to answer
   RDP, every later session would waste the same wait discovering the same thing.
   Cleared whenever the base image changes (see baseImageStamp) so preparing the
   image takes effect without a restart. */
let _rdpDeadImage = null;   // the base-image stamp known NOT to serve RDP
/* The account INSIDE the base image. Whoever builds the golden Tiny11 disk
   chooses these; Simplex just signs in as them over RDP. Defaults match the
   image this was developed against (account 'TestUser', password 1234 - an actual
   password, so it also works over RDP and PowerShell Direct) and both are
   overridable so a differently-built image needs no code change.
   These are credentials for a THROWAWAY guest that is destroyed after every
   session and cannot reach the LAN - they are not a secret worth protecting,
   but they still never leave the server (see openTunnel). */
const RDP_USER       = strEnv('SX_VM_RDP_USER', 'TestUser');
const RDP_PASS       = strEnv('SX_VM_RDP_PASS', '1234');

/* ============================================================
   POWERSHELL PLUMBING
   ============================================================ */
/* Run a PowerShell snippet and resolve its stdout. Hyper-V has no usable Node
   binding, so this is the interface to everything. -NonInteractive matters: a
   cmdlet that decides to prompt would otherwise hang the request forever. */
function ps(script, { timeout = PS_TIMEOUT_MS, json = false } = {}) {
  return new Promise((resolve, reject) => {
    const body = json ? `${script} | ConvertTo-Json -Depth 5 -Compress` : script;
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body],
      { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('PowerShell timed out')); }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.on('close', code => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error((err.trim() || `PowerShell exited ${code}`).slice(0, 400)));
      resolve(out.trim());
    });
  });
}
async function psJson(script, opts) {
  const raw = await ps(script, { ...opts, json: true });
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
/* Terminate a child and everything it spawned. proc.kill() alone is unreliable on
   Windows (the child can outlive the parent), which would orphan a PowerShell
   holding WMI handles open. Same approach as the local AI engine. */
function killTree(proc) {
  if (!proc || proc.killed || proc.pid == null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(proc.pid), '/F', '/T'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  } else {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
}

/* A PowerShell single-quoted literal: the only escape inside '' is a doubled ''. */
function q(s) { return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"; }

/* ============================================================
   HOST CAPABILITY PROBE
   ============================================================
   The app must be able to say exactly WHY the sandbox is unavailable rather than
   failing at click time, so this reports each prerequisite separately. Cached
   briefly because the admin Settings panel polls it. */
let _capCache = null, _capAt = 0;
const CAP_TTL_MS = 15_000;
/* Host/guest resource figures. Spawning PowerShell is the expensive part, so a
   short cache keeps a polling admin panel from pinning a core. */
let _resCache = null, _resAt = 0;
const RES_TTL_MS = 4_000;

async function capabilities(force) {
  if (!force && _capCache && (Date.now() - _capAt) < CAP_TTL_MS) return _capCache;
  const cap = {
    platform: process.platform,
    supported: process.platform === 'win32',
    hyperV: false, cmdlets: false, elevated: false,
    switch: false, baseImage: false, baseImagePath: BASE_VHDX,
    ready: false, reason: null,
    memoryMB: MEMORY_MB, cpus: CPUS, maxSessions: MAX_SESSIONS,
    // display mode: 'rdp' (guacd reachable -> full mouse) or 'frames' (fallback)
    guacd: false, guacdHost: guacd.DEFAULT_HOST, guacdPort: guacd.DEFAULT_PORT, mode: 'frames',
  };
  if (!cap.supported) { cap.reason = 'The sandbox needs Hyper-V, so it only runs on a Windows host.'; _capCache = cap; _capAt = Date.now(); return cap; }
  try {
    const probe = await psJson(`
      $o = [ordered]@{}
      $o.cmdlets  = [bool](Get-Command Get-VM -ErrorAction SilentlyContinue)
      $o.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      $o.hyperV   = $false
      try { $o.hyperV = ((Get-CimInstance Win32_ComputerSystem).HypervisorPresent -and $o.cmdlets) } catch {}
      $o.switch   = $false
      if ($o.cmdlets) { try { $o.switch = [bool](Get-VMSwitch -Name ${q(SWITCH_NAME)} -ErrorAction SilentlyContinue) } catch {} }
      $o.baseImage = Test-Path -LiteralPath ${q(BASE_VHDX)}
      # Group membership is stamped into a token at LOGON. If the account was
      # added to Hyper-V Administrators after this session started, the group is
      # in the group list but NOT in our token - the cmdlets still refuse, which
      # is otherwise a baffling "I already did that" state.
      $o.inHvGroup = $false
      $o.hvGroupPending = $false
      try {
        $o.inHvGroup = [bool](Get-LocalGroupMember -Group 'Hyper-V Administrators' -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -eq "$env:USERDOMAIN\\$env:USERNAME" })
        $tok = [Security.Principal.WindowsIdentity]::GetCurrent()
        $inToken = $false
        foreach ($g in $tok.Groups) {
          try { if ($g.Translate([Security.Principal.NTAccount]).Value -match 'Hyper-V Administrators') { $inToken = $true } } catch {}
        }
        $o.hvGroupPending = ($o.inHvGroup -and -not $inToken)
      } catch {}
      [pscustomobject]$o`, { timeout: 20000 });
    if (probe) {
      cap.cmdlets = !!probe.cmdlets; cap.elevated = !!probe.elevated;
      cap.hyperV = !!probe.hyperV; cap.switch = !!probe.switch; cap.baseImage = !!probe.baseImage;
      cap.inHvGroup = !!probe.inHvGroup; cap.hvGroupPending = !!probe.hvGroupPending;
    }
  } catch (e) { cap.reason = 'Could not query the host: ' + (e.message || 'unknown error'); }

  if (!cap.reason) {
    if (!cap.cmdlets) cap.reason = 'The Hyper-V PowerShell module is not installed. Run setup-sandbox.ps1 as administrator.';
    else if (!cap.hyperV) cap.reason = 'Hyper-V is not enabled on this host. Run setup-sandbox.ps1 as administrator, then reboot.';
    else if (cap.hvGroupPending) cap.reason = 'This account was added to "Hyper-V Administrators" but the change has not taken effect yet. Sign out of Windows and back in (or reboot), then restart Simplex.';
    else if (!cap.elevated && !cap.inHvGroup) cap.reason = 'Simplex is not running with administrator rights, and its account is not in "Hyper-V Administrators" - run setup-sandbox.ps1 as administrator, then sign out and back in.';
    else if (!cap.switch) cap.reason = `The isolated network switch "${SWITCH_NAME}" does not exist yet. Run setup-sandbox.ps1.`;
    else if (!cap.baseImage) cap.reason = `No base image at ${BASE_VHDX}. Build a Tiny11 VHDX and put it there (see setup-sandbox.ps1).`;
    else cap.ready = true;
  }
  // guacd is independent of Hyper-V: probe it either way so the UI can report
  // "VMs fine but no mouse" as its own distinct state.
  // ensure() also STARTS guacd (in WSL) if it isn't running - see guacd.js
  try { const g = await guacd.ensure(); cap.guacd = !!g; cap.guacdHost = g ? g.host : null; } catch (e) { cap.guacd = false; }
  cap.mode = cap.guacd ? 'rdp' : 'frames';
  _capCache = cap; _capAt = Date.now();
  return cap;
}
function invalidateCaps() { _capCache = null; }

/* ============================================================
   SESSION STATE
   ============================================================ */
// Map<sessionId, session>
const sessions = new Map();
let _seq = 0;

function newId() { return 'vm' + Date.now().toString(36) + (_seq++).toString(36); }
function vmNameFor(id) { return VM_PREFIX + id; }

function publicSession(s) {
  return {
    id: s.id, state: s.state, vmName: s.vmName,
    fileName: s.fileName, fileId: s.fileId,
    startedAt: s.startedAt, lastInputAt: s.lastInputAt,
    expiresAt: s.startedAt + MAX_LIFE_MS,
    error: s.error || null, note: s.note || null,
    owner: s.accountId,
    // 'rdp' = full mouse/keyboard through guacd; 'frames' = keyboard-only fallback.
    // The RDP credentials are deliberately NOT included: the browser never sees
    // them, it just asks our tunnel to connect on its behalf.
    mode: s.mode, rdpReady: !!s.rdpReady,
    files: (s.files || []).slice(),
    deliveryWarning: s.deliveryWarning || null,
    modeNote: s.modeNote || null,
  };
}
function listSessions() { return [...sessions.values()].map(publicSession); }
/* INTERNAL accessors -- these hand back the live object, which carries timer
   handles (circular, so JSON.stringify throws) and the guest's RDP password.
   Never serialise one of these; use the *Public variants for anything that
   leaves the process. */
function sessionFor(accountId) { return [...sessions.values()].find(s => s.accountId === accountId) || null; }
function getSession(id) { return sessions.get(id) || null; }

/* SAFE accessors for API responses. */
function sessionForPublic(accountId) { const s = sessionFor(accountId); return s ? publicSession(s) : null; }
function getSessionPublic(id) { const s = getSession(id); return s ? publicSession(s) : null; }

/* ============================================================
   LIFECYCLE
   ============================================================ */
function ensureDirs() {
  try { fs.mkdirSync(WORK_DIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(path.dirname(BASE_VHDX), { recursive: true }); } catch (e) {}
}

/* Boot-time sweep. A hard kill of server.js can't run our exit handler, which
   would leave a VM running (and its differencing disk on disk) forever. We only
   ever touch VMs whose name carries our prefix, so an unrelated guest on the same
   host is never disturbed. Mirrors llama-engine's sweepOrphans.
   It runs in the background (it used to be a synchronous PowerShell call that froze
   the whole server for a second or two at every start); a machine started meanwhile
   waits for it, so the sweep can never remove a brand-new guest. */
let bootSweep = Promise.resolve();
function init() {
  ensureDirs();
  if (process.platform !== 'win32') return;
  bootSweep = (async () => {
    try {
      await ps(`
        if (Get-Command Get-VM -ErrorAction SilentlyContinue) {
          Get-VM -Name '${VM_PREFIX}*' -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue } catch {}
            try { Remove-VM -VM $_ -Force -ErrorAction SilentlyContinue } catch {}
          }
        }`, { timeout: 60000 });
    } catch (e) {}
    // any disks left behind by those VMs
    try {
      for (const f of await fsp.readdir(WORK_DIR)) {
        try { await fsp.rm(path.join(WORK_DIR, f), { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {}
  })();
}

/* Create + boot a disposable guest and hand back the session.
   `exePath` is a PLAINTEXT copy of the user's file that the caller has already
   materialised outside the vault; we copy it into the guest's disk and delete the
   host copy as soon as it is in. */
async function startSession({ accountId, fileId, fileName, exePath, scratchDir }) {
  await bootSweep;   // leftovers from a previous run are gone before anything new starts
  const cap = await capabilities();
  if (!cap.ready) { const e = new Error(cap.reason || 'The sandbox is not available.'); e.code = 'VM_UNAVAILABLE'; throw e; }
  if (sessionFor(accountId)) { const e = new Error('You already have a sandbox session running.'); e.code = 'VM_BUSY'; throw e; }
  if (sessions.size >= MAX_SESSIONS) {
    const e = new Error('The sandbox is in use by someone else. Only one session can run at a time on this server.');
    e.code = 'VM_BUSY'; throw e;
  }

  const id = newId();
  const vmName = vmNameFor(id);
  const diskPath = path.join(WORK_DIR, id + '.vhdx');
  const s = {
    id, accountId, vmName, diskPath, fileId, fileName,
    state: 'creating', startedAt: Date.now(), lastInputAt: Date.now(),
    error: null, note: null, destroying: false,
    // Per-session RDP credentials. Generated here, injected into the guest, and
    // never persisted or sent to the browser — the client only ever talks to our
    // tunnel, which supplies them to guacd server-side.
    mode: cap.mode, rdpUser: RDP_USER, rdpPass: RDP_PASS,
    guestIp: GUEST_IP, rdpReady: false,
    exePath,                 // consumed by buildSession
    scratchDir,              // the caller's temp dir; WE delete it, not the route
    files: fileName ? [fileName] : [],   // everything delivered into the guest so far
    pending: [],             // queued additions waiting for the next delivery
  };
  sessions.set(id, s);

  // Kick the real work off in the BACKGROUND and return immediately. Building a
  // VM takes minutes (disk, inject, boot Windows, wait for RDP) and the client's
  // fetch wrapper gives up after 20s, so a synchronous build could never succeed.
  // The client polls /api/vm/status and watches `state` + `note` instead.
  buildSession(s).catch(() => {});
  return publicSession(s);
}

/* Can this process mount a VHD on the host? Needs SeManageVolumePrivilege, which
   is only in an ELEVATED token -- Hyper-V Administrators membership is NOT enough.
   Cached, because it cannot change without a new process. */
let _canMount = null;
async function canMountVhd() {
  if (_canMount != null) return _canMount;
  try {
    const out = await ps(`if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'yes' } else { 'no' }`,
      { timeout: 15000 });
    _canMount = /yes/i.test(out);
  } catch (e) { _canMount = false; }
  if (!_canMount) console.log('[simplex] sandbox: not elevated, so files are copied into the guest after boot (Copy-VMFile) instead of by mounting its disk');
  return _canMount;
}

/* Push one host file onto the guest's desktop over the Guest Service Interface.
   Host -> guest only; the guest cannot pull anything back. Shared by the initial
   payload delivery and by "Add files from Database". */
async function copyIntoGuest(s, srcPath, fileName) {
  const safeName = String(fileName || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  await ps(`Copy-VMFile -Name ${q(s.vmName)} -SourcePath ${q(srcPath)} `
    + `-DestinationPath ${q(GUEST_DROP_DIR + '\\' + safeName)} -FileSource Host -CreateFullPath -Force | Out-Null`,
    { timeout: 300000 });
  return safeName;
}

/* Delete the caller's scratch copy of the executable. Safe to call repeatedly;
   a decrypted binary must never outlive the moment it is injected. */
function releaseScratch(s) {
  if (s.scratchDir) { try { fs.rmSync(s.scratchDir, { recursive: true, force: true }); } catch (e) {} }
  else if (s.exePath) { try { fs.rmSync(path.dirname(s.exePath), { recursive: true, force: true }); } catch (e) {} }
  s.scratchDir = null;
  s.exePath = null;
}

/* The long-running half of starting a session. Never throws to the caller: any
   failure is recorded on the session (state 'error' + a message) so the polling
   client can show it, and the half-built VM is torn down. */
async function buildSession(s) {
  const { vmName, diskPath, exePath, fileName } = s;
  try {
    /* A read-only base image is normally fine (and desirable), but Hyper-V
       reports a permissions error rather than a read-only error if it cannot
       open it, which sends people hunting the wrong problem. Check first so the
       session can say something true. */
    try {
      const st = fs.statSync(BASE_VHDX);
      if (!st.size) throw new Error('the base image is empty');
    } catch (e) {
      throw new Error('The base image is missing or unreadable at ' + BASE_VHDX);
    }

    // 1. differencing disk on top of the read-only golden image
    s.note = 'Preparing a clean disk...';
    await ps(`New-VHD -Path ${q(diskPath)} -ParentPath ${q(BASE_VHDX)} -Differencing | Out-Null`);

    // 2. the VM itself. Generation 2 = UEFI, which Tiny11 wants.
    s.note = 'Creating the virtual machine…';
    await ps([
      `New-VM -Name ${q(vmName)} -MemoryStartupBytes ${MEMORY_MB}MB -VHDPath ${q(diskPath)} -Generation 2 -SwitchName ${q(SWITCH_NAME)} | Out-Null`,
      `Set-VM -Name ${q(vmName)} -ProcessorCount ${CPUS} -CheckpointType Disabled -AutomaticStopAction TurnOff | Out-Null`,
      /* Guest Service Interface is what lets the HOST push a file into a running
         guest (Copy-VMFile), which is how "add more files" works mid-session.
         It is deliberately one-way and host-initiated: the guest cannot use it to
         read host files, enumerate shares, or start a transfer of its own. No
         drive/clipboard redirection is enabled anywhere else. */
      `Enable-VMIntegrationService -VMName ${q(vmName)} -Name 'Guest Service Interface' -ErrorAction SilentlyContinue`,
    ].join('; '));

    /* 3. Get the executable into the guest.

       Two routes, and we prefer the one that needs no special host privilege:

       OFFLINE (Mount-VHD, before boot) is neat -- no guest agent, file waiting on
       the desktop at first login -- but mounting a VHD on the host requires
       SeManageVolumePrivilege, which a token only carries when ELEVATED. Being in
       Hyper-V Administrators is enough to CREATE a VM but not to mount its disk,
       so this path fails with 0x80070522 "A required privilege is not held by the
       client" for anyone not running Simplex as administrator.

       ONLINE (Copy-VMFile, after boot) goes through the Guest Service Interface,
       needs no host privilege at all, and is the same mechanism "Add files from
       Database" already uses. It costs a wait for the guest to finish booting.

       So: try offline only when we can actually mount, else fall back to online.
       Either way the plaintext copy is deleted the moment it is inside. */
    let injectedOffline = false;
    if (await canMountVhd()) {
      try {
        s.note = 'Copying the program in...';
        await injectPayload(s, diskPath, exePath, fileName);
        injectedOffline = true;
        releaseScratch(s);
      } catch (e) {
        console.warn('[simplex] sandbox: offline inject failed, will copy after boot -', (e.message || '').split('\n')[0]);
      }
    }
    /* RDP needs the guest to (a) accept Remote Desktop and (b) be reachable at a
       known address. There are two ways that happens:

         PRE-BAKED  - the base image already has Remote Desktop enabled and a
                      static IP. Nothing to do per session, and crucially NO HOST
                      ELEVATION is required. This is the recommended setup.
         PROVISIONED- we wrote a first-boot script into the offline disk, which
                      needs Mount-VHD and therefore an elevated Simplex.

       So we do NOT give up on RDP just because we could not mount the disk: the
       image may well be pre-baked. waitForRdp() below is the real test, and it
       is cheap (a TCP connect). Only if that fails do we fall back to frames. */
    if (!injectedOffline && s.mode === 'rdp') {
      s.provisioned = false;
      console.log('[simplex] sandbox: no offline provisioning - relying on the base image having RDP enabled');
    }

    // 4. boot
    s.note = 'Starting Windows...';
    s.state = 'booting';
    await ps(`Start-VM -Name ${q(s.vmName)} | Out-Null`);
    await waitForHeartbeat(s);

    // In RDP mode the guest still has to finish first-boot provisioning (create
    // the account, enable Remote Desktop, take its address) before the tunnel can
    // connect. If that never happens we DON'T fail the session — we drop to the
    // frame-polling mode so the user still gets a usable, if mouseless, screen.
    /* If we could not provision offline, try PowerShell Direct now that the
       guest is up. Costs nothing when the credentials are not configured. */
    /* A prepared image already serves RDP a few seconds after boot - check that
       first and skip the ~12s of provisioning it would not need. */
    if (s.mode === 'rdp' && s.provisioned === false) {
      s.note = 'Waiting for Remote Desktop...';
      if (await waitForRdp(s, 20000)) s.provisioned = true;
      else {
        s.note = 'Setting up Remote Desktop...';
        if (await provisionViaPsDirect(s)) s.provisioned = true;
      }
    }

    if (s.mode === 'rdp') {
      s.note = 'Waiting for Remote Desktop...';
      // A pre-baked image is either listening shortly after boot or it is not
      // set up for RDP at all; no point burning the full budget on it.
      /* Don't make the user pay the same wait twice. Once THIS image has failed
         to serve RDP, later sessions skip straight to frames. The memo is keyed
         on the image's identity (path+size+mtime), so preparing or rebuilding
         the image clears it automatically. Applies to BOTH paths: a provisioning
         script that does not take effect is just as permanent a failure as an
         unprepared image, until something about the image changes. */
      const stamp = baseImageStamp();
      if (_rdpDeadImage && _rdpDeadImage === stamp) {
        s.rdpReady = false;
        console.log('[simplex] sandbox: this base image has already failed to serve RDP - skipping the wait');
      } else {
        s.rdpReady = await waitForRdp(s, s.provisioned === false ? RDP_QUICK_MS : RDP_READY_MS);
        if (!s.rdpReady) _rdpDeadImage = stamp; else _rdpDeadImage = null;
      }
      if (!s.rdpReady) {
        s.mode = 'frames';
        s.note = null;
        s.modeNote = s.provisioned === false
          ? 'The base image does not have Remote Desktop enabled at ' + s.guestIp
            + ', so this session is keyboard-only. See setup-sandbox.ps1 -PrepImage for how to enable it once.'
          : 'The guest did not start Remote Desktop at ' + s.guestIp + '. The most reliable fix is to '
            + 'enable it in the base image once - run setup-sandbox.ps1 -PrepImage. Using the keyboard-only view for now.';
        console.warn('[simplex] sandbox: RDP never came up -', s.modeNote);
      }
    }

    // If we could not write the file into the offline disk, deliver it now that
    // the guest is up and its file-copy service is answering.
    if (!injectedOffline && exePath) {
      s.note = 'Copying the program in...';
      try {
        await copyIntoGuest(s, exePath, fileName);
      } catch (e) {
        // Not fatal: the machine is usable, the user just has to fetch the file
        // themselves. Say so rather than throwing the whole session away.
        s.deliveryWarning = 'The program could not be copied in automatically: ' + (e.message || 'unknown error');
        console.warn('[simplex] sandbox: online inject failed -', s.deliveryWarning);
      }
      releaseScratch(s);
    }

    s.state = 'running';
    s.note = null;
    // The idle clock only starts once the machine is actually usable, so a slow
    // boot can never be mistaken for an abandoned session.
    s.lastInputAt = Date.now();
    armTimers(s);
  } catch (e) {
    s.state = 'error';
    let msg = e.message || 'Could not start the sandbox.';
    if (/permission to open attachment|Access is denied/i.test(msg)) {
      msg = 'Hyper-V could not open the base image. This usually means the disk is '
          + 'read-only AND its per-VM permissions were lost - clear the read-only flag on '
          + BASE_VHDX + ' and try again. (Original: ' + msg.split('\n')[0] + ')';
    }
    s.error = msg;
    s.note = null;
    releaseScratch(s);       // never leave a decrypted executable on disk
    console.warn('[simplex] sandbox: build failed -', s.error);
    // leave the session record in place briefly so the client can read the error,
    // then clean the VM up
    setTimeout(() => { destroySession(s.id, { silent: true }); }, 30_000);
    try {
      await ps([
        `Stop-VM -Name ${q(s.vmName)} -TurnOff -Force -ErrorAction SilentlyContinue`,
        `Remove-VM -Name ${q(s.vmName)} -Force -ErrorAction SilentlyContinue`,
      ].join('; '), { timeout: 60000 });
    } catch (e2) {}
    try { fs.rmSync(s.diskPath, { force: true }); } catch (e2) {}
  }
}

/* Mount the differencing disk on the HOST just long enough to drop the payload in,
   then dismount. Mounting an untrusted-content disk is safe here because the disk
   was created from OUR base image and has not been booted yet.

   Two things go in:
     * the user's executable, onto the Public Desktop, and
     * (RDP mode only) a first-boot script that turns on Remote Desktop and fixes
       the guest's IP. Provisioning from inside the guest avoids baking
       per-session secrets into the golden image.

   HOW THE SCRIPT IS TRIGGERED - this matters, and the obvious choice is WRONG.
   The Startup FOLDER only runs after a USER LOGS IN. The guest sits on a lock
   screen, and nothing can log in until RDP works... which is what the script
   enables. That deadlock means the script never runs and RDP never appears.

   HKLM RunOnce is NOT the answer either: despite the name it is also processed
   during LOGON (by userinit/runonce.exe), not at boot, so it has the same
   deadlock.

   What genuinely runs with no user present is **SetupComplete.cmd**: if
   %WINDIR%\Setup\Scripts\SetupComplete.cmd exists, Windows executes it as SYSTEM
   during the first boot's setup pass, before the logon screen is usable. That is
   exactly the window we need, and it is a documented Microsoft mechanism rather
   than a trick. We drop both the .cmd and the PowerShell it launches. */
async function injectPayload(s, diskPath, srcPath, fileName) {
  const safeName = String(fileName || 'program.exe').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const wantRdp = s.mode === 'rdp';
  const provision = wantRdp ? guestProvisionScript(s) : null;
  await ps(`
    $ErrorActionPreference = 'Stop'
    $img = Mount-VHD -Path ${q(diskPath)} -PassThru
    try {
      $letters = ($img | Get-Disk | Get-Partition | Where-Object DriveLetter).DriveLetter
      $root = $null
      foreach ($l in $letters) { if (Test-Path "$($l):\\Windows\\System32") { $root = "$($l):"; break } }
      if (-not $root) { throw 'Could not find a Windows partition in the base image.' }
      $desk = "$root\\Users\\Public\\Desktop"
      if (-not (Test-Path $desk)) { New-Item -ItemType Directory -Path $desk -Force | Out-Null }
      ${srcPath ? `Copy-Item -LiteralPath ${q(srcPath)} -Destination (Join-Path $desk ${q(safeName)}) -Force` : ''}
      ${provision ? `
      # the script itself lives on the guest's system drive
      $spDir = "$root\\Windows\\Setup\\Scripts"
      if (-not (Test-Path $spDir)) { New-Item -ItemType Directory -Path $spDir -Force | Out-Null }
      Set-Content -LiteralPath (Join-Path $spDir 'simplex-provision.ps1') -Value ${q(provision)} -Encoding UTF8

      # SetupComplete.cmd runs as SYSTEM during boot with NO user logged in.
      Set-Content -LiteralPath (Join-Path $spDir 'SetupComplete.cmd') -Encoding ASCII -Value @(
        '@echo off',
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0simplex-provision.ps1" >"%~dp0simplex-provision.log" 2>&1'
      )
      ` : ''}
    } finally {
      Dismount-VHD -Path ${q(diskPath)} -ErrorAction SilentlyContinue
    }`, { timeout: 180000 });
}

/* The script that runs INSIDE the guest on first boot. It only ever loosens
   settings within the disposable VM — never on the host — and the account it
   creates dies with the disk. */
/* NOTE: the returned script is written to the guest's disk and run by
   PowerShell 5.1 there. Keep it PURE ASCII - a UTF-8 dash or smart quote can be
   mis-decoded and break parsing partway through, which is invisible from here
   (the guest just never provisions). assertAscii below enforces it. */
function guestProvisionScript(s) {
  const pass = String(s.rdpPass).replace(/'/g, "''");
  const user = String(s.rdpUser).replace(/'/g, "''");
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '# The base image already has this account; we only make sure it can sign in',
    '# over RDP. If it somehow does not exist, create it so a session is still',
    '# possible rather than failing outright.',
    `$p = ConvertTo-SecureString '${pass}' -AsPlainText -Force`,
    `if (-not (Get-LocalUser -Name '${user}' -ErrorAction SilentlyContinue)) {`,
    `  New-LocalUser -Name '${user}' -Password $p -AccountNeverExpires -PasswordNeverExpires | Out-Null`,
    '}',
    '# Remote Desktop Users is all that signing in over RDP needs; we deliberately',
    '# do not grant local administrator inside the guest.',
    `Add-LocalGroupMember -Group 'Remote Desktop Users' -Member '${user}' -ErrorAction SilentlyContinue`,
    '# turn on Remote Desktop, and allow it through the guest firewall',
    'Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0',
    '# NLA stays ON - guacd authenticates with the credentials below, so there is',
    '# no reason to weaken the guest listener.',
    'Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" -Name UserAuthentication -Value 1',
    'Enable-NetFirewallRule -DisplayGroup "Remote Desktop"',
    '# fixed address so the tunnel knows where to find it',
    '$if = Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | Select-Object -First 1',
    'if ($if) {',
    `  Remove-NetIPAddress -InterfaceIndex $if.ifIndex -Confirm:$false -ErrorAction SilentlyContinue`,
    `  New-NetIPAddress -InterfaceIndex $if.ifIndex -IPAddress '${s.guestIp}' -PrefixLength 24 -DefaultGateway '${gatewayFor(s.guestIp)}' -ErrorAction SilentlyContinue | Out-Null`,
    `  Set-DnsClientServerAddress -InterfaceIndex $if.ifIndex -ServerAddresses '1.1.1.1','8.8.8.8' -ErrorAction SilentlyContinue`,
    '}',
    '# No auto-login is configured: the RDP sign-in below lands the user straight',
    '# on a desktop, and storing DefaultPassword would leave this session\'s',
    '# credential sitting in cleartext in the guest registry for the program to read.',
    '# the script carries this session\'s password, so remove it once it has run',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
  ].join("\r\n");
  return assertAscii(script);
}
/* Fail loudly at generation time rather than shipping a script the guest cannot
   parse. */
function assertAscii(text) {
  const bad = String(text).match(/[^\x00-\x7F]/g);
  if (bad) throw new Error('guest provisioning script contains non-ASCII: ' + [...new Set(bad)].join(' '));
  return text;
}
/* x.y.z.1 is the host side of the sandbox subnet (see setup-sandbox.ps1). */
function gatewayFor(ip) { return String(ip).split('.').slice(0, 3).concat('1').join('.'); }

/* Wait until the guest reports a heartbeat (integration services up), which is a
   far better "it is actually usable" signal than Start-VM returning. */
async function waitForHeartbeat(s) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (s.destroying) throw new Error('Session cancelled.');
    let state = null;
    try {
      state = await ps(`(Get-VMIntegrationService -VMName ${q(s.vmName)} -Name Heartbeat -ErrorAction SilentlyContinue).PrimaryStatusDescription`, { timeout: 15000 });
    } catch (e) { /* transient while the VM comes up */ }
    if (state && /ok/i.test(state)) return;
    await sleep(3000);
  }
  throw new Error('The virtual machine did not finish booting in time.');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Idle + hard-lifetime kill switches. Neither is optional: an abandoned session
   would otherwise hold ~2 GB and a running untrusted program indefinitely. */
function armTimers(s) {
  clearTimers(s);
  s.idleTimer = setInterval(() => {
    if (Date.now() - s.lastInputAt > IDLE_MS) destroySession(s.id, { reason: 'idle' });
  }, 30_000);
  s.lifeTimer = setTimeout(() => destroySession(s.id, { reason: 'expired' }), MAX_LIFE_MS);
}
function clearTimers(s) {
  if (s.idleTimer) { clearInterval(s.idleTimer); s.idleTimer = null; }
  if (s.lifeTimer) { clearTimeout(s.lifeTimer); s.lifeTimer = null; }
}
function touch(id) { const s = sessions.get(id); if (s) s.lastInputAt = Date.now(); }

/* Destroy the guest and delete its disk. This is THE security guarantee of the
   whole feature, so it is written to succeed even when parts of it fail: every
   step is independently guarded and the disk is removed regardless. */
async function destroySession(id, { reason, silent } = {}) {
  const s = sessions.get(id);
  if (!s || s.destroying) return;
  s.destroying = true;
  s.state = 'stopping';
  clearTimers(s);
  stopFrameWorker(s);
  releaseScratch(s);
  if (s.tunnel) { try { s.tunnel.close(); } catch (e) {} s.tunnel = null; }
  closeRelay(s);
  for (const fn of (s.onClose || [])) { try { fn(reason || 'closed'); } catch (e) {} }
  try {
    await ps([
      `Stop-VM -Name ${q(s.vmName)} -TurnOff -Force -ErrorAction SilentlyContinue`,
      `Remove-VM -Name ${q(s.vmName)} -Force -ErrorAction SilentlyContinue`,
    ].join('; '), { timeout: 90000 });
  } catch (e) { if (!silent) console.warn('[simplex] sandbox: could not remove VM', s.vmName, e.message); }
  // the differencing disk carries everything the untrusted program wrote
  for (let attempt = 0; attempt < 3; attempt++) {
    try { fs.rmSync(s.diskPath, { force: true }); break; }
    catch (e) { await sleep(1500); }
  }
  sessions.delete(id);
}
async function destroyAll() {
  await Promise.all([...sessions.keys()].map(id => destroySession(id, { silent: true })));
}

/* ============================================================
   ADDING FILES TO A RUNNING SESSION
   ============================================================
   A session is not "one exe and done": once the guest is up the user can send
   more files in from their vault (test data, a config, a second installer).
   Copy-VMFile pushes over the guest service — host to guest only.
   ============================================================ */

async function addFile(id, srcPath, fileName) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('No such session.'); e.code = 'VM_GONE'; throw e; }
  if (s.state !== 'running') { const e = new Error('The machine is still starting up.'); e.code = 'VM_NOT_READY'; throw e; }
  let safeName;
  try {
    safeName = await copyIntoGuest(s, srcPath, fileName);
  } catch (e) {
    // The usual cause is the guest service not being ready yet (or missing from a
    // stripped image), so say something the user can act on.
    const msg = /not.*(running|enabled)|Integration/i.test(e.message || '')
      ? 'The virtual machine is not accepting files yet - give it a moment after it finishes booting.'
      : (e.message || 'Could not copy the file in.');
    const err = new Error(msg); err.code = 'VM_COPY'; throw err;
  }
  s.files.push(safeName);
  s.lastInputAt = Date.now();
  return safeName;
}

/* Run a command inside the guest over PowerShell Direct (the VM bus: no guest
   network, no host elevation). Needs the guest account's real password. */
async function psDirect(s, inner, timeout = 90000) {
  return ps(`
    $ErrorActionPreference = 'Stop'
    $pw = ConvertTo-SecureString ${q(GUEST_PASS)} -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential(${q(GUEST_USER)}, $pw)
    $sess = New-PSSession -VMName ${q(s.vmName)} -Credential $cred
    try { Invoke-Command -Session $sess -ScriptBlock ([ScriptBlock]::Create(${q(inner)})) }
    finally { Remove-PSSession $sess -ErrorAction SilentlyContinue }`, { timeout });
}

/* Open a file that is already inside the guest, as the signed-in user, so its window
   shows up on the remote desktop. PowerShell Direct itself runs in a background
   session where windows are invisible, so it registers a one-shot scheduled task
   with an INTERACTIVE principal - that runs in the user's desktop session - starts
   it, and removes it. Installers get msiexec, scripts PowerShell, and everything
   else opens the way a double-click would (explorer picks the handler). */
async function runFile(id, name) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('No such session.'); e.code = 'VM_GONE'; throw e; }
  if (s.state !== 'running') { const e = new Error('The machine is still starting up.'); e.code = 'VM_NOT_READY'; throw e; }
  const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  if (!safe || !(s.files || []).includes(safe)) { const e = new Error('That file is not in this machine.'); e.code = 'VM_NO_FILE'; throw e; }
  const full = GUEST_DROP_DIR + '\\' + safe;
  const ext = (safe.split('.').pop() || '').toLowerCase();
  const [exe, args] = ext === 'msi' ? ['msiexec.exe', `/i "${full}"`]
    : ext === 'ps1' ? ['powershell.exe', `-NoExit -ExecutionPolicy Bypass -File "${full}"`]
    : ['explorer.exe', `"${full}"`];
  const inner = [
    `if (-not (Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like '*\\${GUEST_USER.replace(/'/g, "''")}' })) { throw 'NOT_SIGNED_IN' }`,
    `$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '${args.replace(/'/g, "''")}'`,
    `$p = New-ScheduledTaskPrincipal -UserId '${GUEST_USER.replace(/'/g, "''")}' -LogonType Interactive -RunLevel Highest`,
    `Register-ScheduledTask -TaskName 'SimplexRun' -Action $a -Principal $p -Force | Out-Null`,
    `Start-ScheduledTask -TaskName 'SimplexRun'`,
    `Start-Sleep -Seconds 2`,
    `Unregister-ScheduledTask -TaskName 'SimplexRun' -Confirm:$false`,
  ].join('\n');
  try { await psDirect(s, inner, 60000); }
  catch (e) {
    const err = new Error(/NOT_SIGNED_IN/.test(e.message || '')
      ? 'Open the desktop first - apps start in the signed-in session.'
      : 'Could not start it: ' + String(e.message || 'unknown error').split('\n')[0].slice(0, 160));
    err.code = 'VM_RUN'; throw err;
  }
  s.lastInputAt = Date.now();
  return safe;
}

/* Ask the guest's desktop to repaint everything. Windows sends an RDP client only
   the regions that change, and when a viewer RE-connects to a running session
   (page reload, Refresh view, resize) it is not sent a fresh full picture - the
   view comes back black with only whatever moved since. Invalidating every window
   in the signed-in session makes Windows redraw, and those redraws reach the new
   viewer. Runs as an interactive task (it has to be in the user's session);
   conhost --headless keeps the PowerShell window from flashing up. Best effort. */
const REPAINT_PS1 = [
  `Add-Type -Namespace Sx -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool RedrawWindow(System.IntPtr h, System.IntPtr r, System.IntPtr g, uint f);'`,
  // RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_FRAME, on the whole desktop
  `[Sx.U]::RedrawWindow([IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 0x485) | Out-Null`,
].join('\n');
async function repaintGuest(s) {
  if (s.repainting || s.state !== 'running' || s.destroying) return;
  s.repainting = true;
  const u = GUEST_USER.replace(/'/g, "''");
  const inner = [
    `$f = 'C:\\Windows\\Temp\\sx-repaint.ps1'`,
    `Set-Content -Path $f -Value ${q(REPAINT_PS1)}`,
    `if (-not (Get-ScheduledTask -TaskName 'SimplexRepaint' -ErrorAction SilentlyContinue)) {`,
    `  $a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $f)`,
    `  $p = New-ScheduledTaskPrincipal -UserId '${u}' -LogonType Interactive`,
    `  Register-ScheduledTask -TaskName 'SimplexRepaint' -Action $a -Principal $p -Force | Out-Null`,
    `}`,
    `Start-ScheduledTask -TaskName 'SimplexRepaint'`,
  ].join('\n');
  try { await psDirect(s, inner, 45000); }
  catch (e) { console.warn('[simplex] sandbox: repaint failed -', String(e.message || e).split('\n')[0].slice(0, 160)); }
  finally { s.repainting = false; }
}

/* Identity of the current base image: path + size + mtime. Preparing the image
   changes its mtime, which invalidates the "this image has no RDP" memo. */
function baseImageStamp() {
  try { const st = fs.statSync(BASE_VHDX); return BASE_VHDX + ':' + st.size + ':' + st.mtimeMs; }
  catch (e) { return BASE_VHDX + ':missing'; }
}

/* ============================================================
   PROVISIONING ROUTE 3: PowerShell Direct
   ============================================================
   Runs commands INSIDE the guest over the VM bus - no host mount privilege, no
   guest network, no pre-baked image. It needs the guest account's real PASSWORD
   (a Windows Hello PIN will not work), which is why it is opt-in via
   SX_VM_GUEST_USER / SX_VM_GUEST_PASS.

   This is the only route that can turn RDP on for an UNPREPARED image while
   Simplex runs unelevated, so we try it before giving up on RDP.
   ============================================================ */
async function provisionViaPsDirect(s) {
  if (!GUEST_USER || !GUEST_PASS) return false;
  const script = guestProvisionScript(s);
  try {
    await ps(`
      $ErrorActionPreference = 'Stop'
      $pw = ConvertTo-SecureString ${q(GUEST_PASS)} -AsPlainText -Force
      $cred = New-Object System.Management.Automation.PSCredential(${q(GUEST_USER)}, $pw)
      $sess = New-PSSession -VMName ${q(s.vmName)} -Credential $cred
      try {
        Invoke-Command -Session $sess -ScriptBlock ([ScriptBlock]::Create(${q(script)})) | Out-Null
      } finally { Remove-PSSession $sess -ErrorAction SilentlyContinue }`,
      { timeout: 120000 });
    console.log('[simplex] sandbox: provisioned the guest over PowerShell Direct');
    return true;
  } catch (e) {
    const msg = (e.message || '').replace(/\s+/g, ' ').slice(0, 160);
    console.warn('[simplex] sandbox: PowerShell Direct provisioning failed -', msg);
    return false;
  }
}

/* Poll the guest's RDP port until it answers (or we give up). Uses a plain TCP
   connect rather than a guacd handshake so a slow-booting guest doesn't burn
   guacd sessions. */
function waitForRdp(s, budgetMs) {
  const net = require('net');
  const deadline = Date.now() + (budgetMs || RDP_READY_MS);
  const tryOnce = () => new Promise(resolve => {
    const sock = net.connect({ host: s.guestIp, port: RDP_PORT });
    const done = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.setTimeout(2500, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
  return (async () => {
    while (Date.now() < deadline) {
      if (s.destroying) return false;
      if (await tryOnce()) return true;
      await sleep(3000);
    }
    return false;
  })();
}

/* ============================================================
   RDP TUNNEL (guacd <-> browser)
   ============================================================
   Connects guacd to the guest and relays the Guacamole protocol to a WebSocket.
   The browser runs guacamole-common-js, which renders the drawing instructions
   and sends mouse/keyboard back — so this is a genuine remote desktop, not a
   screenshot loop.

   The RDP password never reaches the client: it is generated per session, lives
   only in this process, and is handed to guacd here.
   ============================================================ */
/* guacd in WSL cannot reach the guest: Windows does not route between WSL's
   virtual network and the sandbox switch (and turning on routing would be a host
   setting change). So each session gets a tiny TCP relay listening on the HOST's
   address on the WSL network, which only WSL can reach, accepting only guacd's
   address, and piping to the guest's RDP port. It dies with the session. */
function ensureRelay(s, g) {
  if (s.relay) return Promise.resolve(s.relay.port);
  const net = require('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer(c => {
      const from = String(c.remoteAddress || '').replace(/^::ffff:/, '');
      if (from !== g.host) { c.destroy(); return; }              // only guacd
      const up = net.connect({ host: s.guestIp, port: RDP_PORT });
      up.setNoDelay(true); c.setNoDelay(true);
      c.pipe(up).pipe(c);
      const end = () => { try { c.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
      up.on('error', end); c.on('error', end); up.on('close', end); c.on('close', end);
    });
    srv.on('error', reject);
    srv.listen(0, g.hostSide, () => { s.relay = { server: srv, port: srv.address().port }; resolve(s.relay.port); });
  });
}
function closeRelay(s) { if (s.relay) { try { s.relay.server.close(); } catch (e) {} s.relay = null; } }

async function openTunnel(id, ws, { width = 1280, height = 800, dpi = 96 } = {}) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('No such session.'); e.code = 'VM_GONE'; throw e; }
  if (s.mode !== 'rdp') { const e = new Error('This session is not using Remote Desktop.'); e.code = 'VM_NO_RDP'; throw e; }
  const g = await guacd.ensure();
  if (!g) { const e = new Error('The remote desktop service (guacd) is not running.'); e.code = 'VM_NO_RDP'; throw e; }
  // guacd in WSL reaches the guest through the session's relay; elsewhere, directly
  const via = g.wsl && g.hostSide ? { hostname: g.hostSide, port: await ensureRelay(s, g) } : { hostname: s.guestIp, port: RDP_PORT };
  if (s.tunnel) { try { s.tunnel.close(); } catch (e) {} }   // one viewer at a time: a reconnect replaces the old one

  const conn = await guacd.open({
    host: g.host, port: g.port,
    protocol: 'rdp',
    width, height, dpi,
    params: {
      hostname: via.hostname, port: String(via.port),
      username: s.rdpUser, password: s.rdpPass,
      security: 'any', 'ignore-cert': 'true',
      /* No live resizing ('resize-method'). With guacd 1.3 (FreeRDP 2) a
         display-update on a Windows 11 guest leaves everything drawn AFTER it
         blank - new windows, menus, text - although input still works. The viewer
         connects at the right size and reconnects when the size really changes.
         (Earlier notes here blamed some display params for "crashing the
         browser's parser" and the caches for blank drawing; both were really the
         relay splitting instructions across WebSocket messages, fixed below.
         They stay unset until tried again.) */
      // no drive/printer/audio redirection: nothing may bridge guest -> host
      'disable-audio': 'true', 'enable-drive': 'false', 'enable-printing': 'false',
      'disable-copy': 'false', 'disable-paste': 'false',
      // guacd 1.6+ speaks the RDP graphics pipeline; SX_VM_RDP_GFX=0 turns it off
      ...(process.env.SX_VM_RDP_GFX === '0' ? { 'disable-gfx': 'true' } : {}),
    },
  });

  let closed = false;
  const shut = (why) => {
    if (closed) return; closed = true;
    console.log(`[simplex] sandbox: viewer for ${s.id} closed (${why || 'unknown'})`);
    try { conn.socket.destroy(); } catch (e) {}
    try { ws.close(); } catch (e) {}
    if (s.tunnel === handle) s.tunnel = null;   // a newer viewer may have replaced us
  };
  const handle = { close: () => shut('replaced by a new viewer, or the machine ended') };
  s.tunnel = handle;
  // a viewer taking over a running desktop only gets what changes from now on
  s.viewers = (s.viewers || 0) + 1;
  if (s.viewers > 1) setTimeout(() => { if (!closed) repaintGuest(s); }, 2500);

  /* guacd -> browser, in WHOLE instructions. guacamole-common-js parses each
     WebSocket message on its own and keeps nothing between messages, so a TCP chunk
     that ends mid-instruction (routine for big image data) used to drop that
     instruction and garble the next. That was the "screen stops updating / black
     patches / Start menu half drawn" bug: lost draws, and lost syncs, after which
     guacd thinks the browser has fallen behind and holds frames back. */
  const toBrowser = insts => {
    if (closed || !insts.length) return;
    // lengths are re-counted for the browser only where they differ (rare)
    try { ws.send(insts.map(i => (i.astral ? guacd.encode16(...i) : i.raw)).join('')); }
    catch (e) { shut('send to browser failed'); }
  };
  toBrowser(conn.pending || []);
  toBrowser(conn.parser.push(''));
  conn.socket.on('data', (chunk) => {
    if (closed) return;
    toBrowser(conn.parser.push(conn.decoder.write(chunk)));
  });
  conn.socket.on('close', () => shut('guacd closed the connection'));
  conn.socket.on('error', e => shut('guacd socket error: ' + (e && e.code || e)));

  // browser -> guacd. Every message counts as activity so the idle timer only
  // fires on a genuinely abandoned session.
  /* Browser -> guacd, one INSTRUCTION at a time (a WebSocket message may carry
     several). Tunnel-internal instructions (empty opcode) are for the TUNNEL, not
     guacd: guacamole-common-js pings every 500ms and gives up ("server timeout")
     if nothing comes back for 15s - which is what happens on a still desktop,
     where guacd has nothing to send - and guacd 1.3 chokes on an empty opcode
     ("Error filling instruction buffer"). Guacamole's own server answers the
     ping itself; so do we, and only real instructions reach guacd. */
  const fromBrowser = new guacd.Parser();
  ws.on('message', (data) => {
    if (closed) return;
    const out = [];
    for (const inst of fromBrowser.push(typeof data === 'string' ? data : data.toString('utf8'))) {
      if (inst[0] === '') { if (inst[1] === 'ping') { try { ws.send(guacd.encode(...inst)); } catch (e) {} } continue; }
      // only real input keeps a session alive - not the frame acknowledgements
      // (sync) sent constantly, or an open, ignored tab would never go idle
      if (/^(mouse|key|size|clipboard|blob|file|touch)$/.test(inst[0])) s.lastInputAt = Date.now();
      out.push(inst.astral ? guacd.encode(...inst) : inst.raw);
    }
    if (out.length) { try { conn.socket.write(out.join('')); } catch (e) { shut('write to guacd failed'); } }
  });
  ws.on('close', code => shut('browser closed the tunnel, code ' + code));
  ws.on('error', e => shut('browser socket error: ' + (e && e.message || e)));

  return { connectionId: conn.connectionId, close: () => shut('closed by the server') };
}

/* ============================================================
   SCREEN + INPUT
   ============================================================
   Hyper-V exposes the guest's framebuffer over WMI (the same path the Hyper-V
   console uses). This is the FALLBACK view, used when guacd is unavailable --
   it has no mouse and is not smooth. guacd/RDP is the good path.

   Getting a frame used to spawn a whole PowerShell per capture: ~600ms of
   process startup before any work, then the WMI call and the JPEG encode, for
   ~2.9s a frame (under 1 FPS). Instead we keep ONE PowerShell alive per session
   and talk to it over stdin/stdout: it holds the WMI objects and the loaded
   System.Drawing assembly between frames, so a capture costs only the query and
   the encode. The worker is torn down with the session.
   ============================================================ */

/* The script the per-session worker runs. It reads a line from stdin for each
   frame request and writes back one line of base64 JPEG (or ERR:<message>), so
   the protocol stays trivially parseable. */
function frameWorkerScript(vmName) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    // resolve the VM + management service ONCE
    `$vmName = ${q(vmName)}`,
    "$vm  = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter \"ElementName='$vmName'\"",
    "$svc = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_VirtualSystemManagementService",
    "$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    "$ps  = New-Object System.Drawing.Imaging.EncoderParameters(1)",
    "$ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 60)",
    "Write-Output 'READY'",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($null -eq $line) { break }",
    "  try {",
    // the resolution can change while the guest runs, so re-read the video head
    "    $vid = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_VideoHead -ErrorAction SilentlyContinue | Select-Object -First 1",
    "    $w = 1024; $h = 768",
    "    if ($vid -and $vid.CurrentHorizontalResolution) { $w = [int]$vid.CurrentHorizontalResolution; $h = [int]$vid.CurrentVerticalResolution }",
    "    $res = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $vm; WidthPixels = [uint16]$w; HeightPixels = [uint16]$h }",
    "    if (-not $res.ImageData -or $res.ImageData.Length -lt 4) { throw 'no frame' }",
    "    $bytes = $res.ImageData",
    // the returned buffer can be a few bytes longer than the image needs, and
    // LockBits rows are stride-aligned -- copy row by row, sized from the buffer
    "    $rows = [int]([math]::Floor($bytes.Length / (2 * $w)))",
    "    if ($rows -lt 1) { throw 'frame too small' }",
    "    if ($rows -lt $h) { $h = $rows }",
    "    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)",
    "    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)",
    "    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)",
    "    try {",
    "      $srcStride = 2 * $w",
    "      for ($y = 0; $y -lt $h; $y++) {",
    "        $dst = [IntPtr]::Add($data.Scan0, $y * $data.Stride)",
    "        [System.Runtime.InteropServices.Marshal]::Copy($bytes, $y * $srcStride, $dst, $srcStride)",
    "      }",
    "    } finally { $bmp.UnlockBits($data) }",
    "    $ms = New-Object System.IO.MemoryStream",
    "    $bmp.Save($ms, $enc, $ps)",
    "    $bmp.Dispose()",
    "    Write-Output ([Convert]::ToBase64String($ms.ToArray()))",
    "    $ms.Dispose()",
    "  } catch {",
    "    Write-Output ('ERR:' + $_.Exception.Message.Replace(\"`n\", ' ').Replace(\"`r\", ' '))",
    "  }",
    "}",
  ].join('\n');
}

/* Start (or reuse) the frame worker for a session. */
function frameWorker(s) {
  if (s.frameProc && !s.frameProc.killed) return s.frameProc;

  /* The script goes in a FILE and we launch with -File.
     Not `-Command -`: that makes PowerShell read the whole of stdin AS THE
     SCRIPT, so the per-frame request lines would be swallowed as more script
     text and the worker would sit there forever. -File leaves stdin free for
     the request protocol. */
  const scriptPath = path.join(WORK_DIR, s.id + '-frames.ps1');
  try { fs.writeFileSync(scriptPath, frameWorkerScript(s.vmName), 'utf8'); }
  catch (e) { throw new Error('Could not write the frame worker script: ' + e.message); }
  s.frameScript = scriptPath;

  const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { windowsHide: true });
  proc.stdin.setDefaultEncoding('utf8');
  proc.__buf = '';
  proc.__queue = [];        // pending frame requests, FIFO
  proc.__ready = false;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    proc.__buf += chunk;
    let nl;
    while ((nl = proc.__buf.indexOf('\n')) >= 0) {
      const line = proc.__buf.slice(0, nl).trim();
      proc.__buf = proc.__buf.slice(nl + 1);
      if (!line) continue;
      if (!proc.__ready) { if (line === 'READY') proc.__ready = true; continue; }
      const waiter = proc.__queue.shift();
      if (!waiter) continue;
      if (line.startsWith('ERR:')) waiter.reject(new Error(line.slice(4)));
      else waiter.resolve(Buffer.from(line, 'base64'));
    }
  });
  const fail = () => {
    while (proc.__queue.length) proc.__queue.shift().reject(new Error('The frame worker stopped.'));
    if (s.frameProc === proc) s.frameProc = null;
  };
  proc.on('error', fail);
  proc.on('exit', fail);
  s.frameProc = proc;
  return proc;
}
function stopFrameWorker(s) {
  if (s.frameProc) { try { s.frameProc.stdin.end(); } catch (e) {} killTree(s.frameProc); s.frameProc = null; }
  if (s.frameScript) { try { fs.rmSync(s.frameScript, { force: true }); } catch (e) {} s.frameScript = null; }
}
async function screenshot(id, { width = 1024, height = 768 } = {}) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('No such session.'); e.code = 'VM_GONE'; throw e; }
  const proc = frameWorker(s);
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      const i = proc.__queue.indexOf(waiter);
      if (i >= 0) proc.__queue.splice(i, 1);
      reject(new Error('The virtual machine did not return a frame in time.'));
    }, 15000);
    const waiter = {
      resolve: (buf) => { clearTimeout(to); resolve(buf); },
      reject: (err) => { clearTimeout(to); reject(err); },
    };
    proc.__queue.push(waiter);
    try { proc.stdin.write('f\n'); } catch (e) { waiter.reject(new Error('The frame worker is not accepting requests.')); }
  });
}

/* The original one-shot capture, kept for reference/debugging. Spawns a whole
   PowerShell per frame, so it is far too slow for live viewing. */
async function screenshotOneShot(id, { width = 1024, height = 768 } = {}) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('No such session.'); e.code = 'VM_GONE'; throw e; }
  /* Hyper-V hands back a raw RGB565 buffer. Two things make a naive copy crash
     with AccessViolationException:
       1. the guest may return a DIFFERENT resolution than we asked for, so the
          buffer size must drive the bitmap size, not the other way round; and
       2. LockBits rows are STRIDE-aligned, so the source has to be copied one
          row at a time rather than as a single flat blob.
     Getting either wrong writes past the end of the locked region. */
  const b64 = await ps(`
    $ErrorActionPreference = 'Stop'
    $vm  = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$(${q(s.vmName)})'"
    $svc = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_VirtualSystemManagementService
    $vid = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_VideoHead -ErrorAction SilentlyContinue | Select-Object -First 1
    $w = ${width}; $h = ${height}
    if ($vid -and $vid.CurrentHorizontalResolution) { $w = [int]$vid.CurrentHorizontalResolution; $h = [int]$vid.CurrentVerticalResolution }
    $res = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{
      TargetSystem = $vm; WidthPixels = [uint16]$w; HeightPixels = [uint16]$h }
    if (-not $res.ImageData -or $res.ImageData.Length -lt 4) { throw 'no frame' }

    # Trust the RETURNED buffer: 2 bytes per pixel at the width we asked for.
    $bytes = $res.ImageData
    $rows  = [int]([math]::Floor($bytes.Length / (2 * $w)))
    if ($rows -lt 1) { throw 'frame too small' }
    if ($rows -lt $h) { $h = $rows }

    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
    try {
      $srcStride = 2 * $w
      for ($y = 0; $y -lt $h; $y++) {
        $dst = [IntPtr]::Add($data.Scan0, $y * $data.Stride)
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, $y * $srcStride, $dst, $srcStride)
      }
    } finally { $bmp.UnlockBits($data) }
    $ms = New-Object System.IO.MemoryStream
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $p = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 70)
    $bmp.Save($ms, $enc, $p)
    $bmp.Dispose()
    [Convert]::ToBase64String($ms.ToArray())`, { timeout: 20000 });
  if (!b64) throw new Error('The virtual machine did not return a frame.');
  return Buffer.from(b64, 'base64');
}

/* Keyboard input. Hyper-V's Msvm_Keyboard takes virtual key codes; we send a
   press/release pair per key. Mouse input is NOT available over this interface,
   which is a real limitation of the dependency-free approach — see typeText. */
async function sendKeys(id, keys) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('No such session.'); e.code = 'VM_GONE'; throw e; }
  const codes = (Array.isArray(keys) ? keys : [keys]).map(n => parseInt(n, 10)).filter(Number.isFinite).slice(0, 32);
  if (!codes.length) return;
  touch(id);
  await ps(`
    $ErrorActionPreference = 'Stop'
    $vm = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$(${q(s.vmName)})'"
    $kb = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_Keyboard | Select-Object -First 1
    ${codes.map(c => `Invoke-CimMethod -InputObject $kb -MethodName PressKey -Arguments @{ keyCode = [uint32]${c} } | Out-Null`).join("\n    ")}
    ${codes.slice().reverse().map(c => `Invoke-CimMethod -InputObject $kb -MethodName ReleaseKey -Arguments @{ keyCode = [uint32]${c} } | Out-Null`).join("\n    ")}`,
    { timeout: 20000 });
}
/* Type a literal string into the guest (Msvm_Keyboard.TypeText). */
async function typeText(id, text) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('No such session.'); e.code = 'VM_GONE'; throw e; }
  const t = String(text || '').slice(0, 500);
  if (!t) return;
  touch(id);
  await ps(`
    $ErrorActionPreference = 'Stop'
    $vm = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$(${q(s.vmName)})'"
    $kb = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_Keyboard | Select-Object -First 1
    Invoke-CimMethod -InputObject $kb -MethodName TypeText -Arguments @{ asciiText = ${q(t)} } | Out-Null`,
    { timeout: 20000 });
}

/* ============================================================
   RESOURCE READOUT (admin Settings panel)
   ============================================================ */
async function resourceStats() {
  const cap = await capabilities();
  const stats = {
    ready: cap.ready, reason: cap.reason,
    sessions: listSessions(), maxSessions: MAX_SESSIONS,
    memoryMB: MEMORY_MB, cpus: CPUS,
    // guacd decides whether sessions get a real mouse; it is reported separately
    // from Hyper-V readiness because either can be missing on its own.
    mode: cap.mode, guacd: cap.guacd, guacdPort: cap.guacdPort,
    host: null, vms: [],
  };
  if (process.platform !== 'win32') return stats;

  // Serve a very recent reading rather than spawning PowerShell again. The panel
  // polls every 5s and none of these numbers move meaningfully faster than that.
  if (_resCache && (Date.now() - _resAt) < RES_TTL_MS) {
    stats.host = _resCache.host;
    stats.vms = _resCache.vms;
    return stats;
  }
  try {
    // ONE script for both the host figures and the guest figures: process spawn
    // dominates the cost, so the number of spawns is what matters.
    const combined = await psJson(`
      $os = Get-CimInstance Win32_OperatingSystem
      $cs = Get-CimInstance Win32_ComputerSystem
      $vms = @()
      if (Get-Command Get-VM -ErrorAction SilentlyContinue) {
        $vms = @(Get-VM -Name '${VM_PREFIX}*' -ErrorAction SilentlyContinue | ForEach-Object {
          [pscustomobject]@{
            name = $_.Name; state = "$($_.State)"
            cpuPct = [int]$_.CPUUsage
            memMB = [int]($_.MemoryAssigned / 1MB)
            upSec = [int]$_.Uptime.TotalSeconds
          } })
      }
      [pscustomobject]@{
        host = [pscustomobject]@{
          totalMB = [int]($cs.TotalPhysicalMemory / 1MB)
          freeMB  = [int]($os.FreePhysicalMemory / 1KB)
          cpus    = [int]$cs.NumberOfLogicalProcessors
        }
        vms = $vms
      }`, { timeout: 20000 });
    if (combined) {
      stats.host = combined.host || null;
      stats.vms = Array.isArray(combined.vms) ? combined.vms : (combined.vms ? [combined.vms] : []);
      _resCache = { host: stats.host, vms: stats.vms };
      _resAt = Date.now();
    }
  } catch (e) {}
  return stats;
}


/* Best-effort teardown so a normal shutdown never leaves a guest running. */
function shutdownSync() {
  if (process.platform !== 'win32' || !sessions.size) return;
  const names = [...sessions.values()].map(s => s.vmName);
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      names.map(n => `Stop-VM -Name ${q(n)} -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -Name ${q(n)} -Force -ErrorAction SilentlyContinue`).join('; ')],
      { windowsHide: true, stdio: 'ignore', timeout: 60000 });
  } catch (e) {}
  for (const s of sessions.values()) { try { fs.rmSync(s.diskPath, { force: true }); } catch (e) {} }
}

module.exports = {
  init, capabilities, invalidateCaps, resourceStats,
  startSession, destroySession, destroyAll, getSession, sessionFor, listSessions,
  screenshot, sendKeys, typeText, touch, shutdownSync, openTunnel, addFile, runFile,
  sessionForPublic, getSessionPublic,
  MAX_SESSIONS, IDLE_MS, MAX_LIFE_MS,
};
