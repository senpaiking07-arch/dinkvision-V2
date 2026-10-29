# Native JavaCV/FFmpeg and UVC entry points are resolved through JNI or library
# reflection and must remain available in optimized release builds.
-keepclasseswithmembernames class * {
    native <methods>;
}
-keep class org.bytedeco.javacpp.Loader { *; }
-keep class org.bytedeco.javacpp.Pointer { *; }
-keep class org.bytedeco.javacpp.** extends org.bytedeco.javacpp.Pointer { *; }
-keep @interface org.bytedeco.javacpp.annotation.**
-keep class org.bytedeco.ffmpeg.** { *; }
-keep class org.bytedeco.javacv.FFmpegFrameGrabber { *; }
-keep class org.bytedeco.javacv.FFmpegFrameRecorder { *; }
-keep class org.bytedeco.javacv.Frame { *; }
-keep class org.bytedeco.javacv.FrameGrabber { *; }
-keep class org.bytedeco.javacv.FrameRecorder { *; }
-dontwarn org.bytedeco.javacv.**
-dontwarn org.slf4j.**
-dontwarn org.osgi.annotation.**
-dontwarn java.lang.management.BufferPoolMXBean
-dontwarn javax.management.MalformedObjectNameException
-dontwarn javax.management.ObjectName
-keep class com.herohan.** { *; }
-keep class com.serenegiant.** { *; }
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,Signature,InnerClasses,EnclosingMethod
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
