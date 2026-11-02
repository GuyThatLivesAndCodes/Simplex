# Mount every shadow copy and test its system.sqlite. Read-only.
$ids = 21,20,19,18,17,16,12      # newest first, from your vssadmin output
foreach ($i in $ids) {
  $link = "C:\shadow$i"
  if (-not (Test-Path $link)) {
    cmd /c mklink /d $link "\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy$i\" | Out-Null
  }
  $db = "$link\Simplex Database\vault\system.sqlite"
  Write-Host "`n================ HarddiskVolumeShadowCopy$i ================"
  if (Test-Path $db) {
    node "C:\Simplex Database\rescue.js" inspect $db
  } else {
    Write-Host "  no system.sqlite in this snapshot"
  }
}
