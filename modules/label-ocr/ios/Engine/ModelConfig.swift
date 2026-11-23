import Foundation

/// 检测模型 det/inference.yml 里用到的前处理参数
struct DetModelConfig {
  /// 通道顺序，"BGR" 或 "RGB"（DecodeImage.img_mode）
  let imgMode: String
  let mean: [Float]
  let std: [Float]
  let scale: Float
}

/// 识别模型 rec/inference.yml 里用到的参数
struct RecModelConfig {
  /// 输入高度（RecResizeImg.image_shape 的第二个数，48）
  let imageHeight: Int
  /// 字典；下标 0 对应模型输出的第 1 类（第 0 类是 CTC 的空白），末尾补一个空格（官方做法）
  let characters: [String]
}

/// 从模型自带的 inference.yml 里读前后处理参数。
///
/// PaddleX 导出的 yml 结构固定，这里只认用得到的几项，不引整个 YAML 库。写法和安卓的 ModelConfig.kt 一一对应，
/// 两边读出来的字典、参数必须一样：
/// - 检测：PreProcess → DecodeImage.img_mode（BGR）、NormalizeImage 的 mean / std / scale
/// - 识别：PreProcess → RecResizeImg.image_shape（[3, 48, 320]，取高 48）、PostProcess.character_dict（字典）
enum ModelConfigParser {
  static func parseDet(_ text: String, source: String) throws -> DetModelConfig {
    let lines = splitLines(text)
    guard let decode = findKey(lines, "DecodeImage", from: 0) else {
      throw OcrError.model("\(source) 里没有 DecodeImage")
    }
    let imgMode = scalarAfter(lines, "img_mode", from: decode) ?? "BGR"
    guard let normalize = findKey(lines, "NormalizeImage", from: 0) else {
      throw OcrError.model("\(source) 里没有 NormalizeImage")
    }
    let mean = listAfter(lines, "mean", from: normalize).compactMap { Float($0) }
    let std = listAfter(lines, "std", from: normalize).compactMap { Float($0) }
    let scale = parseFraction(scalarAfter(lines, "scale", from: normalize) ?? "1./255.")
    guard mean.count == 3, std.count == 3, let scale else {
      throw OcrError.model("\(source) 里 mean / std / scale 不对")
    }
    return DetModelConfig(imgMode: imgMode.uppercased(), mean: mean, std: std, scale: scale)
  }

  static func parseRec(_ text: String, source: String) throws -> RecModelConfig {
    let lines = splitLines(text)
    guard let resize = findKey(lines, "RecResizeImg", from: 0) else {
      throw OcrError.model("\(source) 里没有 RecResizeImg")
    }
    let shape = listAfter(lines, "image_shape", from: resize).compactMap { Int($0) }
    guard shape.count == 3 else {
      throw OcrError.model("\(source) 里 image_shape 不是 3 个数")
    }
    guard let postProcess = findKey(lines, "PostProcess", from: 0) else {
      throw OcrError.model("\(source) 里没有 PostProcess")
    }
    var characters = listAfter(lines, "character_dict", from: postProcess)
    guard !characters.isEmpty else {
      throw OcrError.model("\(source) 里 character_dict 是空的")
    }
    if characters.last != " " {
      characters.append(" ")
    }
    return RecModelConfig(imageHeight: shape[1], characters: characters)
  }

  private static func splitLines(_ text: String) -> [String] {
    text.replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
      .components(separatedBy: "\n")
  }

  /// 行首半角空格的个数
  private static func indentOf(_ line: String) -> Int {
    line.unicodeScalars.prefix(while: { $0 == " " }).count
  }

  private static func trimmedKeyLine(_ line: String) -> String {
    var trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("- ") {
      trimmed.removeFirst(2)
    }
    return trimmed.trimmingCharacters(in: .whitespaces)
  }

  /// 第一个「key:」（也认列表项「- key:」）所在的行号
  private static func findKey(_ lines: [String], _ key: String, from start: Int) -> Int? {
    guard start < lines.count else { return nil }
    for index in start..<lines.count {
      let trimmed = trimmedKeyLine(lines[index])
      if trimmed == "\(key):" || trimmed.hasPrefix("\(key): ") {
        return index
      }
    }
    return nil
  }

  /// start 行以后第一个「key: value」的 value
  private static func scalarAfter(_ lines: [String], _ key: String, from start: Int) -> String? {
    guard let index = findKey(lines, key, from: start) else { return nil }
    let trimmed = trimmedKeyLine(lines[index])
    guard let colon = trimmed.firstIndex(of: ":") else { return nil }
    let value = trimmed[trimmed.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    return value.isEmpty ? nil : value
  }

  /// start 行以后第一个「key:」下面紧跟的列表（「- 值」，缩进和 key 相同或更深）。
  /// 按 Unicode 码位处理，不按 Swift 的字符（字素簇）：字典里有「ﾞ」这类附加符号，
  /// 按字符算会和前面的空格粘成一个，去不掉空格（安卓按 UTF-16 处理，没有这个问题）。
  private static func listAfter(_ lines: [String], _ key: String, from start: Int) -> [String] {
    guard let keyLine = findKey(lines, key, from: start) else { return [] }
    let keyIndent = indentOf(lines[keyLine])
    var values: [String] = []
    var index = keyLine + 1
    while index < lines.count {
      let line = lines[index]
      if line.unicodeScalars.allSatisfy({ $0.properties.isWhitespace }) {
        index += 1
        continue
      }
      let indent = indentOf(line)
      let content = line.unicodeScalars.dropFirst(indent)
      if indent < keyIndent || content.first != "-" {
        break
      }
      values.append(parseListScalar(content.dropFirst()))
      index += 1
    }
    return values
  }

  private static func parseListScalar(_ rawValue: Substring.UnicodeScalarView) -> String {
    // 只去掉半角空格：字典里有一个字是全角空格「　」
    let value = rawValue.drop(while: { $0 == " " })
    if value.count >= 2, value.first == "'", value.last == "'" {
      return String(String.UnicodeScalarView(value.dropFirst().dropLast())).replacingOccurrences(of: "''", with: "'")
    }
    if value.count >= 2, value.first == "\"", value.last == "\"" {
      return String(String.UnicodeScalarView(value.dropFirst().dropLast()))
        .replacingOccurrences(of: "\\\"", with: "\"")
        .replacingOccurrences(of: "\\\\", with: "\\")
        .replacingOccurrences(of: "\\n", with: "\n")
        .replacingOccurrences(of: "\\r", with: "\r")
        .replacingOccurrences(of: "\\t", with: "\t")
    }
    return String(String.UnicodeScalarView(value))
  }

  /// 「1./255.」这种写法
  private static func parseFraction(_ text: String) -> Float? {
    let parts = text.split(separator: "/", omittingEmptySubsequences: false)
    if parts.count == 2, let numerator = Double(parts[0]), let denominator = Double(parts[1]) {
      return Float(numerator / denominator)
    }
    return Float(text)
  }
}
