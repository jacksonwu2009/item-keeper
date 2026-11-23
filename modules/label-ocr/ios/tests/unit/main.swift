import CoreGraphics
import Foundation
import ImageIO

// 引擎里几个纯函数的单测（macOS 上和 Engine/ 一起用 swiftc 编译运行，见 run-mac-tests.sh）。
// 不需要模型；传了 --models 时再测字典解析。
//
// 用法：label-ocr-unit [--models <模型目录>] [--dict-reference <每行一个字的字典文件>]

var failures = 0
var checks = 0

func check(_ condition: Bool, _ message: @autoclosure () -> String, file: String = #fileID, line: Int = #line) {
  checks += 1
  if !condition {
    failures += 1
    print("✗ \(message())（\(file):\(line)）")
  }
}

var modelsPath: String?
var dictReferencePath: String?
var arguments = CommandLine.arguments.dropFirst()
while let argument = arguments.popFirst() {
  switch argument {
  case "--models": modelsPath = arguments.popFirst()
  case "--dict-reference": dictReferencePath = arguments.popFirst()
  default: break
  }
}

// MARK: - 四舍六入五成双、四舍五入

check(Geometry.roundHalfToEven(22.5) == 22, "22.5 → 22")
check(Geometry.roundHalfToEven(23.5) == 24, "23.5 → 24")
check(Geometry.roundHalfToEven(-0.5) == 0, "-0.5 → 0")
check(Geometry.roundHalfToEven(2.4999) == 2, "2.4999 → 2")
check(roundHalfUp(2.5) == 3 && roundHalfUp(-2.5) == -2 && roundHalfUp(Float(0.4999)) == 0, "Kotlin roundToInt 的取法")

// MARK: - 几何

do {
  // 斜着的矩形：最小外接矩形就是它自己
  let angle = 0.3
  let (c, s) = (cos(angle), sin(angle))
  let corners = [(0.0, 0.0), (40.0, 0.0), (40.0, 10.0), (0.0, 10.0)].map { PointD(x: 100 + $0.0 * c - $0.1 * s, y: 50 + $0.0 * s + $0.1 * c) }
  let rect = Geometry.minAreaRect(corners + [PointD(x: 100 + 20 * c - 5 * s, y: 50 + 20 * s + 5 * c)])
  check(abs(rect.shortSide - 10) < 1e-9, "斜矩形短边 \(rect.shortSide)")
  let ordered = Geometry.orderCorners(rect.corners)
  check(ordered.count == 4 && Geometry.distance(ordered[0], corners[0]) < 1e-9, "左上角 \(ordered[0])")
  check(Geometry.distance(ordered[1], corners[1]) < 1e-9 && Geometry.distance(ordered[3], corners[3]) < 1e-9, "右上、左下")

  // unclip：40×10 的矩形，扩出去 40×10×1.5/100 = 6 像素，外接矩形 52×22
  let box = [PointD(x: 0, y: 0), PointD(x: 40, y: 0), PointD(x: 40, y: 10), PointD(x: 0, y: 10)]
  let expanded = Geometry.minAreaRect(Geometry.unclip(box, ratio: 1.5))
  let sides = [Geometry.distance(expanded.corners[0], expanded.corners[1]), Geometry.distance(expanded.corners[1], expanded.corners[2])].sorted()
  check(abs(sides[0] - 22) < 0.05 && abs(sides[1] - 52) < 0.05, "unclip 后 \(sides)")

  // 阅读顺序：同一排（y 差 < 10）从左到右
  let boxes = [
    [PointD(x: 200, y: 105), PointD(x: 300, y: 105), PointD(x: 300, y: 120), PointD(x: 200, y: 120)],
    [PointD(x: 10, y: 100), PointD(x: 100, y: 100), PointD(x: 100, y: 120), PointD(x: 10, y: 120)],
    [PointD(x: 10, y: 10), PointD(x: 100, y: 10), PointD(x: 100, y: 30), PointD(x: 10, y: 30)],
  ]
  check(DbPostProcess.sortReadingOrder(boxes) == [2, 1, 0], "阅读顺序 \(DbPostProcess.sortReadingOrder(boxes))")
}

// MARK: - DB 后处理：画一个矩形的概率图

do {
  let (width, height) = (64, 32)
  var prob = [Float](repeating: 0.05, count: width * height)
  for y in 10..<18 { for x in 8..<50 { prob[y * width + x] = 0.9 } }
  // 一个太小的点（不到 3 个像素）不算
  prob[2 * width + 2] = 0.9
  let boxes = DbPostProcess.process(prob: prob, predW: width, predH: height, srcW: width * 2, srcH: height * 2,
                                    params: OcrEngine.dbParams)
  check(boxes.count == 1, "框数 \(boxes.count)")
  if let box = boxes.first {
    // 连通块 x 8…49、y 10…17（凸包按像素中心）：42 → 41 宽、8 → 7 高，扩 41×7×1.5/96 ≈ 4.48，再 ×2 换到原图
    check(abs(box[0].x - 7) <= 1 && abs(box[0].y - 11) <= 1, "左上角 \(box[0])")
    check(abs(box[2].x - 107) <= 1 && abs(box[2].y - 43) <= 1, "右下角 \(box[2])")
  }
}

// MARK: - CTC 解码

do {
  let characters = ["a", "b", "c", " "]
  // 5 类（空白 + 4 个字），6 步：a a 空白 a b b → "aab"
  let steps: [[Float]] = [
    [0.1, 0.8, 0.05, 0.05, 0], [0.1, 0.7, 0.1, 0.1, 0], [0.9, 0.05, 0.05, 0, 0],
    [0.2, 0.6, 0.1, 0.1, 0], [0.1, 0.1, 0.75, 0.05, 0], [0.1, 0.1, 0.65, 0.1, 0.05],
  ]
  let (text, score) = CtcDecoder.decode(steps.flatMap { $0 }, steps: 6, classes: 5, characters: characters)
  check(text == "aab", "CTC 文字 \(text)")
  check(abs(score - 0.717) < 1e-9, "CTC 置信度 \(score)（(0.8+0.6+0.75)/3 保留 3 位）")
  let empty = CtcDecoder.decode([1, 0, 0, 0, 0], steps: 1, classes: 5, characters: characters)
  check(empty.0 == "" && empty.1 == 0, "全是空白")
}

// MARK: - yml 解析

do {
  let det = try ModelConfigParser.parseDet("""
    PreProcess:
      transform_ops:
      - DecodeImage:
          channel_first: false
          img_mode: BGR
      - NormalizeImage:
          mean:
          - 0.485
          - 0.456
          - 0.406
          order: hwc
          scale: 1./255.
          std:
          - 0.229
          - 0.224
          - 0.225
    """, source: "det")
  check(det.imgMode == "BGR" && det.mean == [0.485, 0.456, 0.406] && det.std == [0.229, 0.224, 0.225], "检测参数 \(det)")
  check(abs(det.scale - 1 / 255) < 1e-9, "scale \(det.scale)")
  let rec = try ModelConfigParser.parseRec("""
    PreProcess:
      transform_ops:
      - RecResizeImg:
          image_shape:
          - 3
          - 48
          - 320
    PostProcess:
      name: CTCLabelDecode
      character_dict:
      - '!'
      - ''''
      - \u{3000}
      - "\\t"
      - 中
      - \u{FF9E}
    """, source: "rec")
  check(rec.imageHeight == 48, "识别输入高 \(rec.imageHeight)")
  // 全角空格、半角浊音符（附加符号，和前面的空格会粘成一个 Swift 字符）都要原样保留
  check(rec.characters.map { Array($0.unicodeScalars) } == ["!", "'", "\u{3000}", "\t", "中", "\u{FF9E}", " "].map { Array($0.unicodeScalars) }, "字典 \(rec.characters.map { $0.unicodeScalars.map { String($0.value, radix: 16) } })")
} catch {
  check(false, "yml 解析抛错 \(error)")
}

if let modelsPath {
  do {
    let yml = try String(contentsOfFile: modelsPath + "/rec/inference.yml", encoding: .utf8)
    let rec = try ModelConfigParser.parseRec(yml, source: "rec/inference.yml")
    if let dictReferencePath {
      // 参考字典：PyYAML 读出来的 character_dict，一行一个（JSON 数组更稳：字典里有空格类的字）
      let data = try Data(contentsOf: URL(fileURLWithPath: dictReferencePath))
      let reference = try JSONSerialization.jsonObject(with: data) as? [String] ?? []
      check(rec.characters.count == reference.count + 1, "字典 \(rec.characters.count) 个，参考 \(reference.count) 个 + 空格")
      // 按码位比（String 的 == 按 Unicode 等价比，不够严）
      let mismatched = zip(rec.characters, reference).filter { Array($0.unicodeScalars) != Array($1.unicodeScalars) }.count
      check(mismatched == 0, "字典内容和 PyYAML 读的一致（不一致 \(mismatched) 个）")
    }
    check(rec.characters.count > 18_000 && rec.characters.last == " ", "模型字典 \(rec.characters.count) 个，最后一个是空格")
  } catch {
    check(false, "读模型字典出错 \(error)")
  }
}

// MARK: - 整张图顺时针转（方向判断后转正再检测用）：和 EXIF 的 6、3、8 是同一种转法

do {
  let (width, height) = (5, 3)
  let raster = Raster(width: width, height: height, pixels: (0..<(width * height * 3)).map { UInt8($0 % 256) })
  for (degrees, orientation) in [(90, 6), (180, 3), (270, 8)] {
    let rotated = raster.rotatedClockwise(degrees)
    let expected = ImageInput.applyOrientation(raster, orientation: orientation)
    check(rotated.width == expected.width && rotated.height == expected.height && rotated.pixels == expected.pixels,
          "顺时针 \(degrees)° 和 EXIF 方向 \(orientation) 一样")
  }
  check(raster.rotatedClockwise(0).pixels == raster.pixels, "转 0° 不变")
}

// MARK: - 读图：EXIF 方向和 crop（拿 ImageIO 自己按方向摆正的结果当参考）

func makeTestImage(width: Int, height: Int) -> CGImage {
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  for y in 0..<height {
    for x in 0..<width {
      let index = (y * width + x) * 4
      pixels[index] = UInt8((x * 37 + y * 11) % 256)
      pixels[index + 1] = UInt8((y * 53 + x * 3) % 256)
      pixels[index + 2] = UInt8((x * y + 7) % 256)
      pixels[index + 3] = 255
    }
  }
  let provider = CGDataProvider(data: Data(pixels) as CFData)!
  return CGImage(
    width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
}

/// ImageIO 按 EXIF 方向摆正的结果（缩略图接口带 transform、尺寸给满就是原图大小）
func appleOriented(_ url: URL, maxSide: Int) -> Raster {
  let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
  let options: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceThumbnailMaxPixelSize: maxSide,
  ]
  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)!
  var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
  let context = CGContext(
    data: &rgba, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
    space: image.colorSpace!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  var rgb: [UInt8] = []
  for index in 0..<(image.width * image.height) { rgb += rgba[(index * 4)..<(index * 4 + 3)] }
  return Raster(width: image.width, height: image.height, pixels: rgb)
}

do {
  let (width, height) = (24, 15)
  let image = makeTestImage(width: width, height: height)
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("label-ocr-unit-\(getpid())")
  try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: folder) }
  for orientation in 1...8 {
    // TIFF 无损，带 EXIF 方向
    let url = folder.appendingPathComponent("o\(orientation).tiff")
    let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.tiff" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
    check(CGImageDestinationFinalize(destination), "写测试图 \(orientation)")

    let mine = try ImageInput.load(uri: url.absoluteString, crop: nil)
    let reference = appleOriented(url, maxSide: max(width, height))
    check(mine.width == reference.width && mine.height == reference.height, "方向 \(orientation) 尺寸 \(mine.width)×\(mine.height)")
    check(mine.pixels == reference.pixels, "方向 \(orientation) 像素和 ImageIO 摆正的一致")

    // crop：和安卓一样先把摆正后的一块（0–1）换算到原始像素（rawRegion，取整在原始坐标里做），只解那一块再摆正。
    // 参考：把这块原始像素的矩形按 EXIF 方向换到摆正后的坐标，从 ImageIO 摆正的整图里裁同一块
    let crop = NormalizedCrop(x: 0.27, y: 0.21, width: 0.5, height: 0.55)
    let region = ImageInput.rawRegion(orientation: orientation, crop: crop, rawW: width, rawH: height)
    let corners = [(region.left, region.top), (region.right, region.bottom)].map { (x, y) -> (Int, Int) in
      switch orientation {
      case 2: return (width - x, y)
      case 3: return (width - x, height - y)
      case 4: return (x, height - y)
      case 5: return (y, x)
      case 6: return (height - y, x)
      case 7: return (height - y, width - x)
      case 8: return (y, width - x)
      default: return (x, y)
      }
    }
    let left = min(corners[0].0, corners[1].0)
    let right = max(corners[0].0, corners[1].0)
    let top = min(corners[0].1, corners[1].1)
    let bottom = max(corners[0].1, corners[1].1)
    // 换算回来的这块和直接在摆正后的图上按比例取的那块，边最多差 1 像素
    let naive = (Int(crop.x * Double(reference.width)), Int(crop.y * Double(reference.height)),
                 Int((crop.x + crop.width) * Double(reference.width)), Int((crop.y + crop.height) * Double(reference.height)))
    check(abs(left - naive.0) <= 1 && abs(top - naive.1) <= 1 && abs(right - naive.2) <= 1 && abs(bottom - naive.3) <= 1,
          "方向 \(orientation) 裁剪范围 \((left, top, right, bottom)) 和 \(naive) 差太多")
    var expected: [UInt8] = []
    for y in top..<bottom { for x in left..<right { expected += reference.pixels[((y * reference.width + x) * 3)..<((y * reference.width + x) * 3 + 3)] } }
    let cropped = try ImageInput.load(uri: url.path, crop: crop)
    check(cropped.width == right - left && cropped.height == bottom - top, "方向 \(orientation) 裁剪尺寸 \(cropped.width)×\(cropped.height)")
    check(cropped.pixels == expected, "方向 \(orientation) 裁剪内容")
  }
  // file:// 里没做百分号编码的路径也认
  let spaced = folder.appendingPathComponent("带 空格.tiff")
  try FileManager.default.copyItem(at: folder.appendingPathComponent("o1.tiff"), to: spaced)
  check((try? ImageInput.load(uri: "file://" + spaced.path, crop: nil)) != nil, "未编码的 file:// 路径")
  check((try? ImageInput.load(uri: "ph://123", crop: nil)) == nil, "不支持的 uri 报错")
} catch {
  check(false, "读图测试抛错 \(error)")
}

print(failures == 0 ? "单测通过：\(checks) 项" : "单测失败：\(failures) / \(checks) 项")
exit(failures == 0 ? 0 : 1)
