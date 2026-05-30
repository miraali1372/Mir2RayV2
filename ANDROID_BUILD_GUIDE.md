# راهنمای ساخت و اجرای برنامه اندروید (Android Build Guide)

این راهنما فرآیند تبدیل و کامپایل کردن برنامه وب **V2Ray Client PRO** را به یک اپلیکیشن کاملاً نیتیو اندروید با قابلیت واقع ترافیک (VPN) با استفاده از رایانه ویندوزی شما (با PowerShell یا CMD) و ابزار Gradle با جزئیات توضیح می‌دهد.

---

## 🚀 مرحله ۱: پیش‌نیازها را نصب کنید

مطمئن شوید موارد زیر روی ویندوز شما نصب شده باشد:
1. **Node.js** (نسخه ۱۸ یا بالاتر) - [دانلود کنید](https://nodejs.org/)
2. **پیش‌نیاز جاوا (JDK 17)** - بسیار مهم برای مطابقت با Gradle اندروید (ترجیحاً نسخه ۱۷).
3. **Android Studio** (شامل SDK اندروید، ابزارهای platform-tools برای عیب‌یابی و شبیه‌ساز).

---

## 🛠️ مرحله ۲: آماده‌سازی و ساخت مجدد پروژه (Build)

پروژه را استخراج کرده و وارد پوشه پروژه (به عنوان مثال `C:\Users\AvangRayan\Desktop\mir2ray---modern-v2ray-client(1)`) شوید:

۱. **خط فرمان (CMD یا PowerShell)** را در پوشه اصلی پروژه باز کنید.
۲. بسته‌های npm را دوباره نصب کنید:
   ```cmd
   npm install
   ```
۳. خروجی کدهای وب برنامه را کامپایل کنید:
   ```cmd
   npm run build
   ```
۴. کدهای کامپایل شده را با پوشه اندروید همگام‌سازی کنید:
   ```cmd
   npx cap sync android
   ```

---

## 📱 مرحله ۳: دانلود فایل گریدل سالم و خروجی گرفتن APK

شما با مشکل خراب شدن فایل پایه گریدل (`gradle-wrapper.jar`) مواجه شدید. این به دلیل خراب دانلود شدن فایل در کامپیوتر شما است. برای حل مشکل و خروجی گرفتن نهایی دستورات زیر را اجرا کنید:

### حل خطای "Invalid or corrupt jarfile"

اگر در محیط **Command Prompt (CMD)** یا **PowerShell** هستید، اول وارد پوشه اندروید شوید:
```cmd
cd android
```

سپس از **هر یک از دستورات جادویی زیر که راحت‌تر هستید** برای دانلود مجدد فایل تمیز و بدون ارور گریدل استفاده کنید:

#### روش اول: با استفاده از دستور Curl (مخصوص CMD و کاملاً پیشنهاد شده)
```cmd
curl -Lo gradle/wrapper/gradle-wrapper.jar https://github.com/gradle/gradle/raw/v8.14.3/gradle/wrapper/gradle-wrapper.jar
```

#### روش دوم: با فراخوانی PowerShell از درون همان CMD
```cmd
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/gradle/gradle/raw/v8.14.3/gradle/wrapper/gradle-wrapper.jar' -OutFile 'gradle/wrapper/gradle-wrapper.jar'"
```

### حل خطای "SDK location not found"

این خطا به این دلیل رخ می‌دهد که ابزار Gradle آدرس برنامه اندروید استودیو یا همان Android SDK شما را در ویندوز پیدا نمی‌کند. برای حل سریع آن:

ایستگاه اول: اگر از **پوشه پیش‌فرض** اندروید استودیو استفاده می‌کنید، دستور زیر را در مسیر پوشه `android` (خط فرمان ویندوز) کپی کرده و اجرا کنید تا فایل مورد نیاز ساخته شود:
```cmd
echo sdk.dir=C:/Users/AvangRayan/AppData/Local/Android/Sdk > local.properties
```

*(نکته: اگر نام کاربری ویندوز شما چیز دیگری است یا مسیر SDK را تغییر داده‌اید، فایل `local.properties` را در پوشه `android` به روش دستی بسازید و آدرس درست پوشه SDK را مانند بالا با کاراکتر `/` به جای `\` بنویسید.)*

### شروع کامپایل و تولید اپلیکیشن

پس از رفع دو خطای بالا، دستور زیر را در خط فرمان اجرا کنید تا خروجی نهایی از برنامه گرفته شود:
```cmd
.\gradlew.bat assembleDebug
```

فایل نهایی نصب شونده روی موبایل (`.apk`) پس از پایان ساخت در مسیر زیر ذخیره می‌شود:
`android\app\build\outputs\apk\debug\app-debug.apk`

---

## 📦 دانلود هسته Xray (همان v2rayNG)

قبل از اولین بیلد اندروید، کتابخانه نیتیو را دانلود کنید:

```powershell
npm run android:libs
```

فایل `android/app/libs/libv2ray.aar` از [AndroidLibXrayLite](https://github.com/2dust/AndroidLibXrayLite) (همان هسته v2rayNG) گرفته می‌شود.

## 🔧 VPN واقعی (مثل v2rayNG)

### ۱. اتصال از UI
- کانفیگ `vless://` / `vmess://` / `trojan://` را در تب پروفایل اضافه کنید.
- در داشبورد **Connect** بزنید → اجازه VPN سیستم‌عامل → ترافیک کل گوشی از TUN عبور می‌کند.

### ۲. پشته فنی
| بخش | فایل |
|-----|------|
| پل Capacitor | `XrayPlugin.java` |
| VPN + TUN | `Mir2RayVpnService.java` |
| هسته Xray | `XrayCoreManager.java` + `libv2ray.aar` |
| تبدیل لینک اشتراک → JSON | `V2rayUriParser.java`, `V2rayConfigBuilder.java` |
| قالب کانفیگ | `assets/v2ray_config_with_tun.json` (از v2rayNG) |

### ۳. بیلد کامل
```powershell
npm install
npm run build:android
cd android
.\gradlew.bat assembleDebug
```

APK: `android\app\build\outputs\apk\debug\app-debug.apk`

