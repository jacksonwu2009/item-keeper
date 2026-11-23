import Foundation

/// 「图片 uri → 返回给 JS 的结果」这一整段：第一次用时加载模型、读图、识别、拼结果、计时。
/// Expo 模块（LabelOcrModule.swift）和 macOS 上的测试工具（tests/cli）都调它，所以测试覆盖到的就是 App 里跑的代码。
///
/// 不是线程安全的：调用方保证同一时间只有一个调用（模块里放在一个串行队列上）。
final class LabelOcrRunner {
  private let locateModels: () throws -> URL
  private var engine: OcrEngine?

  /// locateModels 返回模型目录（下面是 det/、rec/）。只在第一次加载时调用
  init(locateModels: @escaping () throws -> URL) {
    self.locateModels = locateModels
  }

  /// 加载模型（已经加载过什么也不做），返回加载用的毫秒数（已加载过是 0）
  @discardableResult
  func prepare() throws -> Double {
    if engine != nil { return 0 }
    let start = Clock.nowMs()
    do {
      engine = try OcrEngine.load(modelDirectory: try locateModels())
    } catch let error as OcrError {
      if case .model = error { throw error }
      throw OcrError.model(error.description)
    } catch {
      throw OcrError.model("\(error)")
    }
    return Clock.nowMs() - start
  }

  /// 释放模型（内存紧张时）
  func unload() {
    engine = nil
  }

  /// 识别一张本机图片，返回和安卓一样结构的字典（见 modules/label-ocr/src/LabelOcr.types.ts 的 OcrResult）
  func recognize(uri: String, crop: NormalizedCrop?) throws -> [String: Any] {
    let totalStart = Clock.nowMs()
    let loadMs = try prepare()
    guard let engine else {
      throw OcrError.model("模型没有加载")
    }

    let decodeStart = Clock.nowMs()
    let raster: Raster
    do {
      raster = try ImageInput.load(uri: uri, crop: crop)
    } catch let error as OcrError {
      if case .image = error { throw error }
      throw OcrError.image(error.description)
    } catch {
      throw OcrError.image("\(error)")
    }
    let decodeMs = Clock.nowMs() - decodeStart

    let output: OcrEngine.Output
    do {
      output = try engine.run(raster)
    } catch let error as OcrError {
      throw error
    } catch {
      throw OcrError.failed("\(error)")
    }
    let totalMs = Clock.nowMs() - totalStart
    return [
      "lines": output.lines.map { line -> [String: Any] in
        [
          "text": line.text,
          "score": line.score,
          "box": line.corners.map { [roundHalfUp($0.x), roundHalfUp($0.y)] },
        ]
      },
      "width": output.width,
      "height": output.height,
      "rotation": output.rotation,
      "model": OcrEngine.model,
      "timing": [
        "loadMs": Int(loadMs.rounded()),
        "decodeMs": Int(decodeMs.rounded()),
        "detMs": Int(output.detMs.rounded()),
        "recMs": Int(output.recMs.rounded()),
        "totalMs": Int(totalMs.rounded()),
      ],
    ]
  }
}
