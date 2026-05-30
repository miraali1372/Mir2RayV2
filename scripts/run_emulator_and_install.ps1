<#
Helper script: create/start Android AVD (if sdkmanager present), build and install debug APK,
and print instructions to start `adb logcat` for capturing logs.
Run this from workspace root (where this repo is) in an elevated PowerShell with ANDROID SDK tools installed.
#>
Param(
    [string]$AvdName = "mir2ray_avd",
    [string]$ApiLevel = "android-33",
    [string]$SystemImage = "system-images;android-33;google_apis;x86_64"
)

function Check-Command($name) {
    try { Get-Command $name -ErrorAction Stop > $null; return $true } catch { return $false }
}

Write-Host "Checking required commands: sdkmanager, avdmanager, emulator, adb, gradlew.bat"
$have_sdkmanager = Check-Command sdkmanager
$have_avdmanager = Check-Command avdmanager
$have_emulator   = Check-Command emulator
$have_adb        = Check-Command adb
$have_gradle     = Test-Path "./gradlew.bat"

if (-not ($have_adb -and $have_gradle)) {
    Write-Error "Missing prerequisites. Ensure Android platform-tools (adb) are in PATH and run this script from the project root (contains gradlew.bat)."
    Write-Host "If you don't have Android SDK tools, install Android Studio (recommended) or command-line tools and add platform-tools/emulator to PATH."
    exit 1
}

if (-not ($have_sdkmanager -and $have_avdmanager -and $have_emulator)) {
    Write-Warning "sdkmanager/avdmanager/emulator not found in PATH. If you already have an AVD, you can skip creation and start it manually via the Android Studio AVD Manager."
    Write-Host "Continuing: will attempt to start an existing AVD named $AvdName if present."
}

# If sdkmanager available, ensure required packages
if ($have_sdkmanager) {
    Write-Host "Ensuring required SDK packages are installed (this may download several hundred MB)."
    & sdkmanager --install "platform-tools" "emulator" "platforms;android-33" "$SystemImage" | Write-Host
}

# Create AVD if not exists
$avdList = & avdmanager list avd 2>$null | Out-String
if ($avdList -notmatch $AvdName) {
    if (-not $have_avdmanager) {
        Write-Warning "AVD $AvdName does not exist and avdmanager is not available to create one. Please create an AVD using Android Studio AVD Manager."
    } else {
        Write-Host "Creating AVD $AvdName using image $SystemImage"
        echo "no" | & avdmanager create avd -n $AvdName -k "$SystemImage" --force
    }
} else {
    Write-Host "AVD $AvdName already exists."
}

# Start emulator
Write-Host "Starting emulator $AvdName..."
Start-Process -FilePath emulator -ArgumentList "-avd $AvdName -no-snapshot -accel on -gpu host" -WindowStyle Hidden

# Wait for boot
Write-Host "Waiting for emulator to appear (adb)..."
& adb wait-for-device
Write-Host "Waiting for system boot completion (may take 30-120s)..."
for ($i=0; $i -lt 120; $i++) {
    $boot = (& adb shell getprop sys.boot_completed 2>$null).Trim()
    if ($boot -eq "1") { Write-Host "Emulator booted."; break }
    Start-Sleep -Seconds 2
}

# Build the debug APK
Write-Host "Building debug APK..."
& .\gradlew.bat assembleDebug
if ($LASTEXITCODE -ne 0) { Write-Error "Gradle build failed."; exit 1 }

$apkPath = "android\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $apkPath)) { Write-Error "APK not found at $apkPath"; exit 1 }

Write-Host "Installing APK to emulator/device..."
& adb install -r $apkPath

Write-Host "APK installed. Starting background log capture to mir2ray_logcat.txt..."
$logFile = Join-Path (Get-Location) "mir2ray_logcat.txt"
try {
    $job = Start-Job -ScriptBlock { param($lf) adb logcat -v time > $lf } -ArgumentList $logFile
    Write-Host "Log capture started in background (JobId=$($job.Id)). Reproduce the crash in the emulator now."
    Write-Host "When finished, press ENTER here to stop log capture and flush the file."
    Read-Host "Press ENTER to stop log capture"
    Write-Host "Stopping log capture..."
    Stop-Job $job -Force | Out-Null
    Remove-Job $job | Out-Null
    Start-Sleep -Milliseconds 500
    if (Test-Path $logFile) {
        Write-Host "Log capture stopped. File saved to: $logFile"
    } else {
        Write-Warning "Log file not found at expected location: $logFile"
    }
} catch {
    Write-Warning "Automatic log capture failed: $_"
    Write-Host "Fallback: run in a separate shell: adb logcat -v time > mir2ray_logcat.txt"
}

Write-Host "If you'd rather capture only exceptions: adb logcat -v time | findstr /i \"Exception\""

Write-Host "Done. When you provide mir2ray_logcat.txt I will analyze the crash stack trace and propose fixes."