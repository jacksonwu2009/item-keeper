import Foundation

// 分阶段对照工具：每一段吃和 PaddleOCR 完全相同的输入（paddle_stages.py 生成），单独检查这一段的结果。
// 和 App 用的是同一份 ios/Engine/ 代码。
//
// 用法：label-ocr-stages --models <模型目录> --stages <paddle_stages.py 的输出目录> --out <结果.json>
//
// 每张照片三段：
// 1. 检测：同一张 input.png → 手机端的缩放 + 归一化 + ONNX 检测模型 → 概率图，和 PaddleOCR（Paddle 推理）的概率图比数值；
// 2. 检测后处理：PaddleOCR 的概率图 prob.bin → 手机端的 DbPostProcess → 框（和 PaddleX 的框由 stage_compare.py 对照）；
// 3. 识别：PaddleX 裁好的每一行 crop-XXX.png → 手机端的识别预处理 + ONNX 识别模型 + CTC 解码 → 文字、置信度；
// 4. 识别模型本身：PaddleOCR 给识别模型的同一个输入张量 → 手机端的 ONNX Runtime 调用 → 输出和 Paddle 推理的输出比数值，
//    两边输出都用手机端的 CTC 解码，再和 PaddleOCR 自己解出来的文字比。

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(2)
}

var modelsPath: String?
var stagesPath: String?
var outPath: String?
var arguments = CommandLine.arguments.dropFirst()
while let argument = arguments.popFirst() {
  switch argument {
  case "--models": modelsPath = arguments.popFirst()
  case "--stages": stagesPath = arguments.popFirst()
  case "--out": outPath = arguments.popFirst()
  default: fail("不认识的参数 \(argument)")
  }
}
guard let modelsPath, let stagesPath, let outPath else {
  fail("用法：label-ocr-stages --models <模型目录> --stages <目录> --out <结果.json>")
}

let engine: OcrEngine
do {
  engine = try OcrEngine.load(modelDirectory: URL(fileURLWithPath: modelsPath, isDirectory: true))
} catch {
  fail("加载模型失败：\(error)")
}

// 单独加载一份识别模型和字典，给第 4 段用
let recModel: OrtModel
let characters: [String]
do {
  let models = URL(fileURLWithPath: modelsPath, isDirectory: true)
  recModel = try OrtModel(path: models.appendingPathComponent("rec/inference.onnx").path, threads: 4)
  let yml = try String(contentsOf: models.appendingPathComponent("rec/inference.yml"), encoding: .utf8)
  characters = try ModelConfigParser.parseRec(yml, source: "rec/inference.yml").characters
} catch {
  fail("加载识别模型失败：\(error)")
}

func readFloats(_ url: URL) -> [Float]? {
  guard let data = FileManager.default.contents(atPath: url.path) else { return nil }
  return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
}

let fileManager = FileManager.default
let stagesURL = URL(fileURLWithPath: stagesPath, isDirectory: true)
let photos = (try? fileManager.contentsOfDirectory(atPath: stagesPath))?.sorted() ?? []
var output: [String: Any] = [:]

for photo in photos {
  let folder = stagesURL.appendingPathComponent(photo, isDirectory: true)
  guard let metaData = fileManager.contents(atPath: folder.appendingPathComponent("prob.json").path),
    let meta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any],
    let predW = meta["predW"] as? Int, let predH = meta["predH"] as? Int,
    let srcW = meta["srcW"] as? Int, let srcH = meta["srcH"] as? Int
  else { continue }
  var entry: [String: Any] = [:]

  // 2. 检测后处理：PaddleOCR 的概率图 → 框
  guard let probData = fileManager.contents(atPath: folder.appendingPathComponent("prob.bin").path),
    probData.count == predW * predH * 4
  else { fail("\(photo)/prob.bin 大小不对") }
  let paddleProb: [Float] = probData.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
  let boxes = DbPostProcess.process(
    prob: paddleProb, predW: predW, predH: predH, srcW: srcW, srcH: srcH, params: OcrEngine.dbParams)
  let ordered = DbPostProcess.sortReadingOrder(boxes).map { boxes[$0] }
  entry["dbBoxes"] = ordered.map { box in box.map { [roundHalfUp($0.x), roundHalfUp($0.y)] } }

  // 1. 检测：同一张图 → 概率图，和 PaddleOCR 的比
  do {
    let input = try ImageInput.load(uri: folder.appendingPathComponent("input.png").path, crop: nil)
    let (prob, width, height) = try engine.probabilityMap(input)
    if width == predW && height == predH {
      var maxDiff: Float = 0
      var sumDiff: Double = 0
      var maskFlips = 0
      var foreground = 0
      for index in 0..<(width * height) {
        let diff = abs(prob[index] - paddleProb[index])
        maxDiff = max(maxDiff, diff)
        sumDiff += Double(diff)
        let mine = Double(prob[index]) > OcrEngine.dbParams.thresh
        let theirs = Double(paddleProb[index]) > OcrEngine.dbParams.thresh
        if mine != theirs { maskFlips += 1 }
        if theirs { foreground += 1 }
      }
      entry["prob"] = [
        "size": [width, height],
        "maxAbsDiff": Double(maxDiff),
        "meanAbsDiff": sumDiff / Double(width * height),
        "maskFlips": maskFlips,
        "foreground": foreground,
      ]
      // 手机端自己的概率图 + 手机端后处理（就是 App 里的检测）
      let ownBoxes = DbPostProcess.process(
        prob: prob, predW: width, predH: height, srcW: input.width, srcH: input.height, params: OcrEngine.dbParams)
      entry["ownBoxes"] = DbPostProcess.sortReadingOrder(ownBoxes).map { index in
        ownBoxes[index].map { [roundHalfUp($0.x), roundHalfUp($0.y)] }
      }
    } else {
      entry["prob"] = ["size": [width, height], "error": "大小和 PaddleOCR 的不一样（\(predW)×\(predH)）"]
    }
  } catch {
    entry["prob"] = ["error": "\(error)"]
  }

  // 3. 识别：PaddleX 裁好的行 → 文字
  var recognized: [[String: Any]] = []
  let crops = ((try? fileManager.contentsOfDirectory(atPath: folder.path)) ?? [])
    .filter { $0.hasPrefix("crop-") && $0.hasSuffix(".png") }
    .sorted()
  for crop in crops {
    do {
      let raster = try ImageInput.load(uri: folder.appendingPathComponent(crop).path, crop: nil)
      let (text, score) = try engine.recognizeCrop(raster)
      recognized.append(["file": crop, "text": text, "score": score])
    } catch {
      recognized.append(["file": crop, "error": "\(error)"])
    }
  }
  entry["rec"] = recognized

  // 4. 识别模型本身：同一个输入张量
  var modelRows: [[String: Any]] = []
  if let recData = fileManager.contents(atPath: folder.appendingPathComponent("rec.json").path),
    let recEntries = try? JSONSerialization.jsonObject(with: recData) as? [[String: Any]]
  {
    for (index, recEntry) in recEntries.enumerated() {
      guard let inputShape = recEntry["inputShape"] as? [Int], let outputShape = recEntry["outputShape"] as? [Int],
        let input = readFloats(folder.appendingPathComponent(String(format: "rec-%03d-input.bin", index))),
        let paddleOutput = readFloats(folder.appendingPathComponent(String(format: "rec-%03d-output.bin", index)))
      else { continue }
      do {
        let (values, shape) = try recModel.run(input: input, shape: inputShape)
        var maxDiff: Float = 0
        if shape == outputShape {
          for i in 0..<values.count { maxDiff = max(maxDiff, abs(values[i] - paddleOutput[i])) }
        }
        let ours = CtcDecoder.decode(values, steps: shape[1], classes: shape[2], characters: characters)
        let theirs = CtcDecoder.decode(
          paddleOutput, steps: outputShape[1], classes: outputShape[2], characters: characters)
        modelRows.append([
          "shapeSame": shape == outputShape, "maxAbsDiff": Double(maxDiff),
          "ortText": ours.0, "ortScore": ours.1, "paddleOutputText": theirs.0, "paddleOutputScore": theirs.1,
          "paddleText": recEntry["text"] as? String ?? "",
        ])
      } catch {
        modelRows.append(["error": "\(error)"])
      }
    }
  }
  entry["recModel"] = modelRows
  output[photo] = entry
  print("\(photo)：框 \(ordered.count) 个，识别 \(recognized.count) 行")
}

do {
  let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: URL(fileURLWithPath: outPath))
} catch {
  fail("写不了 \(outPath)：\(error)")
}
fflush(stdout)
_exit(0)
