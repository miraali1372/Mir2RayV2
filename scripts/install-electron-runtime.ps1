$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronRoot = Join-Path $root 'node_modules\electron'
$packageFile = Join-Path $electronRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageFile)) { throw 'Install npm dependencies before installing the Electron runtime' }

$version = (Get-Content -Raw -LiteralPath $packageFile | ConvertFrom-Json).version
$dist = Join-Path $electronRoot 'dist'
$executable = Join-Path $dist 'electron.exe'
if (Test-Path -LiteralPath $executable) {
    Set-Content -LiteralPath (Join-Path $electronRoot 'path.txt') -Value 'electron.exe' -Encoding ascii -NoNewline
    Write-Output "Electron $version runtime already installed"
    exit 0
}

$assetName = "electron-v$version-win32-x64.zip"
$baseUrl = "https://github.com/electron/electron/releases/download/v$version"
$work = Join-Path $electronRoot '_runtime_download'
if (Test-Path -LiteralPath $work) {
    $resolvedElectron = [IO.Path]::GetFullPath($electronRoot)
    $resolvedWork = [IO.Path]::GetFullPath($work)
    if (-not $resolvedWork.StartsWith($resolvedElectron, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe Electron work path' }
    Remove-Item -LiteralPath $work -Recurse -Force
}
New-Item -ItemType Directory -Path $work -Force | Out-Null

$zip = Join-Path $work $assetName
$sums = Join-Path $work 'SHASUMS256.txt'
Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$assetName" -OutFile $zip -TimeoutSec 240
Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sums -TimeoutSec 60
$line = Get-Content -LiteralPath $sums -Encoding utf8 | Where-Object { $_ -match "\s\*?$([regex]::Escape($assetName))$" } | Select-Object -First 1
$expected = [regex]::Match([string]$line, '^[a-f0-9]{64}').Value.ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
if (-not $expected -or $actual -ne $expected) { throw 'Electron SHA-256 verification failed' }

New-Item -ItemType Directory -Path $dist -Force | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $dist -Force
Set-Content -LiteralPath (Join-Path $electronRoot 'path.txt') -Value 'electron.exe' -Encoding ascii -NoNewline
Remove-Item -LiteralPath $work -Recurse -Force
Write-Output "Electron $version runtime installed and verified"
