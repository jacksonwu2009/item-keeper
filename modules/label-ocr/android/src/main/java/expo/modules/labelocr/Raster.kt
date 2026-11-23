package expo.modules.labelocr

import android.graphics.Bitmap
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 一张图的像素（ARGB，按行存）。缩放、裁行这些官方示例用 OpenCV 做的事在这里自己写：
 * - 双线性插值按像素中心对齐、边上复制边缘像素，和 OpenCV 的 INTER_LINEAR / BORDER_REPLICATE 一致；
 * - 官方裁行用的是 warpPerspective（INTER_CUBIC），这里框都是矩形，用仿射 + 双线性，差别很小。
 */
internal class Raster(val width: Int, val height: Int, val pixels: IntArray) {
  companion object {
    fun fromBitmap(bitmap: Bitmap): Raster {
      val pixels = IntArray(bitmap.width * bitmap.height)
      bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
      return Raster(bitmap.width, bitmap.height, pixels)
    }
  }

  /** 在 (x, y) 处双线性取色，结果写进 out[0..2]（R、G、B，0–255 的浮点）；坐标出界时取边上的像素 */
  private fun sample(x: Double, y: Double, out: FloatArray) {
    val cx = x.coerceIn(0.0, (width - 1).toDouble())
    val cy = y.coerceIn(0.0, (height - 1).toDouble())
    val x0 = floor(cx).toInt()
    val y0 = floor(cy).toInt()
    val x1 = minOf(x0 + 1, width - 1)
    val y1 = minOf(y0 + 1, height - 1)
    val fx = (cx - x0).toFloat()
    val fy = (cy - y0).toFloat()
    val p00 = pixels[y0 * width + x0]
    val p01 = pixels[y0 * width + x1]
    val p10 = pixels[y1 * width + x0]
    val p11 = pixels[y1 * width + x1]
    for (channel in 0..2) {
      val shift = 16 - channel * 8
      val c00 = (p00 shr shift) and 0xFF
      val c01 = (p01 shr shift) and 0xFF
      val c10 = (p10 shr shift) and 0xFF
      val c11 = (p11 shr shift) and 0xFF
      val top = c00 + (c01 - c00) * fx
      val bottom = c10 + (c11 - c10) * fx
      out[channel] = top + (bottom - top) * fy
    }
  }

  /**
   * 缩放到 dstW × dstH 并转成模型输入：NCHW 的浮点数组。
   * order 是通道顺序（"BGR" 或 "RGB"）；每个值 = (像素 × scale − mean[c]) / std[c]，c 按 order 里的顺序。
   */
  fun toTensor(dstW: Int, dstH: Int, order: String, scale: Float, mean: FloatArray, std: FloatArray): FloatArray {
    val plane = dstW * dstH
    val tensor = FloatArray(3 * plane)
    val scaleX = width.toDouble() / dstW
    val scaleY = height.toDouble() / dstH
    val rgb = FloatArray(3)
    // order 里第 i 个通道取 RGB 里的哪一个
    val pick = IntArray(3) { index -> "RGB".indexOf(order[index]) }
    for (dy in 0 until dstH) {
      val sy = (dy + 0.5) * scaleY - 0.5
      for (dx in 0 until dstW) {
        val sx = (dx + 0.5) * scaleX - 0.5
        sample(sx, sy, rgb)
        val offset = dy * dstW + dx
        for (channel in 0..2) {
          tensor[channel * plane + offset] = (rgb[pick[channel]] * scale - mean[channel]) / std[channel]
        }
      }
    }
    return tensor
  }

  /**
   * 把四边形 corners（左上、右上、右下、左下，按要读出来的方向）拉成一张正的矩形小图，
   * 宽是上下两边较长的那条，高是左右两边较长的那条（照官方 QuadTextCrop）。
   */
  fun cropQuad(corners: List<PointD>): Raster {
    val dstW = max(Geometry.distance(corners[0], corners[1]), Geometry.distance(corners[3], corners[2])).toInt().coerceAtLeast(1)
    val dstH = max(Geometry.distance(corners[0], corners[3]), Geometry.distance(corners[1], corners[2])).toInt().coerceAtLeast(1)
    val ax = (corners[1].x - corners[0].x) / dstW
    val ay = (corners[1].y - corners[0].y) / dstW
    val bx = (corners[3].x - corners[0].x) / dstH
    val by = (corners[3].y - corners[0].y) / dstH
    val out = IntArray(dstW * dstH)
    val rgb = FloatArray(3)
    for (v in 0 until dstH) {
      for (u in 0 until dstW) {
        sample(corners[0].x + u * ax + v * bx, corners[0].y + u * ay + v * by, rgb)
        out[v * dstW + u] = (0xFF shl 24) or
          (rgb[0].roundToInt().coerceIn(0, 255) shl 16) or
          (rgb[1].roundToInt().coerceIn(0, 255) shl 8) or
          rgb[2].roundToInt().coerceIn(0, 255)
      }
    }
    return Raster(dstW, dstH, out)
  }

  /** 整张图顺时针转 degrees 度（0 / 90 / 180 / 270） */
  fun rotate(degrees: Int): Raster {
    val out = IntArray(pixels.size)
    return when (degrees) {
      90 -> {
        // 新图宽 = 原图高；新图 (x, y) 取原图 (y, 高 − 1 − x)
        for (y in 0 until width) for (x in 0 until height) out[y * height + x] = pixels[(height - 1 - x) * width + y]
        Raster(height, width, out)
      }
      180 -> {
        for (index in pixels.indices) out[index] = pixels[pixels.size - 1 - index]
        Raster(width, height, out)
      }
      270 -> {
        // 新图 (x, y) 取原图 (宽 − 1 − y, x)
        for (y in 0 until width) for (x in 0 until height) out[y * height + x] = pixels[x * width + (width - 1 - y)]
        Raster(height, width, out)
      }
      else -> this
    }
  }

  /**
   * 识别模型的输入：等比缩放到高 height（宽 = ceil(height × 宽高比)，最多 maxWidth），RGB，(x / 255 − 0.5) / 0.5。
   * 照官方 RecPreprocessor（一次一行，不补边）。
   */
  fun toRecTensor(height: Int, maxWidth: Int): Pair<FloatArray, Int> {
    val ratio = width.toDouble() / this.height
    val dstW = ceil(height * ratio).toInt().coerceIn(1, maxWidth)
    val half = floatArrayOf(0.5f, 0.5f, 0.5f)
    return toTensor(dstW, height, "RGB", 1f / 255f, half, half) to dstW
  }
}
