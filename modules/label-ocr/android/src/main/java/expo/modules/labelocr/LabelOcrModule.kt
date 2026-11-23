package expo.modules.labelocr

import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

data class CropOptions(
  @Field val x: Double = 0.0,
  @Field val y: Double = 0.0,
  @Field val width: Double = 1.0,
  @Field val height: Double = 1.0,
) : Record

data class RecognizeOptions(
  @Field val crop: CropOptions? = null,
) : Record

internal class LabelOcrImageException(cause: Throwable) :
  CodedException("ERR_LABEL_OCR_IMAGE", "读不了这张图片：${cause.message}", cause)

internal class LabelOcrModelException(cause: Throwable) :
  CodedException("ERR_LABEL_OCR_MODEL", "识别模型加载失败：${cause.message}", cause)

internal class LabelOcrFailedException(cause: Throwable) :
  CodedException("ERR_LABEL_OCR_FAILED", "识别出错：${cause.message}", cause)

/**
 * 拍照识别原生模块（JS 接口见 modules/label-ocr/index.ts）。
 * 识别在后台线程（Dispatchers.Default）做，同一时间只跑一个；模型第一次用时加载，之后一直留着。
 * 照片只在本机读，不存、不传；读进来的图用完就回收。
 */
class LabelOcrModule : Module() {
  private val lock = Mutex()
  private var engine: OcrEngine? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context 不可用")

  /** 拿到引擎，第一次要加载模型；返回加载用了多少毫秒（已经加载过是 0）。调用方要先拿着 lock */
  private fun engineLocked(): Pair<OcrEngine, Long> {
    engine?.let { return it to 0L }
    val start = SystemClock.elapsedRealtime()
    val loaded = try {
      OcrEngine.load(context)
    } catch (error: Throwable) {
      throw LabelOcrModelException(error)
    }
    engine = loaded
    val loadMs = SystemClock.elapsedRealtime() - start
    Log.i(TAG, "模型 ${OcrEngine.MODEL} 加载用了 $loadMs ms")
    return loaded to loadMs
  }

  override fun definition() = ModuleDefinition {
    Name("LabelOcr")

    AsyncFunction("prepareAsync") Coroutine { ->
      withContext(Dispatchers.Default) {
        lock.withLock { engineLocked() }
      }
      Unit
    }

    AsyncFunction("recognizeAsync") Coroutine { uri: String, options: RecognizeOptions ->
      withContext(Dispatchers.Default) {
        lock.withLock { recognize(uri, options) }
      }
    }

    OnDestroy {
      engine?.close()
      engine = null
    }
  }

  private fun recognize(uri: String, options: RecognizeOptions): Map<String, Any> {
    val totalStart = SystemClock.elapsedRealtime()
    val (ocr, loadMs) = engineLocked()

    val decodeStart = SystemClock.elapsedRealtime()
    val crop = options.crop?.let { NormalizedCrop(it.x, it.y, it.width, it.height) }
    val raster = try {
      val bitmap: Bitmap = ImageInput.load(context, uri, crop)
      try {
        Raster.fromBitmap(bitmap)
      } finally {
        bitmap.recycle()
      }
    } catch (error: Throwable) {
      throw LabelOcrImageException(error)
    }
    val decodeMs = SystemClock.elapsedRealtime() - decodeStart

    val output = try {
      ocr.run(raster)
    } catch (error: CodedException) {
      throw error
    } catch (error: Throwable) {
      throw LabelOcrFailedException(error)
    }
    val totalMs = SystemClock.elapsedRealtime() - totalStart
    Log.i(
      TAG,
      "识别 ${raster.width}×${raster.height}：${output.lines.size} 行，转 ${output.rotation}°，" +
        "加载 $loadMs、读图 $decodeMs、检测 ${output.detMs}、识别 ${output.recMs}、共 $totalMs ms",
    )
    return mapOf(
      "lines" to output.lines.map { line ->
        mapOf(
          "text" to line.text,
          "score" to line.score,
          "box" to line.corners.map { listOf(it.x.roundToInt(), it.y.roundToInt()) },
        )
      },
      "width" to output.width,
      "height" to output.height,
      "rotation" to output.rotation,
      "model" to OcrEngine.MODEL,
      "timing" to mapOf(
        "loadMs" to loadMs,
        "decodeMs" to decodeMs,
        "detMs" to output.detMs,
        "recMs" to output.recMs,
        "totalMs" to totalMs,
      ),
    )
  }

  private companion object {
    const val TAG = "LabelOcr"
  }
}
