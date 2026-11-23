require 'json'

# 拍照识别的 iOS 原生模块（Swift）。expo-module.config.json 里 apple.podspecPath 指到这个文件。
#
# 放在 modules/label-ocr/ 下而不是 ios/ 下：CocoaPods 只能打包 podspec 所在目录里面的文件，
# 模型在和安卓共用的 modules/label-ocr/models/，放在这里才引用得到。
#
# 打包前要先准备两样不进 git 的东西（说明见 ios/README.md）：
#   scripts/fetch-ocr-models.sh                         → models/PP-OCRv6_small/{det,rec}/inference.{onnx,yml}
#   modules/label-ocr/ios/scripts/fetch-onnxruntime.sh  → ios/Frameworks/onnxruntime.xcframework
# 缺了 pod install 直接报错，免得打出一个没有模型、一用就报错的包。

package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

required_files = %w[
  models/PP-OCRv6_small/det/inference.onnx
  models/PP-OCRv6_small/det/inference.yml
  models/PP-OCRv6_small/rec/inference.onnx
  models/PP-OCRv6_small/rec/inference.yml
  ios/Frameworks/onnxruntime.xcframework/Info.plist
]
missing = required_files.reject { |file| File.exist?(File.join(__dir__, file)) }
unless missing.empty?
  raise "拍照识别（modules/label-ocr）缺少文件：#{missing.join('、')}。" \
        '先在项目根目录运行 scripts/fetch-ocr-models.sh 和 modules/label-ocr/ios/scripts/fetch-onnxruntime.sh，' \
        '见 modules/label-ocr/ios/README.md'
end

Pod::Spec.new do |s|
  s.name           = 'LabelOcr'
  s.version        = package['version']
  s.summary        = '拍照识别：PaddleOCR PP-OCRv6_small + ONNX Runtime，在手机上识别包装上的文字'
  s.description    = s.summary
  s.license        = package['license']
  s.author         = 'item-keeper'
  s.homepage       = 'https://docs.expo.dev/modules/overview/'
  # Expo SDK 58 的最低版本；ONNX Runtime 1.21 要求 iOS 15.1 以上，不另外抬高
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # 只编 App 用的代码：ios/tests/ 是 macOS 上的测试工具，不打进 App
  s.source_files = [
    'ios/LabelOcrModule.swift',
    'ios/Engine/**/*.swift',
    'ios/OrtBridge/**/*.{h,c}',
  ]
  s.public_header_files = 'ios/OrtBridge/LabelOcrOrt.h'

  # ONNX Runtime 1.21.0 的静态库（官方 NuGet 包里的 iOS xcframework，由 fetch-onnxruntime.sh 下载校验）。
  # 链接设置照官方 onnxruntime-c pod：要 libc++，Core ML 弱链接（ONNX Runtime 里带了 Core ML 执行器，这里不用）
  s.vendored_frameworks = 'ios/Frameworks/onnxruntime.xcframework'
  s.libraries = 'c++'
  s.weak_frameworks = 'CoreML'

  # 模型（和安卓同一份文件）整个目录打进资源包 LabelOcrModels.bundle，运行时路径是 PP-OCRv6_small/det/inference.onnx 这样
  s.resource_bundles = {
    'LabelOcrModels' => ['models/PP-OCRv6_small'],
  }

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # 开发版（Debug）也按优化编译：图像前后处理是逐像素循环，不优化要慢几十倍
    'SWIFT_OPTIMIZATION_LEVEL' => '-O',
    'GCC_OPTIMIZATION_LEVEL' => 's',
    # OrtBridge/LabelOcrOrt.c 引用 onnxruntime_c_api.h；各个 slice 的头文件一样，直接指到真机那份
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/ios/Frameworks/onnxruntime.xcframework/ios-arm64/onnxruntime.framework/Headers"',
  }
end
