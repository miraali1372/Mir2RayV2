# Downloads AndroidLibXrayLite plus routing assets and deploys the AAR to local Maven.
$ErrorActionPreference = "Stop"

$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$appDir = Join-Path $rootDir "android\app"
$libsDir = Join-Path $appDir "libs"
$assetsDir = Join-Path $appDir "src\main\assets"
$mavenBaseDir = Join-Path $rootDir "android\local-maven-repo\com\mir2ray\libv2ray"
$headers = @{ "User-Agent" = "Mir2RayV2-asset-updater" }

function Get-LatestRelease($repo) {
    Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases/latest"
}

function Get-ReleaseAsset($release, $name) {
    $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $asset) {
        throw "Asset not found in $($release.html_url): $name"
    }
    return $asset
}

function Get-RemoteSha256($url) {
    $content = (Invoke-WebRequest -Headers $headers -UseBasicParsing -Uri $url).Content
    if ($content -is [byte[]]) {
        $content = [System.Text.Encoding]::UTF8.GetString($content)
    }
    if ($content -match "([a-fA-F0-9]{64})") {
        return $matches[1].ToLowerInvariant()
    }
    throw "Could not parse sha256sum from $url"
}

function Download-Asset($url, $path, $shaUrl = $null) {
    $tmpPath = "$path.tmp"
    if (Test-Path $tmpPath) {
        Remove-Item -LiteralPath $tmpPath -Force
    }

    curl.exe --ssl-no-revoke --silent --show-error -L --fail -o $tmpPath $url
    if (-not (Test-Path $tmpPath) -or (Get-Item $tmpPath).Length -le 0) {
        throw "Download failed: $url"
    }

    if ($shaUrl) {
        $expected = Get-RemoteSha256 $shaUrl
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmpPath).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            Remove-Item -LiteralPath $tmpPath -Force
            throw "Checksum mismatch for $url"
        }
    }

    Move-Item -LiteralPath $tmpPath -Destination $path -Force
}

New-Item -ItemType Directory -Force -Path $libsDir | Out-Null
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
New-Item -ItemType Directory -Force -Path $mavenBaseDir | Out-Null

$libRelease = Get-LatestRelease "2dust/AndroidLibXrayLite"
$rulesRelease = Get-LatestRelease "Chocolate4U/Iran-v2ray-rules"
$geoipRelease = Get-LatestRelease "v2fly/geoip"

$libTag = $libRelease.tag_name
$libVersion = $libTag.TrimStart("v")
$mavenDir = Join-Path $mavenBaseDir $libVersion
New-Item -ItemType Directory -Force -Path $mavenDir | Out-Null

$aarAsset = Get-ReleaseAsset $libRelease "libv2ray.aar"
$aarPath = Join-Path $libsDir "libv2ray.aar"
$mavenAarPath = Join-Path $mavenDir "libv2ray-$libVersion.aar"

Write-Host "Downloading libv2ray $libTag ..."
Download-Asset $aarAsset.browser_download_url $aarPath
Copy-Item -LiteralPath $aarPath -Destination $mavenAarPath -Force

$pomContent = @"
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.mir2ray</groupId>
    <artifactId>libv2ray</artifactId>
    <version>$libVersion</version>
    <packaging>aar</packaging>
    <name>AndroidLibXrayLite</name>
    <description>Xray core library for Android (same as v2rayNG)</description>
    <url>https://github.com/2dust/AndroidLibXrayLite</url>
    <licenses>
        <license>
            <name>MIT License</name>
            <url>https://opensource.org/licenses/MIT</url>
        </license>
    </licenses>
    <developers>
        <developer>
            <name>2dust</name>
            <url>https://github.com/2dust</url>
        </developer>
    </developers>
    <scm>
        <url>https://github.com/2dust/AndroidLibXrayLite</url>
    </scm>
</project>
"@

$pomPath = Join-Path $mavenDir "libv2ray-$libVersion.pom"
$pomContent | Out-File -FilePath $pomPath -Encoding UTF8

foreach ($name in @("geoip.dat", "geosite.dat")) {
    $asset = Get-ReleaseAsset $rulesRelease $name
    $shaAsset = Get-ReleaseAsset $rulesRelease "$name.sha256sum"
    $target = Join-Path $assetsDir $name
    Write-Host "Downloading $name from Chocolate4U $($rulesRelease.tag_name) ..."
    Download-Asset $asset.browser_download_url $target $shaAsset.browser_download_url
}

$cnAsset = Get-ReleaseAsset $geoipRelease "geoip-only-cn-private.dat"
$cnShaAsset = Get-ReleaseAsset $geoipRelease "geoip-only-cn-private.dat.sha256sum"
$cnTarget = Join-Path $assetsDir "geoip-only-cn-private.dat"
Write-Host "Downloading geoip-only-cn-private.dat from v2fly $($geoipRelease.tag_name) ..."
Download-Asset $cnAsset.browser_download_url $cnTarget $cnShaAsset.browser_download_url

$versionContent = @(
    "libv2ray=$libTag"
    "rules=Chocolate4U/Iran-v2ray-rules@$($rulesRelease.tag_name)"
    "geoipOnly=v2fly/geoip@$($geoipRelease.tag_name)"
) -join "`n"
$versionPath = Join-Path $assetsDir "xray_assets_version.txt"
$versionContent | Out-File -FilePath $versionPath -Encoding ASCII

Write-Host "Done."
Write-Host "libv2ray: $libTag ($([math]::Round((Get-Item $aarPath).Length / 1MB, 2)) MB)"
Write-Host "rules: $($rulesRelease.tag_name)"
Write-Host "geoipOnly: $($geoipRelease.tag_name)"
