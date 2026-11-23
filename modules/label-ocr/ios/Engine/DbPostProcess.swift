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
/// - 框的得分：矩形里概率的平均（含边上的点）。
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

  /// 四边形里概率的平均（score_mode=fast）：照官方，角点坐标先取整，再看每个点在不在四边形里（含边）
  private static func boxScore(prob: [Float], predW: Int, predH: Int, corners: [PointD]) -> Double {
    let xs = corners.map(\.x)
    let ys = corners.map(\.y)
    let xMin = min(max(Int(xs.min()!.rounded(.down)), 0), predW - 1)
    let xMax = min(max(Int(xs.max()!.rounded(.up)), 0), predW - 1)
    let yMin = min(max(Int(ys.min()!.rounded(.down)), 0), predH - 1)
    let yMax = min(max(Int(ys.max()!.rounded(.up)), 0), predH - 1)
    // 和 Kotlin 的 toInt() 一样向 0 截断
    let quad = corners.map {
      PointD(x: Double(Int($0.x - Double(xMin))) + Double(xMin), y: Double(Int($0.y - Double(yMin))) + Double(yMin))
    }
    var sum = 0.0
    var count = 0
    if yMin <= yMax && xMin <= xMax {
      for y in yMin...yMax {
        for x in xMin...xMax where insideConvex(quad, Double(x), Double(y)) {
          sum += Double(prob[y * predW + x])
          count += 1
        }
      }
    }
    return count == 0 ? 0.0 : sum / Double(count)
  }

  private static func insideConvex(_ quad: [PointD], _ x: Double, _ y: Double) -> Bool {
    var positive = false
    var negative = false
    for index in quad.indices {
      let a = quad[index]
      let b = quad[(index + 1) % quad.count]
      let cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
      if cross > 1e-9 { positive = true }
      if cross < -1e-9 { negative = true }
      if positive && negative { return false }
    }
    return true
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
