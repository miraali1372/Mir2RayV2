# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Capacitor discovers annotated plugins and their bridge methods reflectively.
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.annotation.**
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,AnnotationDefault
-keep class com.mir2ray.app.XrayPlugin { *; }

# Keep Xray/Libv2ray classes
-keep class libv2ray.** { *; }
-keep class go.** { *; }

# Keep JavaScript interface for WebView
-keepclassmembers class com.mir2ray.app.XrayPlugin {
    public *;
}
-keepclassmembers class com.mir2ray.app.XrayCoreManager {
    public *;
}
-keepclassmembers class com.mir2ray.app.Mir2RayVpnService {
    public *;
}

# Keep Parcelable implementations
-keep class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator *;
}

# Keep enum values
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Preserve line numbers for debugging
-keepattributes SourceFile,LineNumberTable

# Keep annotations
-keepattributes *Annotation*
