package expo.modules.labelocr

/**
 * 从模型自带的 inference.yml 里读前后处理参数。
 *
 * PaddleX 导出的 yml 结构是固定的，这里只认用得到的几项，不引整个 YAML 库：
 * - 检测 det/inference.yml：PreProcess → DecodeImage.img_mode（BGR）、NormalizeImage 的 mean / std / scale
 * - 识别 rec/inference.yml：PreProcess → DecodeImage.img_mode（BGR）、RecResizeImg.image_shape（[3, 48, 320]：高 48、补边到宽 320）、
 *   PostProcess.character_dict（字典）
 *
 * 读字典的写法照 PaddleOCR 官方安卓示例 ppocr-sdk 的 ModelConfig.kt（Apache-2.0）。
 */
internal data class DetModelConfig(
  val imgMode: String,
  val mean: FloatArray,
  val std: FloatArray,
  val scale: Float,
)

internal data class RecModelConfig(
  /** 通道顺序：DecodeImage.img_mode（BGR） */
  val imgMode: String,
  val imageHeight: Int,
  /** RecResizeImg.image_shape 的宽（320）：比这窄的行右边补 0 补到这么宽 */
  val imageWidth: Int,
  /** 字典；下标 0 对应模型输出的第 1 类（第 0 类是 CTC 的空白），末尾补一个空格（官方做法） */
  val characters: List<String>,
)

internal object ModelConfig {
  fun parseDet(text: String, source: String): DetModelConfig {
    val lines = splitLines(text)
    val decode = findKey(lines, "DecodeImage", 0) ?: throw IllegalStateException("$source 里没有 DecodeImage")
    val imgMode = scalarAfter(lines, "img_mode", decode) ?: "BGR"
    val normalize = findKey(lines, "NormalizeImage", 0) ?: throw IllegalStateException("$source 里没有 NormalizeImage")
    val mean = listAfter(lines, "mean", normalize).map { it.toFloat() }
    val std = listAfter(lines, "std", normalize).map { it.toFloat() }
    val scale = parseFraction(scalarAfter(lines, "scale", normalize) ?: "1./255.")
    require(mean.size == 3 && std.size == 3) { "$source 里 mean / std 不是 3 个数" }
    return DetModelConfig(imgMode.uppercase(), mean.toFloatArray(), std.toFloatArray(), scale)
  }

  fun parseRec(text: String, source: String): RecModelConfig {
    val lines = splitLines(text)
    val decode = findKey(lines, "DecodeImage", 0) ?: throw IllegalStateException("$source 里没有 DecodeImage")
    val imgMode = scalarAfter(lines, "img_mode", decode) ?: "BGR"
    val resize = findKey(lines, "RecResizeImg", 0) ?: throw IllegalStateException("$source 里没有 RecResizeImg")
    val shape = listAfter(lines, "image_shape", resize).map { it.toInt() }
    require(shape.size == 3) { "$source 里 image_shape 不是 3 个数" }
    val postProcess = findKey(lines, "PostProcess", 0) ?: throw IllegalStateException("$source 里没有 PostProcess")
    val characters = listAfter(lines, "character_dict", postProcess).toMutableList()
    require(characters.isNotEmpty()) { "$source 里 character_dict 是空的" }
    if (characters.last() != " ") characters.add(" ")
    return RecModelConfig(imgMode = imgMode.uppercase(), imageHeight = shape[1], imageWidth = shape[2], characters = characters)
  }

  private fun splitLines(text: String): List<String> = text.replace("\r\n", "\n").replace('\r', '\n').split('\n')

  private fun indentOf(line: String): Int = line.length - line.trimStart(' ').length

  /** 第一个「key:」（也认列表项「- key:」）所在的行号 */
  private fun findKey(lines: List<String>, key: String, from: Int): Int? {
    for (index in from until lines.size) {
      val trimmed = lines[index].trim().removePrefix("- ").trim()
      if (trimmed == "$key:" || trimmed.startsWith("$key: ")) return index
    }
    return null
  }

  /** start 行以后第一个「key: value」的 value */
  private fun scalarAfter(lines: List<String>, key: String, start: Int): String? {
    val index = findKey(lines, key, start) ?: return null
    val trimmed = lines[index].trim().removePrefix("- ").trim()
    return trimmed.substringAfter(':').trim().ifEmpty { null }
  }

  /** start 行以后第一个「key:」下面紧跟的列表（「- 值」，缩进和 key 相同或更深） */
  private fun listAfter(lines: List<String>, key: String, start: Int): List<String> {
    val keyLine = findKey(lines, key, start) ?: return emptyList()
    val keyIndent = indentOf(lines[keyLine])
    val values = mutableListOf<String>()
    var index = keyLine + 1
    while (index < lines.size) {
      val line = lines[index]
      if (line.isBlank()) {
        index++
        continue
      }
      val indent = indentOf(line)
      val content = line.substring(indent)
      if (indent < keyIndent || !content.startsWith("-")) break
      values.add(parseListScalar(content.substring(1)))
      index++
    }
    return values
  }

  private fun parseListScalar(rawValue: String): String {
    // 只去掉半角空格：字典里第一个字是全角空格「　」
    val value = rawValue.dropWhile { it == ' ' }
    if (value.length >= 2 && value.first() == '\'' && value.last() == '\'') {
      return value.substring(1, value.length - 1).replace("''", "'")
    }
    if (value.length >= 2 && value.first() == '"' && value.last() == '"') {
      return value.substring(1, value.length - 1)
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\t", "\t")
    }
    return value
  }

  /** 「1./255.」这种写法 */
  private fun parseFraction(text: String): Float {
    val parts = text.split('/')
    return if (parts.size == 2) (parts[0].toDouble() / parts[1].toDouble()).toFloat() else text.toFloat()
  }
}
