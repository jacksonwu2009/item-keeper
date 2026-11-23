# ONNX Runtime 的 Java 接口靠 JNI 反射找类和方法，混淆时保留
-keep class ai.onnxruntime.** { *; }
