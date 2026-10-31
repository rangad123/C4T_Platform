# Starts the platform and a public tunnel (Cloudflare quick tunnel) so other people can open it.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File scripts\share-start.ps1
# It refuses to start unless API_KEY is set in .env (without a key the platform would be open to everyone with the link).
# It records the process ids it starts in .scratch\share.json so scripts\share-stop.ps1 stops exactly those and nothing else.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force .scratch | Out-Null

$envFile = Join-Path $root ".env"
$hasKey = $false
if (Test-Path $envFile) { $hasKey = [bool](Select-String -Path $envFile -Pattern '^\s*API_KEY=\S+' -Quiet) }
if (-not $hasKey) { Write-Host "API_KEY is not set in .env. Add a line API_KEY=<a long random value> first, then run this again." -ForegroundColor Red; exit 1 }

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cf)) { Write-Host "cloudflared is not installed. Install it with: winget install --id Cloudflare.cloudflared" -ForegroundColor Red; exit 1 }

$port = 4000
$listening = $false
try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/projects" -TimeoutSec 3 | Out-Null; $listening = $true } catch { if ($_.Exception.Response) { $listening = $true } }
if ($listening) { Write-Host "Something already answers on port $port. Stop it first (or use that one) so this script can start a protected platform." -ForegroundColor Red; exit 1 }

# The tunnel starts first: its address is needed by the platform (PUBLIC_URL), so runner downloads and alert links point at the public https address.
$tunnelLog = ".scratch\share-tunnel.log"
$url = $null
$tunnel = $null
# Cloudflare's free tunnel service is sometimes slow to answer ("context deadline exceeded"): try up to four times.
for ($attempt = 1; $attempt -le 4 -and -not $url; $attempt++) {
    Remove-Item $tunnelLog -ErrorAction SilentlyContinue
    $tunnel = Start-Process -FilePath $cf -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$port", "--no-autoupdate") -WindowStyle Hidden -PassThru -RedirectStandardError $tunnelLog -RedirectStandardOutput ".scratch\share-tunnel.out.log"
    for ($i = 0; $i -lt 25 -and -not $url; $i++) {
        Start-Sleep -Seconds 2
        if (-not (Test-Path $tunnelLog)) { continue }
        # The real address is a random name; "api.trycloudflare.com" is Cloudflare's own service and shows up in error lines, so it is never the link.
        $m = Select-String -Path $tunnelLog -Pattern 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value }
        elseif (Select-String -Path $tunnelLog -Pattern 'failed to request quick Tunnel' -Quiet) { break }
    }
    if (-not $url) {
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
        Write-Host "The tunnel service did not answer (attempt $attempt of 4)." -ForegroundColor Yellow
    }
}
if (-not $url) { Write-Host "The tunnel did not give an address after four tries. Cloudflare may be slow or blocked on this network. Look at $tunnelLog" -ForegroundColor Red; exit 1 }

$env:PUBLIC_URL = $url
$server = Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput ".scratch\share-server.log" -RedirectStandardError ".scratch\share-server.err.log"
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/projects" -TimeoutSec 3 | Out-Null } catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { break } }
}
$code = 0
try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/projects" -TimeoutSec 3 | Out-Null; $code = 200 } catch { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } }
if ($code -ne 401) {
    Write-Host "The platform did not start protected (answered $code). Closing the tunnel." -ForegroundColor Red
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

@{ serverPid = $server.Id; tunnelPid = $tunnel.Id; url = $url; startedAt = (Get-Date).ToString("s") } | ConvertTo-Json | Set-Content ".scratch\share.json"
Write-Host ""
Write-Host "Shared at: $url" -ForegroundColor Green
Write-Host "People enter the API key from your .env file (the API_KEY line). Send the key separately from the link."
Write-Host "The link changes every time you start the tunnel. To stop sharing: powershell -ExecutionPolicy Bypass -File scripts\share-stop.ps1"
