import Foundation

/// PP-OCRv6_small 的检测 + 识别，流程照 PaddleOCR 官方示例（检测 DB → 按阅读顺序排 → 每个框裁出来 → 识别 CTC），
/// 推理用 ONNX Runtime。和安卓的 OcrEngine.kt 一一对应，参数、方向判断、输出都一样：
///
/// - 检测输入：通道顺序、mean / std / scale 取自 det/inference.yml（BGR，mean 0.485/0.456/0.406，
///   std 0.229/0.224/0.225，scale 1/255）。
/// - 检测缩放：PaddleX 通用 OCR 产线（OCR.yaml）是短边不小于 64、长边不超过 4000、宽高取 32 的倍数（四舍六入五成双）；
///   手机上长边到 4000 太慢太占内存，这里长边最多 detMaxSide = 1600。识别时从更大的图（ImageInput.sourceMaxSide）里裁行。
/// - DB 后处理：thresh 0.3、box_thresh 0.6、unclip_ratio 1.5、max_candidates 3000（OCR.yaml 和官方示例的默认值）。
/// - 识别输入：高 48（rec/inference.yml 的 RecResizeImg.image_shape），宽按比例、最多 3200，一次一行。
/// - 字典：rec/inference.yml 的 PostProcess.character_dict，末尾补空格；第 0 类是 CTC 空白。
/// - 竖着的框（高 / 宽 ≥ 1.5）转 90° 再识别（官方 QuadTextCrop）。
/// - 方向：不加方向分类模型，拿字最多的三行两个方向各认一次，置信度明显高的方向就是整张图的方向；
///   不是正着的，把整张图转正再检测、识别一遍（电脑上 PaddleOCR 也是先判断整图方向、转正再检测）。
final class OcrEngine {
  static let model = "PP-OCRv6_small"
  static let detMinSide = 64
  static let detMaxSide = 1600
  static let recMaxWidth = 3200
  static let verticalRatio = 1.5
  static let dbParams = DbParams(thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, maxCandidates: 3000)

  struct Line {
    let text: String
    let score: Double
    /// 左上、右上、右下、左下，在转正以后的坐标系里
    let corners: [PointD]
  }

  struct Output {
    let lines: [Line]
    let width: Int
    let height: Int
    let rotation: Int
    let detMs: Double
    let recMs: Double
  }

  private let detModel: TensorModel
  private let recModel: TensorModel
  private let detConfig: DetModelConfig
  private let recConfig: RecModelConfig

  init(detModel: TensorModel, recModel: TensorModel, detConfig: DetModelConfig, recConfig: RecModelConfig) {
    self.detModel = detModel
    self.recModel = recModel
    self.detConfig = detConfig
    self.recConfig = recConfig
  }

  /// 从模型目录加载：目录下是 det/inference.onnx、det/inference.yml、rec/inference.onnx、rec/inference.yml
  static func load(modelDirectory: URL) throws -> OcrEngine {
    func path(_ name: String) throws -> URL {
      let url = modelDirectory.appendingPathComponent(name)
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw OcrError.model("缺少模型文件 \(model)/\(name)")
      }
      return url
    }
    func readText(_ name: String) throws -> String {
      let url = try path(name)
      guard let data = FileManager.default.contents(atPath: url.path), let text = String(data: data, encoding: .utf8)
      else {
        throw OcrError.model("读不了 \(model)/\(name)")
      }
      return text
    }
    let detConfig = try ModelConfigParser.parseDet(try readText("det/inference.yml"), source: "det/inference.yml")
    let recConfig = try ModelConfigParser.parseRec(try readText("rec/inference.yml"), source: "rec/inference.yml")
    let threads = max(1, min(4, ProcessInfo.processInfo.activeProcessorCount))
    let det = try OrtModel(path: try path("det/inference.onnx").path, threads: threads)
    let rec = try OrtModel(path: try path("rec/inference.onnx").path, threads: threads)
    return OcrEngine(detModel: det, recModel: rec, detConfig: detConfig, recConfig: recConfig)
  }

  func run(_ image: Raster) throws -> Output {
    let detStart = Clock.nowMs()
    let boxes = try detect(image)
    let firstDetMs = Clock.nowMs() - detStart
    var secondDetMs = 0.0

    let recStart = Clock.nowMs()
    var cache: [Int: (String, Double)] = [:]
    func recognize(_ index: Int, _ start: Int) throws -> (String, Double) {
      let key = index * 4 + start
      if let cached = cache[key] { return cached }
      let result = try recognizeCrop(image.cropQuad(rotated(boxes[index], start)))
      cache[key] = result
      return result
    }

    let vertical = boxes.indices.filter { isVertical(boxes[$0]) }
    let horizontal = boxes.indices.filter { !isVertical(boxes[$0]) }
    // start 是从框的第几个角开始当左上角：0 不转，1 逆时针转 90°，2 转 180°，3 顺时针转 90°
    let pageStart = vertical.count > horizontal.count
      ? try vote(boxes, vertical, defaultStart: 1, otherStart: 3, recognize)
      : try vote(boxes, horizontal, defaultStart: 0, otherStart: 2, recognize)
    // 为了让字正过来，整张图顺时针转了多少度
    let rotation: Int
    switch pageStart {
    case 1: rotation = 270
    case 2: rotation = 180
    case 3: rotation = 90
    default: rotation = 0
    }

    var lines: [Line] = []
    let page: Raster
    if rotation == 0 {
      // 字是正的：照官方，竖着的框逆时针转 90° 再认
      page = image
      for index in boxes.indices {
        let start = isVertical(boxes[index]) ? 1 : 0
        let (text, score) = try recognize(index, start)
        if !isBlank(text) {
          lines.append(Line(text: text, score: score, corners: rotated(boxes[index], start)))
        }
      }
    } else {
      // 包装侧着或倒着拍：整张图转正再检测一遍（检测模型对正着的字准得多：侧着检测时漏行、并行），
      // 相当于电脑上 PaddleOCR 先做整图方向判断再检测
      let secondStart = Clock.nowMs()
      page = image.rotatedClockwise(rotation)
      let uprightBoxes = try detect(page)
      secondDetMs = Clock.nowMs() - secondStart
      for box in uprightBoxes {
        let corners = rotated(box, isVertical(box) ? 1 : 0)
        let (text, score) = try recognizeCrop(page.cropQuad(corners))
        if !isBlank(text) {
          lines.append(Line(text: text, score: score, corners: corners))
        }
      }
    }
    // 识别时间含判断方向；转正后的第二次检测算进检测时间
    let recMs = Clock.nowMs() - recStart - secondDetMs
    let order = DbPostProcess.sortReadingOrder(lines.map(\.corners))
    return Output(
      lines: order.map { lines[$0] }, width: page.width, height: page.height,
      rotation: rotation, detMs: firstDetMs + secondDetMs, recMs: recMs)
  }

  /// 和 Kotlin 的 isBlank 一样：空的或全是空白（含全角空格）
  private func isBlank(_ text: String) -> Bool {
    text.unicodeScalars.allSatisfy { $0.properties.isWhitespace }
  }

  private func isVertical(_ box: [PointD]) -> Bool {
    let width = Geometry.distance(box[0], box[1])
    let height = Geometry.distance(box[0], box[3])
    return width > 0 && height / width >= OcrEngine.verticalRatio
  }

  private func rotated(_ box: [PointD], _ start: Int) -> [PointD] {
    (0..<4).map { box[(start + $0) % 4] }
  }

  /// 字最多（框最大）的三行，两个方向各认一次，置信度明显高的那个方向赢；差不多时用默认方向
  private func vote(
    _ boxes: [[PointD]], _ indices: [Int], defaultStart: Int, otherStart: Int,
    _ recognize: (Int, Int) throws -> (String, Double)
  ) throws -> Int {
    if indices.isEmpty { return defaultStart }
    func area(_ index: Int) -> Double {
      let box = boxes[index]
      return Geometry.distance(box[0], box[1]) * Geometry.distance(box[0], box[3])
    }
    // 稳定的从大到小排序（面积相同时按原来的顺序），和 Kotlin sortedByDescending 一样
    let sample = indices.enumerated()
      .sorted { left, right in
        let (a, b) = (area(left.element), area(right.element))
        return a != b ? a > b : left.offset < right.offset
      }
      .prefix(3)
      .map(\.element)
    var defaultScore = 0.0
    var otherScore = 0.0
    for index in sample {
      defaultScore += try recognize(index, defaultStart).1
      otherScore += try recognize(index, otherStart).1
    }
    return otherScore > defaultScore + 0.05 * Double(sample.count) ? otherStart : defaultStart
  }

  private func detect(_ image: Raster) throws -> [[PointD]] {
    let (prob, predW, predH) = try probabilityMap(image)
    let boxes = DbPostProcess.process(
      prob: prob, predW: predW, predH: predH, srcW: image.width, srcH: image.height, params: OcrEngine.dbParams)
    // 和官方一样先按阅读顺序排（方向定了以后在新坐标里再排一次）
    return DbPostProcess.sortReadingOrder(boxes).map { boxes[$0] }
  }

  /// 检测模型的输出：每个点是文字的概率（predH × predW，按行）。测试工具也直接用它对照 PaddleOCR 的概率图
  func probabilityMap(_ image: Raster) throws -> (prob: [Float], width: Int, height: Int) {
    var ratio = 1.0
    let shortSide = min(image.width, image.height)
    if shortSide < OcrEngine.detMinSide {
      ratio = Double(OcrEngine.detMinSide) / Double(shortSide)
    }
    var resizedW = Int(Double(image.width) * ratio)
    var resizedH = Int(Double(image.height) * ratio)
    if max(resizedW, resizedH) > OcrEngine.detMaxSide {
      let shrink = Double(OcrEngine.detMaxSide) / Double(max(resizedW, resizedH))
      resizedW = Int(Double(resizedW) * shrink)
      resizedH = Int(Double(resizedH) * shrink)
    }
    let detW = max(Geometry.roundHalfToEven(Double(resizedW) / 32.0) * 32, 32)
    let detH = max(Geometry.roundHalfToEven(Double(resizedH) / 32.0) * 32, 32)
    let tensor = image.toTensor(
      dstW: detW, dstH: detH, order: detConfig.imgMode, scale: detConfig.scale, mean: detConfig.mean,
      std: detConfig.std)
    let (prob, shape) = try detModel.run(input: tensor, shape: [1, 3, detH, detW])
    guard shape.count >= 2, prob.count >= shape[shape.count - 2] * shape[shape.count - 1] else {
      throw OcrError.failed("检测模型输出形状不对：\(shape)")
    }
    return (prob, shape[shape.count - 1], shape[shape.count - 2])
  }

  /// 识别一行（已经裁好、转正的小图）。测试工具也直接用它对照 PaddleOCR 的识别
  func recognizeCrop(_ crop: Raster) throws -> (String, Double) {
    let (tensor, width) = crop.toRecTensor(height: recConfig.imageHeight, maxWidth: OcrEngine.recMaxWidth)
    let (output, shape) = try recModel.run(input: tensor, shape: [1, 3, recConfig.imageHeight, width])
    guard shape.count == 3 else {
      throw OcrError.failed("识别模型输出形状不对：\(shape)")
    }
    return CtcDecoder.decode(output, steps: shape[1], classes: shape[2], characters: recConfig.characters)
  }
}

/// CTC 贪心解码：每一步取概率最大的类，去掉空白（第 0 类）和连着重复的；置信度是留下的字的概率平均（照官方 CTCDecoder）。
/// 置信度保留 3 位小数（和安卓一样）。
enum CtcDecoder {
  static func decode(_ output: [Float], steps: Int, classes: Int, characters: [String]) -> (String, Double) {
    var text = ""
    var probabilitySum = 0.0
    var kept = 0
    var previous = -1
    output.withUnsafeBufferPointer { values in
      for step in 0..<steps {
        let offset = step * classes
        var best = 0
        var bestValue = values[offset]
        if classes > 1 {
          for cls in 1..<classes {
            let value = values[offset + cls]
            if value > bestValue {
              bestValue = value
              best = cls
            }
          }
        }
        if best != 0 && best != previous && best - 1 < characters.count {
          text += characters[best - 1]
          probabilitySum += Double(bestValue)
          kept += 1
        }
        previous = best
      }
    }
    let score = kept == 0 ? 0.0 : probabilitySum / Double(kept)
    return (text, Double(roundHalfUp(score * 1000)) / 1000.0)
  }
}
