import Foundation

// 引擎里共用的小类型。这个目录（Engine/）只用 Foundation、ImageIO、CoreGraphics，不依赖 UIKit 和 Expo，
// 所以同一份代码在 macOS 上也能用 swiftc 编译成命令行工具来测（见 ios/tests/）。

/// 一个点，单位是像素，y 向下
struct PointD: Hashable {
  var x: Double
  var y: Double
}

/// 相对整张图（按 EXIF 摆正以后）的一块，0–1
struct NormalizedCrop {
  var x: Double
  var y: Double
  var width: Double
  var height: Double
}

/// 引擎的错误，模块层按种类转成 JS 的错误码
enum OcrError: Error, CustomStringConvertible {
  /// 读不了图：ERR_LABEL_OCR_IMAGE
  case image(String)
  /// 模型缺失、加载失败：ERR_LABEL_OCR_MODEL
  case model(String)
  /// 推理出错：ERR_LABEL_OCR_FAILED
  case failed(String)

  var description: String {
    switch self {
    case .image(let message), .model(let message), .failed(let message):
      return message
    }
  }
}

/// 毫秒计时（单调时钟）
enum Clock {
  static func nowMs() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
  }
}

/// 和 Kotlin 的 Math.round / roundToInt 一样：四舍五入，.5 往正方向
@inline(__always)
func roundHalfUp(_ value: Double) -> Int {
  Int((value + 0.5).rounded(.down))
}

@inline(__always)
func roundHalfUp(_ value: Float) -> Int {
  Int((value + 0.5).rounded(.down))
}
