# React Native calls the TurboModule methods by name from C++, and the SDK
# reads some React Native classes by reflection.
-keep class ai.oodle.rum.** { *; }
-keepnames class com.facebook.react.views.text.PreparedLayoutTextView { *; }
-keepnames class com.facebook.react.views.text.PreparedLayout { *; }
