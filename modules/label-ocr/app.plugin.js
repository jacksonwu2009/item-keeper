const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * 拍照识别（modules/label-ocr）的配置：安卓最低版本提到 8.0（minSdk 26）。
 * ONNX Runtime 和 PaddleOCR 官方安卓示例都按 minSdk 26 做的。
 * 写在根 build.gradle 的 ext 里，Expo 的 expo-root-project 插件看到已经设了就不再用默认的 24。
 */
const MIN_SDK = 26;

module.exports = function withLabelOcr(config) {
  return withProjectBuildGradle(config, (gradleConfig) => {
    const marker = `minSdkVersion = ${MIN_SDK}`;
    if (!gradleConfig.modResults.contents.includes(marker)) {
      gradleConfig.modResults.contents = gradleConfig.modResults.contents.replace(
        'apply plugin: "expo-root-project"',
        `ext {\n  // 拍照识别（modules/label-ocr）要 Android 8.0 以上\n  ${marker}\n}\n\napply plugin: "expo-root-project"`,
      );
    }
    return gradleConfig;
  });
};
