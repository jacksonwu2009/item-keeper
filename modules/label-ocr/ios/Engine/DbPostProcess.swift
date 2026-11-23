import Foundation

/// DB 后处理的参数
struct DbParams {
  let thresh: Double
  let boxThresh: Double
  let unclipRatio: Double
  let maxCandidates: Int
}

/// 文字检测（DB）的后处理：概率图 → 一个个文字行的四边形。
///
/// 照官方示例（对应 PaddleX DBPostProcess，box_type=quad、score_mode=fast），算法和安卓的 DbPostProcess.kt 一一对应：
/// - 二值化：概率 > thresh 的点；
/// - 找轮廓：8 邻接连通块（OpenCV 的外轮廓也是 8 邻接）。连通块的最小外接矩形只和它的凸包有关，
///   凸包又只取决于每一行最左、最右的点，所以不用真的描边；
/// - 框的得分：照 PaddleX box_score_fast，按 OpenCV fillPoly 的画法（边线也算）取矩形里概率的平均。
enum DbPostProcess {
  private static let minSizeBeforeUnclip = 3.0
  private static let minSizeAfterUnclip = 5.0

  /// prob 是 predH × predW 的概率图；返回的框换算到 srcW × srcH 的图坐标，四个角是左上、右上、右下、左下（按图的方向）
  static func process(
    prob: [Float], predW: Int, predH: Int, srcW: Int, srcH: Int, params: DbParams
  ) -> [[PointD]] {
    let scaleX = Double(srcW) / Double(predW)
    let scaleY = Double(srcH) / Double(predH)
    let total = predW * predH
    guard total > 0, prob.count >= total else { return [] }
    var mask = [Bool](repeating: false, count: total)
    for index in 0..<total {
      mask[index] = Double(prob[index]) > params.thresh
    }
    var visited = [Bool](repeating: false, count: total)
    var stack = [Int](repeating: 0, count: total)
    var members = [Int](repeating: 0, count: total)
    var boxes: [[PointD]] = []
    var candidates = 0
    for seed in 0..<total {
      if !mask[seed] || visited[seed] { continue }
      if candidates >= params.maxCandidates { break }
      candidates += 1
      // 找出这个连通块的所有点
      var stackSize = 0
      var memberCount = 0
      stack[stackSize] = seed
      stackSize += 1
      visited[seed] = true
      while stackSize > 0 {
        stackSize -= 1
        let index = stack[stackSize]
        members[memberCount] = index
        memberCount += 1
        let x = index % predW
        let y = index / predW
        for dy in -1...1 {
          let ny = y + dy
          if ny < 0 || ny >= predH { continue }
          for dx in -1...1 {
            if dx == 0 && dy == 0 { continue }
            let nx = x + dx
            if nx < 0 || nx >= predW { continue }
            let next = ny * predW + nx
            if mask[next] && !visited[next] {
              visited[next] = true
              stack[stackSize] = next
              stackSize += 1
            }
          }
        }
      }
      if memberCount < 3 { continue }
      guard let box = boxFromComponent(
        members: members, count: memberCount, prob: prob, predW: predW, predH: predH, params: params)
      else { continue }
      let scaled = box.map { point in
        PointD(
          x: Double(min(max(Geometry.roundHalfToEven(point.x * scaleX), 0), srcW)),
          y: Double(min(max(Geometry.roundHalfToEven(point.y * scaleY), 0), srcH)))
      }
      if Geometry.distance(scaled[0], scaled[1]) <= 3 || Geometry.distance(scaled[0], scaled[3]) <= 3 { continue }
      boxes.append(scaled)
    }
    return boxes
  }

  private static func boxFromComponent(
    members: [Int], count: Int, prob: [Float], predW: Int, predH: Int, params: DbParams
  ) -> [PointD]? {
    var minY = Int.max
    var maxY = Int.min
    for index in 0..<count {
      let y = members[index] / predW
      if y < minY { minY = y }
      if y > maxY { maxY = y }
    }
    let rows = maxY - minY + 1
    var rowMin = [Int](repeating: Int.max, count: rows)
    var rowMax = [Int](repeating: Int.min, count: rows)
    for index in 0..<count {
      let member = members[index]
      let row = member / predW - minY
      let x = member % predW
      if x < rowMin[row] { rowMin[row] = x }
      if x > rowMax[row] { rowMax[row] = x }
    }
    var extremes: [PointD] = []
    extremes.reserveCapacity(rows * 2)
    for row in 0..<rows {
      if rowMin[row] == Int.max { continue }
      extremes.append(PointD(x: Double(rowMin[row]), y: Double(row + minY)))
      if rowMax[row] != rowMin[row] {
        extremes.append(PointD(x: Double(rowMax[row]), y: Double(row + minY)))
      }
    }
    let rect = Geometry.minAreaRect(extremes)
    if rect.shortSide < minSizeBeforeUnclip { return nil }
    let ordered = Geometry.orderCorners(rect.corners)
    if boxScore(prob: prob, predW: predW, predH: predH, corners: ordered) < params.boxThresh { return nil }
    let expanded = Geometry.minAreaRect(Geometry.unclip(ordered, ratio: params.unclipRatio))
    if expanded.shortSide < minSizeAfterUnclip { return nil }
    return Geometry.orderCorners(expanded.corners)
  }

  /// 四边形里概率的平均（score_mode=fast），照 PaddleX 的 box_score_fast：外接框里铺一张掩码，角点减去外接框左上角后
  /// 取整（截掉小数），用 OpenCV fillPoly 的画法填上——四条边按 8 邻接直线画出来（边线上的像素都算），再把每一行
  /// 左右边之间填满（四边形是凸的，每行一段）——掩码里的点求平均。和安卓 DbPostProcess.kt 一样。
  private static func boxScore(prob: [Float], predW: Int, predH: Int, corners: [PointD]) -> Double {
    let xs = corners.map(\.x)
    let ys = corners.map(\.y)
    let xMin = min(max(Int(xs.min()!.rounded(.down)), 0), predW - 1)
    let xMax = min(max(Int(xs.max()!.rounded(.up)), 0), predW - 1)
    let yMin = min(max(Int(ys.min()!.rounded(.down)), 0), predH - 1)
    let yMax = min(max(Int(ys.max()!.rounded(.up)), 0), predH - 1)
    let width = xMax - xMin + 1
    let height = yMax - yMin + 1
    guard width > 0, height > 0 else { return 0 }
    // 每一行被边线压到的最左、最右的点
    var rowMin = [Int](repeating: Int.max, count: height)
    var rowMax = [Int](repeating: Int.min, count: height)
    func plot(_ x: Int, _ y: Int) {
      if x < 0 || x >= width || y < 0 || y >= height { return }
      if x < rowMin[y] { rowMin[y] = x }
      if x > rowMax[y] { rowMax[y] = x }
    }
    // 和 Kotlin 的 toInt() 一样向 0 截断
    let points = corners.map { (Int($0.x - Double(xMin)), Int($0.y - Double(yMin))) }
    for index in points.indices {
      let (x0, y0) = points[index]
      let (x1, y1) = points[(index + 1) % points.count]
      drawLine(x0, y0, x1, y1, plot)
    }
    var sum = 0.0
    var count = 0
    for row in 0..<height where rowMin[row] <= rowMax[row] {
      let offset = (row + yMin) * predW + xMin
      for x in rowMin[row]...rowMax[row] {
        sum += Double(prob[offset + x])
        count += 1
      }
    }
    return count == 0 ? 0.0 : sum / Double(count)
  }

  /// 8 邻接的直线（Bresenham，和 OpenCV LINE_8 一样走法），每个点交给 plot
  private static func drawLine(_ fromX: Int, _ fromY: Int, _ toX: Int, _ toY: Int, _ plot: (Int, Int) -> Void) {
    var x = fromX
    var y = fromY
    let dx = abs(toX - fromX)
    let dy = -abs(toY - fromY)
    let stepX = fromX < toX ? 1 : -1
    let stepY = fromY < toY ? 1 : -1
    var error = dx + dy
    while true {
      plot(x, y)
      if x == toX && y == toY { break }
      let doubled = 2 * error
      if doubled >= dy {
        error += dy
        x += stepX
      }
      if doubled <= dx {
        error += dx
        y += stepY
      }
    }
  }

  /// 按阅读顺序排（照官方 BoxSorter / PaddleX SortQuadBoxes）：先按左上角 y、x 排，同一排（y 差 < 10）里从左到右。
  /// 返回排好的下标。
  static func sortReadingOrder(_ boxes: [[PointD]]) -> [Int] {
    // 稳定排序：y、x 都相同时按原来的顺序（和 Kotlin sortedWith 一样）
    var order = boxes.indices.sorted { left, right in
      let a = boxes[left][0]
      let b = boxes[right][0]
      if a.y != b.y { return a.y < b.y }
      if a.x != b.x { return a.x < b.x }
      return left < right
    }
    if order.count < 2 { return order }
    for i in 0..<(order.count - 1) {
      var j = i
      while j >= 0 {
        let next = boxes[order[j + 1]][0]
        let current = boxes[order[j]][0]
        if abs(next.y - current.y) < 10 && next.x < current.x {
          order.swapAt(j, j + 1)
          j -= 1
        } else {
          break
        }
      }
    }
    return order
  }
}
