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

  /**
   * 四边形里概率的平均（score_mode=fast），照 PaddleX 的 box_score_fast：外接框里铺一张掩码，角点减去外接框左上角后
   * 取整（截掉小数），用 OpenCV fillPoly 的画法填上——四条边按 8 邻接直线画出来（边线上的像素都算），再把每一行
   * 左右边之间填满（四边形是凸的，每行一段）——掩码里的点求平均。
   * 以前只算中心落在四边形里的点，边上斜着压过去的像素没算，得分偏高，该被 box_thresh 0.6 筛掉的框会留下。
   */
  private fun boxScore(prob: FloatArray, predW: Int, predH: Int, corners: List<PointD>): Double {
    val xMin = floor(corners.minOf { it.x }).toInt().coerceIn(0, predW - 1)
    val xMax = ceil(corners.maxOf { it.x }).toInt().coerceIn(0, predW - 1)
    val yMin = floor(corners.minOf { it.y }).toInt().coerceIn(0, predH - 1)
    val yMax = ceil(corners.maxOf { it.y }).toInt().coerceIn(0, predH - 1)
    val width = xMax - xMin + 1
    val height = yMax - yMin + 1
    // 每一行被边线压到的最左、最右的点
    val rowMin = IntArray(height) { Int.MAX_VALUE }
    val rowMax = IntArray(height) { Int.MIN_VALUE }
    fun plot(x: Int, y: Int) {
      if (x < 0 || x >= width || y < 0 || y >= height) return
      if (x < rowMin[y]) rowMin[y] = x
      if (x > rowMax[y]) rowMax[y] = x
    }
    val points = corners.map { ((it.x - xMin).toInt()) to ((it.y - yMin).toInt()) }
    for (index in points.indices) {
      val (x0, y0) = points[index]
      val (x1, y1) = points[(index + 1) % points.size]
      drawLine(x0, y0, x1, y1, ::plot)
    }
    var sum = 0.0
    var count = 0
    for (row in 0 until height) {
      if (rowMin[row] > rowMax[row]) continue
      val offset = (row + yMin) * predW + xMin
      for (x in rowMin[row]..rowMax[row]) {
        sum += prob[offset + x]
        count++
      }
    }
    return if (count == 0) 0.0 else sum / count
  }

  /** 8 邻接的直线（Bresenham，和 OpenCV LINE_8 一样走法），每个点交给 plot */
  private inline fun drawLine(fromX: Int, fromY: Int, toX: Int, toY: Int, plot: (Int, Int) -> Unit) {
    var x = fromX
    var y = fromY
    val dx = abs(toX - fromX)
    val dy = -abs(toY - fromY)
    val stepX = if (fromX < toX) 1 else -1
    val stepY = if (fromY < toY) 1 else -1
    var error = dx + dy
    while (true) {
      plot(x, y)
      if (x == toX && y == toY) break
      val doubled = 2 * error
      if (doubled >= dy) {
        error += dy
        x += stepX
      }
      if (doubled <= dx) {
        error += dx
        y += stepY
      }
    }
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
