import ExpoModulesCore
import Foundation

// Expo 胶水层：只做参数转换、排队、错误码。识别本身在 Engine/（纯 Swift，不依赖 Expo / UIKit），
// 「uri → 返回给 JS 的结果」在 Engine/LabelOcrRunner.swift，macOS 上的测试工具跑的也是它。
//
// JS 接口见 modules/label-ocr/index.ts 和 src/LabelOcr.types.ts，和安卓（LabelOcrModule.kt）完全一样：
// - prepareAsync()：预先加载模型
// - recognizeAsync(uri, { crop })：识别一张本机图片，返回 OcrResult
// 出错时 reject 的 code：ERR_LABEL_OCR_IMAGE（读不了图）、ERR_LABEL_OCR_MODEL（模型缺失、加载失败）、
// ERR_LABEL_OCR_FAILED（推理出错）。
//
// 识别在自己的串行后台队列上做，同一时间只跑一个，不占 JS 线程和主线程；模型第一次用时加载，之后一直留着。
// 图片只在内存里解码，不写临时文件、不上传；调用方传进来的照片文件由调用方自己处理（和安卓一样）。

struct LabelOcrCropRecord: Record {
  @Field
  var x: Double = 0

  @Field
  var y: Double = 0

  @Field
  var width: Double = 1

  @Field
  var height: Double = 1
}

struct LabelOcrRecognizeOptions: Record {
  @Field
  var crop: LabelOcrCropRecord? = nil
}

public final class LabelOcrModule: Module {
  /// 识别用的串行队列：一次一个，排队执行
  private let queue = DispatchQueue(label: "expo.modules.labelocr", qos: .userInitiated)
  /// 只在 queue 上访问
  private let runner = LabelOcrRunner(locateModels: LabelOcrModule.modelDirectory)

  public func definition() -> ModuleDefinition {
    Name("LabelOcr")

    AsyncFunction("prepareAsync") { (promise: Promise) in
      self.queue.async {
        do {
          let loadMs = try self.runner.prepare()
          if loadMs > 0 {
            NSLog("[LabelOcr] 模型 %@ 加载用了 %.0f ms", OcrEngine.model, loadMs)
          }
          promise.resolve(nil)
        } catch {
          promise.reject(LabelOcrModule.exception(for: error))
        }
      }
    }

    AsyncFunction("recognizeAsync") { (uri: String, options: LabelOcrRecognizeOptions, promise: Promise) in
      let crop = options.crop.map { NormalizedCrop(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
      self.queue.async {
        do {
          let result = try autoreleasepool { try self.runner.recognize(uri: uri, crop: crop) }
          NSLog("%@", LabelOcrModule.summary(of: result))
          promise.resolve(result)
        } catch {
          promise.reject(LabelOcrModule.exception(for: error))
        }
      }
    }

    OnDestroy {
      self.queue.async {
        self.runner.unload()
      }
    }
  }

  /// 模型在 LabelOcrModels.bundle（podspec 的 resource_bundles）里的 PP-OCRv6_small/ 目录
  private static func modelDirectory() throws -> URL {
    let requiredFile = "det/inference.onnx"
    for bundle in [Bundle(for: LabelOcrModule.self), Bundle.main] {
      guard let bundleURL = bundle.url(forResource: "LabelOcrModels", withExtension: "bundle") else { continue }
      let directory = bundleURL.appendingPathComponent(OcrEngine.model, isDirectory: true)
      if FileManager.default.fileExists(atPath: directory.appendingPathComponent(requiredFile).path) {
        return directory
      }
      // 万一打包时目录层级变了：在资源包里找 det/inference.onnx 所在的目录
      if let enumerator = FileManager.default.enumerator(at: bundleURL, includingPropertiesForKeys: nil) {
        for case let url as URL in enumerator where url.path.hasSuffix("/" + requiredFile) {
          return url.deletingLastPathComponent().deletingLastPathComponent()
        }
      }
    }
    throw OcrError.model("安装包里没有拍照识别的模型（LabelOcrModels.bundle/\(OcrEngine.model)）")
  }

  /// 一行日志（和安卓的 Log.i 一样）：图多大、认出几行、转了几度、各段耗时
  private static func summary(of result: [String: Any]) -> String {
    let lines = (result["lines"] as? [Any])?.count ?? 0
    let timing = result["timing"] as? [String: Any] ?? [:]
    func value(_ key: String) -> String { "\(timing[key] ?? 0)" }
    return "[LabelOcr] 识别 \(result["width"] ?? 0)×\(result["height"] ?? 0)：\(lines) 行，转 \(result["rotation"] ?? 0)°，"
      + "加载 \(value("loadMs"))、读图 \(value("decodeMs"))、检测 \(value("detMs"))、识别 \(value("recMs"))、共 \(value("totalMs")) ms"
  }

  private static func exception(for error: Error) -> Exception {
    switch error {
    case OcrError.image(let message):
      return Exception(name: "LabelOcrImageException", description: "读不了这张图片：\(message)", code: "ERR_LABEL_OCR_IMAGE")
    case OcrError.model(let message):
      return Exception(name: "LabelOcrModelException", description: "识别模型加载失败：\(message)", code: "ERR_LABEL_OCR_MODEL")
    case OcrError.failed(let message):
      return Exception(name: "LabelOcrFailedException", description: "识别出错：\(message)", code: "ERR_LABEL_OCR_FAILED")
    default:
      return Exception(name: "LabelOcrFailedException", description: "识别出错：\(error)", code: "ERR_LABEL_OCR_FAILED")
    }
  }
}
