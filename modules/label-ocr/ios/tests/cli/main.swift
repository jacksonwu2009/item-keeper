import Foundation

// macOS 上的命令行测试工具：把 ios/Engine/ 里的纯 Swift 引擎（和 App 里同一份代码）+ ONNX Runtime 编译成可执行文件，
// 对一批照片跑识别，结果写成 JSON（结构和 JS 拿到的 OcrResult 一样）。不打进 App。
//
// 用法：label-ocr-cli --models <模型目录> --out <结果.json> [--repeat N] [--crop x,y,w,h] 图片...
//   --models  下面是 det/、rec/ 的目录（modules/label-ocr/models/PP-OCRv6_small）
//   --repeat  每张图跑几次（第一次含加载模型），结果取最后一次，耗时每次都记下
//   --crop    只认图里的一块（0–1 比例，和 JS 的 crop 一样）

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(2)
}

var modelsPath: String?
var outPath: String?
var repeatCount = 1
var crop: NormalizedCrop?
var images: [String] = []

var arguments = CommandLine.arguments.dropFirst()
while let argument = arguments.popFirst() {
  switch argument {
  case "--models": modelsPath = arguments.popFirst()
  case "--out": outPath = arguments.popFirst()
  case "--repeat": repeatCount = Int(arguments.popFirst() ?? "") ?? 1
  case "--crop":
    let parts = (arguments.popFirst() ?? "").split(separator: ",").compactMap { Double($0) }
    guard parts.count == 4 else { fail("--crop 要四个数：x,y,width,height") }
    crop = NormalizedCrop(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
  default: images.append(argument)
  }
}
guard let modelsPath, let outPath, !images.isEmpty else {
  fail("用法：label-ocr-cli --models <模型目录> --out <结果.json> [--repeat N] [--crop x,y,w,h] 图片...")
}

let runner = LabelOcrRunner(locateModels: { URL(fileURLWithPath: modelsPath, isDirectory: true) })
var results: [String: Any] = [
  "_meta": [
    "onnxruntime": OrtModel.runtimeVersion,
    "model": OcrEngine.model,
    "crop": crop.map { [$0.x, $0.y, $0.width, $0.height] } as Any,
  ]
]
var timings: [String: Any] = [:]

for image in images {
  let name = (image as NSString).lastPathComponent
  var runs: [[String: Any]] = []
  var last: [String: Any] = [:]
  for _ in 0..<max(repeatCount, 1) {
    do {
      last = try runner.recognize(uri: URL(fileURLWithPath: image).absoluteString, crop: crop)
    } catch {
      results[name] = ["error": "\(error)"]
      print("\(name)：出错 \(error)")
      break
    }
    runs.append(last["timing"] as? [String: Any] ?? [:])
  }
  if !last.isEmpty {
    results[name] = last
    let lines = last["lines"] as? [[String: Any]] ?? []
    let timing = last["timing"] as? [String: Any] ?? [:]
    print(
      "\(name)：\(lines.count) 行，转 \(last["rotation"] ?? 0)°，\(last["width"] ?? 0)×\(last["height"] ?? 0)，"
        + "读图 \(timing["decodeMs"] ?? 0)、检测 \(timing["detMs"] ?? 0)、识别 \(timing["recMs"] ?? 0)、共 \(timing["totalMs"] ?? 0) ms")
  }
  timings[name] = runs
}
results["_timings"] = timings

do {
  let data = try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: URL(fileURLWithPath: outPath))
} catch {
  fail("写不了 \(outPath)：\(error)")
}
// 直接结束进程，不跑 C++ 的全局析构：ONNX Runtime 的 macOS 动态库在进程正常退出时析构顺序有问题，
// 会报「mutex lock failed」崩溃（App 里不会退出进程，不受影响）
fflush(stdout)
_exit(0)
