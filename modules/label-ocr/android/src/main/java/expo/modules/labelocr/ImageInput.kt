package expo.modules.labelocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Matrix
import android.graphics.Rect
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import java.io.File
import java.io.InputStream

/** 相对整张图（摆正以后）的一块，0–1 */
internal data class NormalizedCrop(val x: Double, val y: Double, val width: Double, val height: Double)

/**
 * 读图：按 EXIF 摆正、按 crop 只取一块、按需缩小。
 * 相机原图常有 4000 像素宽，全读进来太占内存；长边超过 SOURCE_MAX_SIDE 时按 2 的倍数缩小着读
 * （识别每一行时从这张图里裁，所以留得比检测用的大）。
 * 有 crop 时用 BitmapRegionDecoder 只解那一块，小取景框里的喷码能保留原图的清晰度。
 */
internal object ImageInput {
  const val SOURCE_MAX_SIDE = 2560

  fun load(context: Context, uriString: String, crop: NormalizedCrop?): Bitmap {
    val uri = if (uriString.startsWith("/")) Uri.fromFile(File(uriString)) else Uri.parse(uriString)
    val open: () -> InputStream = {
      context.contentResolver.openInputStream(uri) ?: throw IllegalArgumentException("打不开 $uriString")
    }
    val orientation = try {
      open().use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open().use { BitmapFactory.decodeStream(it, null, bounds) }
    val rawW = bounds.outWidth
    val rawH = bounds.outHeight
    if (rawW <= 0 || rawH <= 0) throw IllegalArgumentException("不是图片：$uriString")

    val region = crop?.let { rawRegion(orientation, it, rawW, rawH) }
    val regionW = region?.width() ?: rawW
    val regionH = region?.height() ?: rawH
    var sample = 1
    while (maxOf(regionW, regionH) / sample > SOURCE_MAX_SIDE) sample *= 2
    val options = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val decoded = if (region != null && (region.width() < rawW || region.height() < rawH)) {
      open().use { stream ->
        val decoder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          BitmapRegionDecoder.newInstance(stream)
        } else {
          @Suppress("DEPRECATION")
          BitmapRegionDecoder.newInstance(stream, false)
        } ?: throw IllegalArgumentException("读不了这张图：$uriString")
        try {
          decoder.decodeRegion(region, options)
        } finally {
          decoder.recycle()
        }
      }
    } else {
      open().use { BitmapFactory.decodeStream(it, null, options) }
    } ?: throw IllegalArgumentException("读不了这张图：$uriString")
    return applyOrientation(decoded, orientation)
  }

  /**
   * 摆正以后的一块（0–1）对应原始像素里的哪一块。EXIF 的 8 种方向只有转 90° 的倍数和翻转，矩形还是矩形，
   * 把两个对角换算回去取外接框就行。换算式：摆正后的 (u, v) → 原图 (x, y)。
   */
  private fun rawRegion(orientation: Int, crop: NormalizedCrop, rawW: Int, rawH: Int): Rect {
    val u0 = crop.x.coerceIn(0.0, 1.0)
    val v0 = crop.y.coerceIn(0.0, 1.0)
    val u1 = (crop.x + crop.width).coerceIn(0.0, 1.0)
    val v1 = (crop.y + crop.height).coerceIn(0.0, 1.0)
    fun toRaw(u: Double, v: Double): Pair<Double, Double> = when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> (1 - u) to v
      ExifInterface.ORIENTATION_ROTATE_180 -> (1 - u) to (1 - v)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> u to (1 - v)
      ExifInterface.ORIENTATION_TRANSPOSE -> v to u
      ExifInterface.ORIENTATION_ROTATE_90 -> v to (1 - u)
      ExifInterface.ORIENTATION_TRANSVERSE -> (1 - v) to (1 - u)
      ExifInterface.ORIENTATION_ROTATE_270 -> (1 - v) to u
      else -> u to v
    }
    val (ax, ay) = toRaw(u0, v0)
    val (bx, by) = toRaw(u1, v1)
    val left = (minOf(ax, bx) * rawW).toInt().coerceIn(0, rawW - 1)
    val top = (minOf(ay, by) * rawH).toInt().coerceIn(0, rawH - 1)
    val right = (maxOf(ax, bx) * rawW).toInt().coerceIn(left + 1, rawW)
    val bottom = (maxOf(ay, by) * rawH).toInt().coerceIn(top + 1, rawH)
    return Rect(left, top, right, bottom)
  }

  private fun applyOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
        matrix.setRotate(180f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.setRotate(90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.setRotate(-90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
      else -> return bitmap
    }
    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (rotated !== bitmap) bitmap.recycle()
    return rotated
  }
}
