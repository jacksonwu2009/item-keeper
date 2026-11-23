package expo.modules.labelocr

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

/**
 * 文字检测（DB）的后处理：概率图 → 一个个文字行的四边形。
 *
 * 照官方安卓示例 DBPostProcessor.kt（对应 PaddleX DBPostProcess，box_type=quad、score_mode=fast），
 * 只是把 OpenCV 的二值化、findContours、minAreaRect、fillPoly 换成自己写的：
 * - 二值化：概率 > thresh 的点；
 * - 找轮廓：8 邻接连通块（OpenCV 的外轮廓也是 8 邻接）。连通块的最小外接矩形只和它的凸包有关，
 *   凸包又只取决于每一行最左、最右的点，所以不用真的描边；
 * - 框的得分：矩形里概率的平均（矩形内含边上的点）。
 * 参数见 DbParams。
 */
internal data class DbParams(
  val thresh: Double,
  val boxThresh: Double,
  val unclipRatio: Double,
  val maxCandidates: Int,
)

internal object DbPostProcess {
  private const val MIN_SIZE_BEFORE_UNCLIP = 3.0
  private const val MIN_SIZE_AFTER_UNCLIP = 5.0

  /**
   * prob 是 predH × predW 的概率图；返回的框换算到 srcW × srcH 的原图坐标，四个角是左上、右上、右下、左下（按图的方向）
   */
  fun process(prob: FloatArray, predW: Int, predH: Int, srcW: Int, srcH: Int, params: DbParams): List<List<PointD>> {
    val scaleX = srcW.toDouble() / predW
    val scaleY = srcH.toDouble() / predH
    val total = predW * predH
    val mask = BooleanArray(total) { prob[it] > params.thresh }
    val visited = BooleanArray(total)
    val stack = IntArray(total)
    val members = IntArray(total)
    val boxes = ArrayList<List<PointD>>()
    var candidates = 0
    for (seed in 0 until total) {
      if (!mask[seed] || visited[seed]) continue
      if (candidates >= params.maxCandidates) break
      candidates++
      // 找出这个连通块的所有点
      var stackSize = 0
      var memberCount = 0
      stack[stackSize++] = seed
      visited[seed] = true
      while (stackSize > 0) {
        val index = stack[--stackSize]
        members[memberCount++] = index
        val x = index % predW
        val y = index / predW
        for (dy in -1..1) {
          val ny = y + dy
          if (ny < 0 || ny >= predH) continue
          for (dx in -1..1) {
            if (dx == 0 && dy == 0) continue
            val nx = x + dx
            if (nx < 0 || nx >= predW) continue
            val next = ny * predW + nx
            if (mask[next] && !visited[next]) {
              visited[next] = true
              stack[stackSize++] = next
            }
          }
        }
      }
      if (memberCount < 3) continue
      val box = boxFromComponent(members, memberCount, prob, predW, predH, params) ?: continue
      val scaled = box.map { point ->
        PointD(
          Geometry.roundHalfToEven(point.x * scaleX).coerceIn(0, srcW).toDouble(),
          Geometry.roundHalfToEven(point.y * scaleY).coerceIn(0, srcH).toDouble(),
        )
      }
      if (Geometry.distance(scaled[0], scaled[1]) <= 3 || Geometry.distance(scaled[0], scaled[3]) <= 3) continue
      boxes.add(scaled)
    }
    return boxes
  }

  private fun boxFromComponent(
    members: IntArray,
    count: Int,
    prob: FloatArray,
    predW: Int,
    predH: Int,
    params: DbParams,
  ): List<PointD>? {
    var minY = Int.MAX_VALUE
    var maxY = Int.MIN_VALUE
    for (index in 0 until count) {
      val y = members[index] / predW
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    val rows = maxY - minY + 1
    val rowMin = IntArray(rows) { Int.MAX_VALUE }
    val rowMax = IntArray(rows) { Int.MIN_VALUE }
    for (index in 0 until count) {
      val member = members[index]
      val row = member / predW - minY
      val x = member % predW
      if (x < rowMin[row]) rowMin[row] = x
      if (x > rowMax[row]) rowMax[row] = x
    }
    val extremes = ArrayList<PointD>(rows * 2)
    for (row in 0 until rows) {
      if (rowMin[row] == Int.MAX_VALUE) continue
      extremes.add(PointD(rowMin[row].toDouble(), (row + minY).toDouble()))
      if (rowMax[row] != rowMin[row]) extremes.add(PointD(rowMax[row].toDouble(), (row + minY).toDouble()))
    }
    val rect = Geometry.minAreaRect(extremes)
    if (rect.shortSide < MIN_SIZE_BEFORE_UNCLIP) return null
    val ordered = Geometry.orderCorners(rect.corners)
    if (boxScore(prob, predW, predH, ordered) < params.boxThresh) return null
    val expanded = Geometry.minAreaRect(Geometry.unclip(ordered, params.unclipRatio))
    if (expanded.shortSide < MIN_SIZE_AFTER_UNCLIP) return null
    return Geometry.orderCorners(expanded.corners)
  }

  /** 四边形里概率的平均（score_mode=fast）：照官方，角点坐标先取整，再看每个点在不在四边形里（含边） */
  private fun boxScore(prob: FloatArray, predW: Int, predH: Int, corners: List<PointD>): Double {
    val xMin = floor(corners.minOf { it.x }).toInt().coerceIn(0, predW - 1)
    val xMax = ceil(corners.maxOf { it.x }).toInt().coerceIn(0, predW - 1)
    val yMin = floor(corners.minOf { it.y }).toInt().coerceIn(0, predH - 1)
    val yMax = ceil(corners.maxOf { it.y }).toInt().coerceIn(0, predH - 1)
    val quad = corners.map { PointD((it.x - xMin).toInt().toDouble() + xMin, (it.y - yMin).toInt().toDouble() + yMin) }
    var sum = 0.0
    var count = 0
    for (y in yMin..yMax) {
      for (x in xMin..xMax) {
        if (insideConvex(quad, x.toDouble(), y.toDouble())) {
          sum += prob[y * predW + x]
          count++
        }
      }
    }
    return if (count == 0) 0.0 else sum / count
  }

  private fun insideConvex(quad: List<PointD>, x: Double, y: Double): Boolean {
    var positive = false
    var negative = false
    for (index in quad.indices) {
      val a = quad[index]
      val b = quad[(index + 1) % quad.size]
      val cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
      if (cross > 1e-9) positive = true
      if (cross < -1e-9) negative = true
      if (positive && negative) return false
    }
    return true
  }

  /** 按阅读顺序排（照官方 BoxSorter / PaddleX SortQuadBoxes）：先按左上角 y、x 排，同一排（y 差 < 10）里从左到右 */
  fun sortReadingOrder(boxes: List<List<PointD>>): List<Int> {
    val order = boxes.indices.sortedWith(compareBy({ boxes[it][0].y }, { boxes[it][0].x })).toMutableList()
    for (i in 0 until order.size - 1) {
      var j = i
      while (j >= 0) {
        val next = boxes[order[j + 1]][0]
        val current = boxes[order[j]][0]
        if (abs(next.y - current.y) < 10 && next.x < current.x) {
          val swap = order[j]
          order[j] = order[j + 1]
          order[j + 1] = swap
          j--
        } else {
          break
        }
      }
    }
    return order
  }
}
