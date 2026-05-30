# Downloads AndroidLibXrayLite (same core as v2rayNG)
$ErrorActionPreference = "Stop"
$libsDir = Join-Path $PSScriptRoot "..\android\app\libs"
New-Item -ItemType Directory -Force -Path $libsDir | Out-Null

$aarUrl = "https://github.com/2dust/AndroidLibXrayLite/releases/download/v26.5.19/libv2ray.aar"
$aarPath = Join-Path $libsDir "libv2ray.aar"

Write-Host "Downloading libv2ray.aar ..."
curl.exe --ssl-no-revoke -L -o $aarPath $aarUrl

if (-not (Test-Path $aarPath)) {
    throw "Download failed: $aarPath"
}

Write-Host "Done: $aarPath ($([math]::Round((Get-Item $aarPath).Length / 1MB, 2)) MB)"
