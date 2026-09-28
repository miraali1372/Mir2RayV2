param(
    [string]$BuildType = "Debug",
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

Write-Host "Building Mir2RayV2 Android ($BuildType)..." -ForegroundColor Cyan

# 1. Clean if requested
if ($Clean) {
    Write-Host "Cleaning previous builds..."
    npm run clean 2>$null
    if (Test-Path "android") { cd android; .\gradlew.bat clean; cd .. }
}

# 2. Install deps
Write-Host "Installing npm dependencies..."
npm install

# 3. Download Android libs
Write-Host "Downloading Android libraries (libv2ray.aar)..."
npm run android:libs

# 4. Build web
Write-Host "Building web app..."
npm run build

# 5. Capacitor sync
Write-Host "Syncing Capacitor..."
npx cap sync android

# 6. Gradle build
Write-Host "Building Android APK..."
cd android
if ($BuildType -eq "Release") {
    .\gradlew.bat :app:assembleRelease
    $apkPath = "app\build\outputs\apk\release\Mir2rayV2-v*.apk"
} else {
    .\gradlew.bat :app:assembleDebug
    $apkPath = "app\build\outputs\apk\debug\Mir2rayV2-debug.apk"
}
cd ..

# 7. Show result
$fullPath = Resolve-Path "android\$apkPath" -ErrorAction SilentlyContinue
if ($fullPath) {
    Write-Host "Build successful!" -ForegroundColor Green
    Write-Host "APK location: $fullPath" -ForegroundColor Yellow
    $size = [math]::Round((Get-Item $fullPath).Length / 1MB, 2)
    Write-Host "Size: $size MB"
} else {
    Write-Error "APK not found at expected location"
    exit 1
}