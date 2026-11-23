package expo.modules.labelocr

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.sin

/**
 * 检测后处理要用的几何计算。官方安卓示例用 OpenCV 的 minAreaRect、findContours，这里自己写，省掉 OpenCV。
 * 坐标都是像素，y 向下。
 */
internal data class PointD(val x: Double, val y: Double)

internal object Geometry {
  /** 四舍六入五成双（和 Python round、PaddleX 一样） */
  fun roundHalfToEven(value: Double): Int {
    val floored = floor(value)
    val diff = value - floored
    return when {
      diff < 0.5 -> floored.toInt()
      diff > 0.5 -> floored.toInt() + 1
      floored.toInt() % 2 == 0 -> floored.toInt()
      else -> floored.toInt() + 1
    }
  }

  fun distance(a: PointD, b: PointD): Double = hypot(a.x - b.x, a.y - b.y)

  private fun cross(o: PointD, a: PointD, b: PointD): Double = (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

  /** 凸包（Andrew 单调链），逆时针（y 向下时看起来是顺时针），不含共线点 */
  fun convexHull(points: List<PointD>): List<PointD> {
    if (points.size <= 2) return points.distinct()
    val sorted = points.distinct().sortedWith(compareBy({ it.x }, { it.y }))
    if (sorted.size <= 2) return sorted
    val hull = ArrayList<PointD>(sorted.size * 2)
    for (point in sorted) {
      while (hull.size >= 2 && cross(hull[hull.size - 2], hull[hull.size - 1], point) <= 0) hull.removeAt(hull.size - 1)
      hull.add(point)
    }
    val lowerSize = hull.size + 1
    for (index in sorted.size - 2 downTo 0) {
      val point = sorted[index]
      while (hull.size >= lowerSize && cross(hull[hull.size - 2], hull[hull.size - 1], point) <= 0) hull.removeAt(hull.size - 1)
      hull.add(point)
    }
    hull.removeAt(hull.size - 1)
    return hull
  }

  /** 最小外接矩形（对应 OpenCV minAreaRect）：返回四个角和短边长度。凸包上逐条边做旋转卡壳 */
  class MinRect(val corners: List<PointD>, val shortSide: Double)

  fun minAreaRect(points: List<PointD>): MinRect {
    val hull = convexHull(points)
    if (hull.isEmpty()) return MinRect(List(4) { PointD(0.0, 0.0) }, 0.0)
    if (hull.size == 1) return MinRect(List(4) { hull[0] }, 0.0)
    var bestArea = Double.MAX_VALUE
    var best: MinRect? = null
    for (index in hull.indices) {
      val a = hull[index]
      val b = hull[(index + 1) % hull.size]
      val length = distance(a, b)
      if (length <= 1e-9) continue
      val ux = (b.x - a.x) / length
      val uy = (b.y - a.y) / length
      // 法向量
      val vx = -uy
      val vy = ux
      var minU = Double.MAX_VALUE
      var maxU = -Double.MAX_VALUE
      var minV = Double.MAX_VALUE
      var maxV = -Double.MAX_VALUE
      for (point in hull) {
        val u = (point.x - a.x) * ux + (point.y - a.y) * uy
        val v = (point.x - a.x) * vx + (point.y - a.y) * vy
        if (u < minU) minU = u
        if (u > maxU) maxU = u
        if (v < minV) minV = v
        if (v > maxV) maxV = v
      }
      val width = maxU - minU
      val height = maxV - minV
      val area = width * height
      if (area < bestArea) {
        bestArea = area
        fun at(u: Double, v: Double) = PointD(a.x + u * ux + v * vx, a.y + u * uy + v * vy)
        best = MinRect(
          listOf(at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)),
          minOf(width, height),
        )
      }
    }
    return best ?: MinRect(List(4) { hull[0] }, 0.0)
  }

  /**
   * 把矩形四个角排成左上、右上、右下、左下（照官方示例 QuadGeometry.orderMinAreaRectPoints：
   * 按 x 排序，左边两个里 y 小的是左上，右边两个里 y 小的是右上）。
   */
  fun orderCorners(points: List<PointD>): List<PointD> {
    val sorted = points.sortedBy { it.x }
    val (topLeft, bottomLeft) = if (sorted[1].y > sorted[0].y) sorted[0] to sorted[1] else sorted[1] to sorted[0]
    val (topRight, bottomRight) = if (sorted[3].y > sorted[2].y) sorted[2] to sorted[3] else sorted[3] to sorted[2]
    return listOf(topLeft, topRight, bottomRight, bottomLeft)
  }

  /**
   * 把检测到的框往外扩（DB 后处理的 unclip）：扩出去的距离 = 面积 × unclipRatio / 周长，拐角是圆弧。
   * 照官方示例 PolygonUnclip.kt（它对应 PaddleX 用的 pyclipper 圆角偏移）。
   */
  fun unclip(points: List<PointD>, unclipRatio: Double): List<PointD> {
    if (points.size < 3) return points
    var signedArea = 0.0
    var perimeter = 0.0
    for (index in points.indices) {
      val p1 = points[index]
      val p2 = points[(index + 1) % points.size]
      signedArea += p1.x * p2.y - p2.x * p1.y
      perimeter += distance(p1, p2)
    }
    signedArea /= 2.0
    val area = abs(signedArea)
    if (!area.isFinite() || !perimeter.isFinite() || area <= EPS || perimeter <= EPS) return points
    val offset = area * unclipRatio / perimeter
    if (!offset.isFinite() || offset <= EPS) return points
    val clockwise = signedArea > 0.0
    val normals = ArrayList<PointD>(points.size)
    for (index in points.indices) {
      val start = points[index]
      val end = points[(index + 1) % points.size]
      val dx = end.x - start.x
      val dy = end.y - start.y
      val length = hypot(dx, dy)
      if (!length.isFinite() || length <= EPS) return points
      normals.add(if (clockwise) PointD(dy / length, -dx / length) else PointD(-dy / length, dx / length))
    }
    val expanded = ArrayList<PointD>()
    for (index in points.indices) {
      val center = points[index]
      val from = normals[(index - 1 + normals.size) % normals.size]
      val to = normals[index]
      val startAngle = atan2(from.y, from.x)
      var endAngle = atan2(to.y, to.x)
      if (clockwise) {
        while (endAngle < startAngle) endAngle += 2.0 * PI
      } else {
        while (endAngle > startAngle) endAngle -= 2.0 * PI
      }
      val sweep = endAngle - startAngle
      val ratio = (1.0 - ARC_TOLERANCE / offset).coerceIn(-1.0, 1.0)
      val step = 2.0 * acos(ratio).let { if (it.isFinite() && it > EPS) it else PI / 16.0 }
      val steps = ceil(abs(sweep) / step).toInt().coerceAtLeast(1)
      for (stepIndex in 0..steps) {
        val angle = startAngle + sweep * stepIndex.toDouble() / steps.toDouble()
        val point = PointD(center.x + cos(angle) * offset, center.y + sin(angle) * offset)
        val last = expanded.lastOrNull()
        if (last == null || distance(point, last) > EPS) expanded.add(point)
      }
    }
    return if (expanded.size >= 3) expanded else points
  }

  private const val EPS = 1e-6
  private const val ARC_TOLERANCE = 0.25
}
