package expo.modules.labelocr

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.os.SystemClock
import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * PP-OCRv6_small 的检测 + 识别，流程照 PaddleOCR 官方安卓示例 deploy/ppocr-android（ppocr-sdk 的 OCREngine）：
 * 检测（DB）→ 按阅读顺序排 → 每个框裁出来 → 识别（CTC）。推理用 ONNX Runtime。
 *
 * 参数和出处：
 * - 检测输入：通道顺序、mean / std / scale 取自 det/inference.yml 的 DecodeImage、NormalizeImage
 *   （BGR，mean 0.485/0.456/0.406，std 0.229/0.224/0.225，scale 1/255）。
 * - 检测缩放：PaddleX 通用 OCR 产线（pipelines/OCR.yaml）和官方安卓示例是短边不小于 64、长边不超过 4000、
 *   宽高取 32 的倍数（四舍六入五成双）；手机上长边到 4000 太慢太占内存，这里长边最多 DET_MAX_SIDE = 1600。
 *   识别时从更大的原图（ImageInput.SOURCE_MAX_SIDE）里裁行，小字不受影响。
 * - DB 后处理：thresh 0.3、box_thresh 0.6、unclip_ratio 1.5、max_candidates 3000，取自 OCR.yaml 和官方安卓示例
 *   PaddleOCRConfig 的默认值（第一轮电脑上的准确率试验也是这组）。det/inference.yml 里的 PostProcess
 *   （0.2 / 0.45 / 1.4）是单独用检测模块时的默认，产线会覆盖，这里不用。
 * - 识别输入：照 PaddleX 的 OCRReisizeNormImg（不是官方安卓示例的写法，那个和 PaddleOCR 认出的字对不上）：
 *   高、补边宽取自 rec/inference.yml 的 RecResizeImg.image_shape（48、320），通道顺序取自 DecodeImage.img_mode（BGR）；
 *   张量宽 = int(48 × max(320/48, 宽高比))，最多 3200；图缩到 min(ceil(48 × 宽高比), 张量宽) 宽，右边补 0；
 *   (x / 255 − 0.5) / 0.5；一次一行（官方示例 recBatchSize = 1）。
 * - 拍日期的小取景框（裁过的小图）：检测时长边最多 CROP_DET_MAX_SIDE = 960。喷码的字在小图里很大，
 *   iOS 那边的放大试验里同一块喷码缩到 384–768 宽能认出日期，192 宽、1536 宽都认不出；相机原图裁出来一千多宽。
 * - 字典：rec/inference.yml 的 PostProcess.character_dict，末尾补空格；第 0 类是 CTC 空白。
 * - 竖着的框（高 / 宽 ≥ 1.5）转 90° 再识别（官方 QuadTextCrop）。
 *
 * 和官方示例不一样的地方：官方没有判断方向，包装侧着拍时（字是竖的）转的方向可能反了、整张倒着拍也认不出。
 * 这里不加方向分类模型（省安装包），而是拿字最多的几行两个方向各认一次，置信度高的那个方向就是整张图的方向；
 * 不是正着的，把整张图转正再检测、识别一遍（电脑上 PaddleOCR 也是先判断整图方向、转正再检测）。
 */
internal class OcrEngine private constructor(
  private val env: OrtEnvironment,
  private val detSession: OrtSession,
  private val recSession: OrtSession,
  private val detConfig: DetModelConfig,
  private val recConfig: RecModelConfig,
) : AutoCloseable {
  class Line(val text: String, val score: Double, val corners: List<PointD>)

  class Output(
    val lines: List<Line>,
    val width: Int,
    val height: Int,
    val rotation: Int,
    val detMs: Long,
    val recMs: Long,
  )

  companion object {
    const val MODEL = "PP-OCRv6_small"
    private const val ASSET_DIR = "PP-OCRv6_small"
    private const val DET_MIN_SIDE = 64
    private const val DET_MAX_SIDE = 1600
    private const val CROP_DET_MAX_SIDE = 960
    private const val REC_MAX_WIDTH = 3200
    private const val VERTICAL_RATIO = 1.5
    private val DB_PARAMS = DbParams(thresh = 0.3, boxThresh = 0.6, unclipRatio = 1.5, maxCandidates = 3000)

    fun load(context: Context): OcrEngine {
      val assets = context.assets
      fun readBytes(path: String): ByteArray = assets.open("$ASSET_DIR/$path").use { it.readBytes() }
      fun readText(path: String): String = String(readBytes(path), Charsets.UTF_8)
      val detConfig = ModelConfig.parseDet(readText("det/inference.yml"), "det/inference.yml")
      val recConfig = ModelConfig.parseRec(readText("rec/inference.yml"), "rec/inference.yml")
      val env = OrtEnvironment.getEnvironment()
      val threads = minOf(4, Runtime.getRuntime().availableProcessors()).coerceAtLeast(1)
      OrtSession.SessionOptions().use { options ->
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        options.setIntraOpNumThreads(threads)
        // 输入大小每次不一样：不留内存池，识别完把大块内存还给系统
        options.setCPUArenaAllocator(false)
        options.setMemoryPatternOptimization(false)
        val det = env.createSession(readBytes("det/inference.onnx"), options)
        val rec = try {
          env.createSession(readBytes("rec/inference.onnx"), options)
        } catch (error: Throwable) {
          det.close()
          throw error
        }
        return OcrEngine(env, det, rec, detConfig, recConfig)
      }
    }
  }

  private val detInput = detSession.inputNames.first()
  private val recInput = recSession.inputNames.first()

  /** cropped：是不是拍日期小取景框裁出来的图（检测时长边限得更小） */
  fun run(image: Raster, cropped: Boolean = false): Output {
    val detMaxSide = if (cropped) CROP_DET_MAX_SIDE else DET_MAX_SIDE
    val detStart = SystemClock.elapsedRealtime()
    val boxes = detect(image, detMaxSide)
    val firstDetMs = SystemClock.elapsedRealtime() - detStart
    var secondDetMs = 0L

    val recStart = SystemClock.elapsedRealtime()
    val cache = HashMap<Long, Pair<String, Double>>()
    fun recognize(index: Int, start: Int): Pair<String, Double> =
      cache.getOrPut(index * 4L + start) { recognizeCrop(image.cropQuad(rotated(boxes[index], start))) }

    val vertical = boxes.indices.filter { isVertical(boxes[it]) }
    val horizontal = boxes.indices.filter { !isVertical(boxes[it]) }
    // start 是从框的第几个角开始当左上角：0 不转，1 逆时针转 90°，2 转 180°，3 顺时针转 90°
    val pageStart = if (vertical.size > horizontal.size) {
      vote(boxes, vertical, 1, 3, ::recognize)
    } else {
      vote(boxes, horizontal, 0, 2, ::recognize)
    }
    // 为了让字正过来，整张图顺时针转了多少度
    val rotation = when (pageStart) {
      1 -> 270
      2 -> 180
      3 -> 90
      else -> 0
    }

    val lines = ArrayList<Line>()
    val page: Raster
    if (rotation == 0) {
      // 字是正的：照官方，竖着的框逆时针转 90° 再认
      page = image
      for (index in boxes.indices) {
        val start = if (isVertical(boxes[index])) 1 else 0
        val (text, score) = recognize(index, start)
        if (text.isNotBlank()) lines.add(Line(text, score, rotated(boxes[index], start)))
      }
    } else {
      // 包装侧着或倒着拍：整张图转正再检测一遍（检测模型对正着的字准得多：侧着检测时漏行、并行），
      // 相当于电脑上 PaddleOCR 先做整图方向判断再检测
      val secondStart = SystemClock.elapsedRealtime()
      page = image.rotate(rotation)
      val uprightBoxes = detect(page, detMaxSide)
      secondDetMs = SystemClock.elapsedRealtime() - secondStart
      for (box in uprightBoxes) {
        val corners = rotated(box, if (isVertical(box)) 1 else 0)
        val (text, score) = recognizeCrop(page.cropQuad(corners))
        if (text.isNotBlank()) lines.add(Line(text, score, corners))
      }
    }
    // 识别时间含判断方向；转正后的第二次检测算进检测时间
    val recMs = SystemClock.elapsedRealtime() - recStart - secondDetMs
    val order = DbPostProcess.sortReadingOrder(lines.map { it.corners })
    return Output(order.map { lines[it] }, page.width, page.height, rotation, firstDetMs + secondDetMs, recMs)
  }

  private fun isVertical(box: List<PointD>): Boolean {
    val width = Geometry.distance(box[0], box[1])
    val height = Geometry.distance(box[0], box[3])
    return width > 0 && height / width >= VERTICAL_RATIO
  }

  private fun rotated(box: List<PointD>, start: Int): List<PointD> = List(4) { box[(start + it) % 4] }

  /** 字最多（框最大）的三行，两个方向各认一次，置信度明显高的那个方向赢；差不多时用默认方向 */
  private fun vote(
    boxes: List<List<PointD>>,
    indices: List<Int>,
    defaultStart: Int,
    otherStart: Int,
    recognize: (Int, Int) -> Pair<String, Double>,
  ): Int {
    if (indices.isEmpty()) return defaultStart
    val sample = indices.sortedByDescending { index ->
      val box = boxes[index]
      Geometry.distance(box[0], box[1]) * Geometry.distance(box[0], box[3])
    }.take(3)
    var defaultScore = 0.0
    var otherScore = 0.0
    for (index in sample) {
      defaultScore += recognize(index, defaultStart).second
      otherScore += recognize(index, otherStart).second
    }
    return if (otherScore > defaultScore + 0.05 * sample.size) otherStart else defaultStart
  }

  private fun detect(image: Raster, maxSide: Int): List<List<PointD>> {
    var ratio = 1.0
    val shortSide = minOf(image.width, image.height)
    if (shortSide < DET_MIN_SIDE) ratio = DET_MIN_SIDE.toDouble() / shortSide
    var resizedW = (image.width * ratio).toInt()
    var resizedH = (image.height * ratio).toInt()
    if (max(resizedW, resizedH) > maxSide) {
      val shrink = maxSide.toDouble() / max(resizedW, resizedH)
      resizedW = (resizedW * shrink).toInt()
      resizedH = (resizedH * shrink).toInt()
    }
    val detW = max(Geometry.roundHalfToEven(resizedW / 32.0) * 32, 32)
    val detH = max(Geometry.roundHalfToEven(resizedH / 32.0) * 32, 32)
    val tensor = image.toTensor(detW, detH, detConfig.imgMode, detConfig.scale, detConfig.mean, detConfig.std)
    val (prob, shape) = runSession(detSession, detInput, tensor, longArrayOf(1, 3, detH.toLong(), detW.toLong()))
    val predH = shape[shape.size - 2].toInt()
    val predW = shape[shape.size - 1].toInt()
    val boxes = DbPostProcess.process(prob, predW, predH, image.width, image.height, DB_PARAMS)
    // 和官方一样先按阅读顺序排（方向定了以后在新坐标里再排一次）
    return DbPostProcess.sortReadingOrder(boxes).map { boxes[it] }
  }

  private fun recognizeCrop(crop: Raster): Pair<String, Double> {
    val (tensor, width) = crop.toRecTensor(recConfig.imageHeight, recConfig.imageWidth, REC_MAX_WIDTH, recConfig.imgMode)
    val (output, shape) = runSession(recSession, recInput, tensor, longArrayOf(1, 3, recConfig.imageHeight.toLong(), width.toLong()))
    return ctcDecode(output, shape[1].toInt(), shape[2].toInt())
  }

  /** CTC 贪心解码：每一步取概率最大的类，去掉空白（第 0 类）和连着重复的；置信度是留下的字的概率平均（照官方 CTCDecoder） */
  private fun ctcDecode(output: FloatArray, steps: Int, classes: Int): Pair<String, Double> {
    val characters = recConfig.characters
    val text = StringBuilder()
    var probabilitySum = 0.0
    var kept = 0
    var previous = -1
    for (step in 0 until steps) {
      val offset = step * classes
      var best = 0
      var bestValue = output[offset]
      for (cls in 1 until classes) {
        val value = output[offset + cls]
        if (value > bestValue) {
          bestValue = value
          best = cls
        }
      }
      if (best != 0 && best != previous && best - 1 < characters.size) {
        text.append(characters[best - 1])
        probabilitySum += bestValue
        kept++
      }
      previous = best
    }
    val score = if (kept == 0) 0.0 else probabilitySum / kept
    return text.toString() to (score * 1000).roundToInt() / 1000.0
  }

  private fun runSession(session: OrtSession, inputName: String, data: FloatArray, shape: LongArray): Pair<FloatArray, LongArray> {
    OnnxTensor.createTensor(env, FloatBuffer.wrap(data), shape).use { tensor ->
      session.run(mapOf(inputName to tensor)).use { result ->
        val output = result.get(0) as OnnxTensor
        val buffer = output.floatBuffer
        val values = FloatArray(buffer.remaining())
        buffer.get(values)
        return values to output.info.shape
      }
    }
  }

  override fun close() {
    try {
      detSession.close()
    } finally {
      recSession.close()
    }
  }
}
