import Foundation

/// 一张图的像素：按行存，每个像素 R、G、B 三个字节。
///
/// 缩放、裁行这些官方示例用 OpenCV 做的事在这里自己写，算法和安卓的 Raster.kt 一一对应（同样的浮点运算顺序）：
/// - 双线性插值按像素中心对齐、边上复制边缘像素，和 OpenCV 的 INTER_LINEAR / BORDER_REPLICATE 一致；
/// - 官方裁行用的是 warpPerspective（INTER_CUBIC），这里框都是矩形，用仿射 + 双线性，差别很小。
struct Raster {
  let width: Int
  let height: Int
  /// width × height × 3 字节，RGB
  let pixels: [UInt8]

  init(width: Int, height: Int, pixels: [UInt8]) {
    precondition(pixels.count == width * height * 3)
    self.width = width
    self.height = height
    self.pixels = pixels
  }

  /// 在 (x, y) 处双线性取色，结果写进 out（R、G、B，0–255 的浮点）；坐标出界时取边上的像素
  @inline(__always)
  private static func sample(
    _ pixels: UnsafeBufferPointer<UInt8>, width: Int, height: Int, x: Double, y: Double,
    _ out: inout (Float, Float, Float)
  ) {
    let cx = min(max(x, 0.0), Double(width - 1))
    let cy = min(max(y, 0.0), Double(height - 1))
    let x0 = Int(cx.rounded(.down))
    let y0 = Int(cy.rounded(.down))
    let x1 = min(x0 + 1, width - 1)
    let y1 = min(y0 + 1, height - 1)
    let fx = Float(cx - Double(x0))
    let fy = Float(cy - Double(y0))
    let i00 = (y0 * width + x0) * 3
    let i01 = (y0 * width + x1) * 3
    let i10 = (y1 * width + x0) * 3
    let i11 = (y1 * width + x1) * 3
    @inline(__always)
    func channel(_ offset: Int) -> Float {
      let c00 = Int(pixels[i00 + offset])
      let c01 = Int(pixels[i01 + offset])
      let c10 = Int(pixels[i10 + offset])
      let c11 = Int(pixels[i11 + offset])
      // 和 Kotlin 一样：整数差乘浮点小数
      let top = Float(c00) + Float(c01 - c00) * fx
      let bottom = Float(c10) + Float(c11 - c10) * fx
      return top + (bottom - top) * fy
    }
    out = (channel(0), channel(1), channel(2))
  }

  @inline(__always)
  private static func pick(_ rgb: (Float, Float, Float), _ index: Int) -> Float {
    index == 0 ? rgb.0 : (index == 1 ? rgb.1 : rgb.2)
  }

  /// 缩放到 dstW × dstH 并转成模型输入：NCHW 的浮点数组。
  /// order 是通道顺序（"BGR" 或 "RGB"）；每个值 = (像素 × scale − mean[c]) / std[c]，c 按 order 里的顺序。
  func toTensor(dstW: Int, dstH: Int, order: String, scale: Float, mean: [Float], std: [Float]) -> [Float] {
    let plane = dstW * dstH
    var tensor = [Float](repeating: 0, count: 3 * plane)
    let scaleX = Double(width) / Double(dstW)
    let scaleY = Double(height) / Double(dstH)
    // order 里第 i 个通道取 RGB 里的哪一个
    let orderChars = Array(order)
    let pick = (0..<3).map { index -> Int in
      switch orderChars[index] {
      case "R": return 0
      case "G": return 1
      default: return 2
      }
    }
    let (pick0, pick1, pick2) = (pick[0], pick[1], pick[2])
    let (mean0, mean1, mean2) = (mean[0], mean[1], mean[2])
    let (std0, std1, std2) = (std[0], std[1], std[2])
    let width = self.width
    let height = self.height
    pixels.withUnsafeBufferPointer { source in
      tensor.withUnsafeMutableBufferPointer { output in
        var rgb: (Float, Float, Float) = (0, 0, 0)
        for dy in 0..<dstH {
          let sy = (Double(dy) + 0.5) * scaleY - 0.5
          for dx in 0..<dstW {
            let sx = (Double(dx) + 0.5) * scaleX - 0.5
            Raster.sample(source, width: width, height: height, x: sx, y: sy, &rgb)
            let offset = dy * dstW + dx
            output[offset] = (Raster.pick(rgb, pick0) * scale - mean0) / std0
            output[plane + offset] = (Raster.pick(rgb, pick1) * scale - mean1) / std1
            output[2 * plane + offset] = (Raster.pick(rgb, pick2) * scale - mean2) / std2
          }
        }
      }
    }
    return tensor
  }

  /// 把四边形 corners（左上、右上、右下、左下，按要读出来的方向）拉成一张正的矩形小图，
  /// 宽是上下两边较长的那条，高是左右两边较长的那条（照官方 QuadTextCrop）。
  func cropQuad(_ corners: [PointD]) -> Raster {
    let dstW = max(Int(max(Geometry.distance(corners[0], corners[1]), Geometry.distance(corners[3], corners[2]))), 1)
    let dstH = max(Int(max(Geometry.distance(corners[0], corners[3]), Geometry.distance(corners[1], corners[2]))), 1)
    let ax = (corners[1].x - corners[0].x) / Double(dstW)
    let ay = (corners[1].y - corners[0].y) / Double(dstW)
    let bx = (corners[3].x - corners[0].x) / Double(dstH)
    let by = (corners[3].y - corners[0].y) / Double(dstH)
    let originX = corners[0].x
    let originY = corners[0].y
    var out = [UInt8](repeating: 0, count: dstW * dstH * 3)
    let width = self.width
    let height = self.height
    @inline(__always)
    func toByte(_ value: Float) -> UInt8 {
      UInt8(min(max(roundHalfUp(value), 0), 255))
    }
    pixels.withUnsafeBufferPointer { source in
      out.withUnsafeMutableBufferPointer { output in
        var rgb: (Float, Float, Float) = (0, 0, 0)
        for v in 0..<dstH {
          for u in 0..<dstW {
            let x = originX + Double(u) * ax + Double(v) * bx
            let y = originY + Double(u) * ay + Double(v) * by
            Raster.sample(source, width: width, height: height, x: x, y: y, &rgb)
            let offset = (v * dstW + u) * 3
            output[offset] = toByte(rgb.0)
            output[offset + 1] = toByte(rgb.1)
            output[offset + 2] = toByte(rgb.2)
          }
        }
      }
    }
    return Raster(width: dstW, height: dstH, pixels: out)
  }

  /// 识别模型的输入：等比缩放到高 height（宽 = ceil(height × 宽高比)，最多 maxWidth），RGB，(x / 255 − 0.5) / 0.5。
  /// 照官方 RecPreprocessor（一次一行）。返回张量和宽度。
  func toRecTensor(height targetHeight: Int, maxWidth: Int) -> (tensor: [Float], width: Int) {
    let ratio = Double(width) / Double(height)
    let dstW = min(max(Int((Double(targetHeight) * ratio).rounded(.up)), 1), maxWidth)
    let half: [Float] = [0.5, 0.5, 0.5]
    let tensor = toTensor(dstW: dstW, dstH: targetHeight, order: "RGB", scale: 1 / 255, mean: half, std: half)
    return (tensor, dstW)
  }
}
