param(
    [switch]$StableOnly
)

$ErrorActionPreference = 'Stop'
$headers = @{ 'User-Agent' = 'Mir2rayV2-Windows-Build' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root 'desktop\runtime'
$work = Join-Path $runtime '_download'

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
if (Test-Path -LiteralPath $work) {
    $resolvedRuntime = [IO.Path]::GetFullPath($runtime)
    $resolvedWork = [IO.Path]::GetFullPath($work)
    if (-not $resolvedWork.StartsWith($resolvedRuntime, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unsafe runtime work path'
    }
    Remove-Item -LiteralPath $work -Recurse -Force
}
New-Item -ItemType Directory -Path $work -Force | Out-Null

if ($StableOnly) {
    $release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/XTLS/Xray-core/releases/latest' -TimeoutSec 30
} else {
    $releases = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/XTLS/Xray-core/releases?per_page=10' -TimeoutSec 30
    $release = $releases | Where-Object { -not $_.draft -and ($_.assets.name -contains 'Xray-windows-64.zip') } | Select-Object -First 1
}
if (-not $release) { throw 'No official Xray Windows x64 release was found' }

$zipAsset = $release.assets | Where-Object name -eq 'Xray-windows-64.zip' | Select-Object -First 1
$digestAsset = $release.assets | Where-Object name -eq 'Xray-windows-64.zip.dgst' | Select-Object -First 1
if (-not $zipAsset -or -not $digestAsset) { throw 'Xray release assets are incomplete' }

$xrayZip = Join-Path $work 'xray.zip'
$digestFile = Join-Path $work 'xray.zip.dgst'
Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $zipAsset.browser_download_url -OutFile $xrayZip -TimeoutSec 180
Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $digestAsset.browser_download_url -OutFile $digestFile -TimeoutSec 30
$digestText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($digestFile))
$expected = [regex]::Match($digestText, '(?im)^SHA2-256=\s*([a-f0-9]{64})\s*$').Groups[1].Value.ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $xrayZip).Hash.ToLowerInvariant()
if (-not $expected -or $actual -ne $expected) { throw 'Xray SHA-256 verification failed' }

$xrayExtract = Join-Path $work 'xray'
Expand-Archive -LiteralPath $xrayZip -DestinationPath $xrayExtract -Force
Copy-Item -LiteralPath (Join-Path $xrayExtract 'xray.exe') -Destination (Join-Path $runtime 'xray.exe') -Force
if (Test-Path -LiteralPath (Join-Path $xrayExtract 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $xrayExtract 'LICENSE') -Destination (Join-Path $runtime 'XRAY-LICENSE.txt') -Force
}

$wintunZip = Join-Path $work 'wintun.zip'
$wintunExtract = Join-Path $work 'wintun'
Invoke-WebRequest -UseBasicParsing -Uri 'https://www.wintun.net/builds/wintun-0.14.1.zip' -OutFile $wintunZip -TimeoutSec 120
Expand-Archive -LiteralPath $wintunZip -DestinationPath $wintunExtract -Force
$wintunDll = Get-ChildItem -LiteralPath $wintunExtract -Recurse -Filter 'wintun.dll' | Where-Object FullName -Match '\\bin\\amd64\\' | Select-Object -First 1
if (-not $wintunDll) { throw 'Official Wintun AMD64 DLL was not found' }
$signature = Get-AuthenticodeSignature -LiteralPath $wintunDll.FullName
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'WireGuard') {
    throw 'Wintun Authenticode verification failed'
}
Copy-Item -LiteralPath $wintunDll.FullName -Destination (Join-Path $runtime 'wintun.dll') -Force
$wintunLicense = Get-ChildItem -LiteralPath $wintunExtract -Recurse -Filter 'prebuilt-binaries-license.txt' | Select-Object -First 1
if ($wintunLicense) { Copy-Item -LiteralPath $wintunLicense.FullName -Destination (Join-Path $runtime 'WINTUN-LICENSE.txt') -Force }

Copy-Item -LiteralPath (Join-Path $root 'android\app\src\main\assets\geoip.dat') -Destination (Join-Path $runtime 'geoip.dat') -Force
Copy-Item -LiteralPath (Join-Path $root 'android\app\src\main\assets\geosite.dat') -Destination (Join-Path $runtime 'geosite.dat') -Force
Copy-Item -LiteralPath (Join-Path $root 'output\imagegen\mir2rayv2-icon-transparent.png') -Destination (Join-Path $runtime 'icon.png') -Force

$ruleVersion = Get-Content -LiteralPath (Join-Path $root 'android\app\src\main\assets\xray_assets_version.txt') -Encoding utf8
$metadata = [ordered]@{
    xray = $release.tag_name
    xrayPrerelease = [bool]$release.prerelease
    xraySha256 = $actual
    wintun = '0.14.1'
    routing = $ruleVersion
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runtime 'runtime-version.json') -Encoding utf8
Remove-Item -LiteralPath $work -Recurse -Force

Write-Output "Windows runtime ready: Xray $($release.tag_name), Wintun 0.14.1"
