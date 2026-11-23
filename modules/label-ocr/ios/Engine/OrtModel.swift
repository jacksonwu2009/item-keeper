import Foundation

/// 一个模型的推理：输入一个 float32 张量，返回第一个输出。引擎只认这个协议。
protocol TensorModel: AnyObject {
  func run(input: [Float], shape: [Int]) throws -> (values: [Float], shape: [Int])
}

/// ONNX Runtime 会话（通过 OrtBridge/LabelOcrOrt.h 调 C API）
final class OrtModel: TensorModel {
  private let session: OpaquePointer

  /// ONNX Runtime 库的版本号
  static var runtimeVersion: String {
    String(cString: label_ocr_ort_version())
  }

  init(path: String, threads: Int) throws {
    var errorBuffer = [CChar](repeating: 0, count: 1024)
    guard let created = label_ocr_ort_create(path, Int32(threads), &errorBuffer, errorBuffer.count) else {
      throw OcrError.model("\((path as NSString).lastPathComponent)：\(String(cString: errorBuffer))")
    }
    session = created
  }

  deinit {
    label_ocr_ort_release(session)
  }

  func run(input: [Float], shape: [Int]) throws -> (values: [Float], shape: [Int]) {
    var errorBuffer = [CChar](repeating: 0, count: 1024)
    var output = LabelOcrOrtOutput()
    let inputShape = shape.map { Int64($0) }
    let status = input.withUnsafeBufferPointer { inputPointer in
      inputShape.withUnsafeBufferPointer { shapePointer in
        label_ocr_ort_run(
          session, inputPointer.baseAddress!, shapePointer.baseAddress!, shapePointer.count,
          &output, &errorBuffer, errorBuffer.count)
      }
    }
    if status != 0 {
      throw OcrError.failed(String(cString: errorBuffer))
    }
    defer { label_ocr_ort_output_free(&output) }
    let rank = Int(output.rank)
    let outputShape: [Int] = withUnsafeBytes(of: output.shape) { raw in
      Array(raw.bindMemory(to: Int64.self).prefix(rank)).map { Int($0) }
    }
    guard let data = output.data else {
      throw OcrError.failed("推理没有输出")
    }
    let values = Array(UnsafeBufferPointer(start: data, count: Int(output.count)))
    return (values, outputShape)
  }
}
