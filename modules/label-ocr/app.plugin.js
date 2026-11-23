const { withGradleProperties, withProjectBuildGradle } = require('expo/config-plugins');

/**
 * 拍照识别（modules/label-ocr）的安卓配置：
 * - 最低版本提到 8.0（minSdk 26）。ONNX Runtime 和 PaddleOCR 官方安卓示例都按 minSdk 26 做的。
 *   写在根 build.gradle 的 ext 里，Expo 的 expo-root-project 插件看到已经设了就不再用默认的 24。
 * - 安装包里的 .so 压缩存放（expo.useLegacyPackaging=true）。默认是不压缩、按页对齐存放（装好后直接从安装包里映射，
 *   不用另解压），但 ONNX Runtime 一个就 18 MB，全部 .so 加起来 47 MB；压缩后约 17 MB，安装包小约 30 MB。
 *   代价是安装时系统把 .so 解压到 App 目录，手机上多占约 47 MB。这个 App 的安装包是发文件装的，先顾安装包大小。
 */
const MIN_SDK = 26;

module.exports = function withLabelOcr(config) {
  config = withProjectBuildGradle(config, (gradleConfig) => {
    const marker = `minSdkVersion = ${MIN_SDK}`;
    if (!gradleConfig.modResults.contents.includes(marker)) {
      gradleConfig.modResults.contents = gradleConfig.modResults.contents.replace(
        'apply plugin: "expo-root-project"',
        `ext {\n  // 拍照识别（modules/label-ocr）要 Android 8.0 以上\n  ${marker}\n}\n\napply plugin: "expo-root-project"`,
      );
    }
    return gradleConfig;
  });
  return withGradleProperties(config, (propertiesConfig) => {
    const key = 'expo.useLegacyPackaging';
    const items = propertiesConfig.modResults.filter((item) => !(item.type === 'property' && item.key === key));
    items.push({ type: 'property', key, value: 'true' });
    propertiesConfig.modResults = items;
    return propertiesConfig;
  });
};
