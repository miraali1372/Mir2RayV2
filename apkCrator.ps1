# 1. در ریشه پروژه
cd "c:\Users\AvangRayan\Desktop\mir2rayV2 - Copy"

# 2. نصب dependencies
npm install

# 3. دانلود کتابخانه‌های اندروید (libv2ray.aar)
npm run android:libs

# 4. بیلد وب اپلیکیشن
npm run build

# 5. همگام‌سازی با Capacitor
npx cap sync android

# 6. ورود به پوشه اندروید
cd android

# 7. اگر gradle-wrapper.jar corrupt است:
curl -Lo gradle/wrapper/gradle-wrapper.jar https://github.com/gradle/gradle/raw/v8.14.3/gradle/wrapper/gradle-wrapper.jar

# 8. تنظیم SDK path (اگر local.properties وجود ندارد):
echo sdk.dir=C:/Users/AvangRayan/AppData/Local/Android/Sdk > local.properties

# 9. بیلد Debug APK
.\gradlew.bat assembleDebug

# 10. بیلد Release APK (نیاز به keystore)
.\gradlew.bat assembleRelease