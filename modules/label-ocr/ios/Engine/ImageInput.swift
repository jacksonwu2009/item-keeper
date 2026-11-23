import CoreGraphics
import Foundation
import ImageIO

/// 读图：按 EXIF 摆正、按 crop 只取一块、按需缩小。和安卓的 ImageInput.kt 对应。
///
/// 只用 ImageIO / CoreGraphics（iOS、macOS 都有），不碰 UIKit，也不写任何临时文件：图只在内存里解码。
/// - 相机原图常有 4000 像素宽，全读进来太占内存；长边超过 sourceMaxSide 时按 2 的倍数缩小着读
///   （ImageIO 的 kCGImageSourceSubsampleFactor，和安卓 BitmapFactory 的 inSampleSize 一样在解码时缩小）。
///   识别每一行时从这张图里裁，所以留得比检测用的大。
/// - 有 crop 时只保留那一块，缩小倍数按那一块的大小算，小取景框里的喷码保留原图的清晰度。
/// - 像素不做色彩空间转换（按图片自己的 RGB 色彩空间取值），和 OpenCV、安卓一样直接用文件里的数值。
enum ImageInput {
  static let sourceMaxSide = 2560

  static func load(uri: String, crop: NormalizedCrop?) throws -> Raster {
    let url = try fileURL(from: uri)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) > 0
    else {
      throw OcrError.image("打不开 \(uri)")
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    let rawW = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
    let rawH = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
    if rawW <= 0 || rawH <= 0 {
      throw OcrError.image("不是图片：\(uri)")
    }
    let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1

    let region = crop.map { rawRegion(orientation: orientation, crop: $0, rawW: rawW, rawH: rawH) }
    let regionW = region.map { $0.right - $0.left } ?? rawW
    let regionH = region.map { $0.bottom - $0.top } ?? rawH
    var sample = 1
    while max(regionW, regionH) / sample > sourceMaxSide {
      sample *= 2
    }

    var options: [CFString: Any] = [kCGImageSourceShouldCache: false]
    if sample > 1 {
      // ImageIO 只认 2、4、8；更大的倍数先缩 8 倍，剩下的在下面画的时候缩
      options[kCGImageSourceSubsampleFactor] = min(sample, 8)
    }
    guard var image = CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary) else {
      throw OcrError.image("读不了这张图：\(uri)")
    }

    // 解出来的图可能已经缩小过：把原始像素里的那一块换算到解出来的图上
    if let region, region.right - region.left < rawW || region.bottom - region.top < rawH {
      let scaleX = Double(image.width) / Double(rawW)
      let scaleY = Double(image.height) / Double(rawH)
      let left = min(max(Int((Double(region.left) * scaleX).rounded(.down)), 0), image.width - 1)
      let top = min(max(Int((Double(region.top) * scaleY).rounded(.down)), 0), image.height - 1)
      let right = min(max(Int((Double(region.right) * scaleX).rounded(.up)), left + 1), image.width)
      let bottom = min(max(Int((Double(region.bottom) * scaleY).rounded(.up)), top + 1), image.height)
      guard let cropped = image.cropping(to: CGRect(x: left, y: top, width: right - left, height: bottom - top)) else {
        throw OcrError.image("裁不了这张图：\(uri)")
      }
      image = cropped
    }

    // 目标大小：那一块按 sample 缩小以后（向上取整，和解码器的取法一样）。ImageIO 没按要求缩时在这里补上
    let targetW = max((regionW + sample - 1) / sample, 1)
    let targetH = max((regionH + sample - 1) / sample, 1)
    let drawW = image.width > targetW + 1 ? targetW : image.width
    let drawH = image.height > targetH + 1 ? targetH : image.height
    let pixels = try rgbPixels(of: image, width: drawW, height: drawH)
    return applyOrientation(Raster(width: drawW, height: drawH, pixels: pixels), orientation: orientation)
  }

  /// file:// 开头的 URI 或绝对路径
  static func fileURL(from uri: String) throws -> URL {
    if uri.hasPrefix("/") {
      return URL(fileURLWithPath: uri)
    }
    if uri.hasPrefix("file://") {
      if let url = URL(string: uri), url.isFileURL {
        return url
      }
      // 没做百分号编码的路径（含空格、中文）也认
      let path = String(uri.dropFirst("file://".count))
      return URL(fileURLWithPath: path.removingPercentEncoding ?? path)
    }
    throw OcrError.image("只支持本机图片文件（file://），收到的是 \(uri)")
  }

  /// 摆正以后的一块（0–1）对应原始像素里的哪一块。EXIF 的 8 种方向只有转 90° 的倍数和翻转，矩形还是矩形，
  /// 把两个对角换算回去取外接框就行。换算式：摆正后的 (u, v) → 原图 (x, y)。和安卓的 rawRegion 一样。
  static func rawRegion(orientation: Int, crop: NormalizedCrop, rawW: Int, rawH: Int)
    -> (left: Int, top: Int, right: Int, bottom: Int)
  {
    func clamp01(_ value: Double) -> Double { min(max(value, 0.0), 1.0) }
    let u0 = clamp01(crop.x)
    let v0 = clamp01(crop.y)
    let u1 = clamp01(crop.x + crop.width)
    let v1 = clamp01(crop.y + crop.height)
    func toRaw(_ u: Double, _ v: Double) -> (Double, Double) {
      switch orientation {
      case 2: return (1 - u, v)
      case 3: return (1 - u, 1 - v)
      case 4: return (u, 1 - v)
      case 5: return (v, u)
      case 6: return (v, 1 - u)
      case 7: return (1 - v, 1 - u)
      case 8: return (1 - v, u)
      default: return (u, v)
      }
    }
    let (ax, ay) = toRaw(u0, v0)
    let (bx, by) = toRaw(u1, v1)
    let left = min(max(Int(min(ax, bx) * Double(rawW)), 0), rawW - 1)
    let top = min(max(Int(min(ay, by) * Double(rawH)), 0), rawH - 1)
    let right = min(max(Int(max(ax, bx) * Double(rawW)), left + 1), rawW)
    let bottom = min(max(Int(max(ay, by) * Double(rawH)), top + 1), rawH)
    return (left, top, right, bottom)
  }

  /// 把 CGImage 画进 width × height 的 8 位 RGBA 缓冲区，取出 RGB
  private static func rgbPixels(of image: CGImage, width: Int, height: Int) throws -> [UInt8] {
    let bytesPerRow = width * 4
    var rgba = [UInt8](repeating: 0, count: height * bytesPerRow)
    let ownSpace = image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil }
    let drawn = rgba.withUnsafeMutableBytes { buffer -> Bool in
      for space in [ownSpace, CGColorSpace(name: CGColorSpace.sRGB)].compactMap({ $0 }) {
        guard let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: bytesPerRow, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { continue }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
      }
      return false
    }
    if !drawn {
      throw OcrError.image("这张图的像素格式不支持")
    }
    var rgb = [UInt8](repeating: 0, count: width * height * 3)
    rgba.withUnsafeBufferPointer { source in
      rgb.withUnsafeMutableBufferPointer { target in
        for index in 0..<(width * height) {
          target[index * 3] = source[index * 4]
          target[index * 3 + 1] = source[index * 4 + 1]
          target[index * 3 + 2] = source[index * 4 + 2]
        }
      }
    }
    return rgb
  }

  /// 按 EXIF 方向（1–8）把像素摆正。和安卓 applyOrientation 里的矩阵一一对应：
  /// 2 左右翻，3 转 180°，4 上下翻，5 转置，6 顺时针 90°，7 反转置，8 逆时针 90°
  static func applyOrientation(_ raster: Raster, orientation: Int) -> Raster {
    guard (2...8).contains(orientation) else { return raster }
    let width = raster.width
    let height = raster.height
    let swapsSides = orientation >= 5
    let outW = swapsSides ? height : width
    let outH = swapsSides ? width : height
    var out = [UInt8](repeating: 0, count: raster.pixels.count)
    raster.pixels.withUnsafeBufferPointer { source in
      out.withUnsafeMutableBufferPointer { target in
        for y in 0..<outH {
          for x in 0..<outW {
            let sx: Int
            let sy: Int
            switch orientation {
            case 2: (sx, sy) = (width - 1 - x, y)
            case 3: (sx, sy) = (width - 1 - x, height - 1 - y)
            case 4: (sx, sy) = (x, height - 1 - y)
            case 5: (sx, sy) = (y, x)
            case 6: (sx, sy) = (y, height - 1 - x)
            case 7: (sx, sy) = (width - 1 - y, height - 1 - x)
            default: (sx, sy) = (width - 1 - y, x)
            }
            let from = (sy * width + sx) * 3
            let to = (y * outW + x) * 3
            target[to] = source[from]
            target[to + 1] = source[from + 1]
            target[to + 2] = source[from + 2]
          }
        }
      }
    }
    return Raster(width: outW, height: outH, pixels: out)
  }
}
