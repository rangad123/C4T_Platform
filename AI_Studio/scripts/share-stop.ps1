# Stops what scripts\share-start.ps1 started: exactly the two process ids recorded in .scratch\share.json (and their children). Nothing else is touched.
$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root ".scratch\share.json"
if (-not (Test-Path $file)) { Write-Host "Nothing to stop: .scratch\share.json does not exist."; exit 0 }
$s = Get-Content $file -Raw | ConvertFrom-Json
foreach ($id in @($s.tunnelPid, $s.serverPid)) {
    if ($id) {
        # taskkill /T also ends the node process npm started; only the recorded pid tree is affected.
        & taskkill.exe /PID $id /T /F 2>$null | Out-Null
    }
}
Remove-Item $file -ErrorAction SilentlyContinue
Write-Host "Stopped sharing. The link no longer works."
