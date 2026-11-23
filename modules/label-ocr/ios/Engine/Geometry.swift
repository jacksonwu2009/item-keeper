import Foundation

/// 检测后处理要用的几何计算（凸包、最小外接矩形、角点排序、unclip）。
/// 官方示例用 OpenCV 的 minAreaRect、findContours 和 Clipper，这里自己写；算法和安卓的 Geometry.kt 一一对应，
/// 两端同一张图算出来的框应该一样。坐标都是像素，y 向下。
enum Geometry {
  /// 四舍六入五成双（和 Python round、PaddleX 一样）
  static func roundHalfToEven(_ value: Double) -> Int {
    let floored = value.rounded(.down)
    let diff = value - floored
    let base = Int(floored)
    if diff < 0.5 { return base }
    if diff > 0.5 { return base + 1 }
    return base % 2 == 0 ? base : base + 1
  }

  static func distance(_ a: PointD, _ b: PointD) -> Double {
    hypot(a.x - b.x, a.y - b.y)
  }

  private static func cross(_ o: PointD, _ a: PointD, _ b: PointD) -> Double {
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  }

  /// 去重，保留第一次出现的顺序
  private static func distinct(_ points: [PointD]) -> [PointD] {
    var seen = Set<PointD>()
    var result: [PointD] = []
    result.reserveCapacity(points.count)
    for point in points where seen.insert(point).inserted {
      result.append(point)
    }
    return result
  }

  /// 凸包（Andrew 单调链），不含共线点
  static func convexHull(_ points: [PointD]) -> [PointD] {
    if points.count <= 2 { return distinct(points) }
    let sorted = distinct(points).sorted { $0.x != $1.x ? $0.x < $1.x : $0.y < $1.y }
    if sorted.count <= 2 { return sorted }
    var hull: [PointD] = []
    hull.reserveCapacity(sorted.count * 2)
    for point in sorted {
      while hull.count >= 2 && cross(hull[hull.count - 2], hull[hull.count - 1], point) <= 0 {
        hull.removeLast()
      }
      hull.append(point)
    }
    let lowerSize = hull.count + 1
    for index in stride(from: sorted.count - 2, through: 0, by: -1) {
      let point = sorted[index]
      while hull.count >= lowerSize && cross(hull[hull.count - 2], hull[hull.count - 1], point) <= 0 {
        hull.removeLast()
      }
      hull.append(point)
    }
    hull.removeLast()
    return hull
  }

  /// 最小外接矩形：四个角（还没排序）和短边长度
  struct MinRect {
    let corners: [PointD]
    let shortSide: Double
  }

  /// 最小外接矩形（对应 OpenCV minAreaRect）：凸包上逐条边做旋转卡壳，面积最小的那个
  static func minAreaRect(_ points: [PointD]) -> MinRect {
    let hull = convexHull(points)
    guard let first = hull.first else {
      return MinRect(corners: Array(repeating: PointD(x: 0, y: 0), count: 4), shortSide: 0)
    }
    if hull.count == 1 {
      return MinRect(corners: Array(repeating: first, count: 4), shortSide: 0)
    }
    var bestArea = Double.greatestFiniteMagnitude
    var best: MinRect?
    for index in hull.indices {
      let a = hull[index]
      let b = hull[(index + 1) % hull.count]
      let length = distance(a, b)
      if length <= 1e-9 { continue }
      let ux = (b.x - a.x) / length
      let uy = (b.y - a.y) / length
      // 法向量
      let vx = -uy
      let vy = ux
      var minU = Double.greatestFiniteMagnitude
      var maxU = -Double.greatestFiniteMagnitude
      var minV = Double.greatestFiniteMagnitude
      var maxV = -Double.greatestFiniteMagnitude
      for point in hull {
        let u = (point.x - a.x) * ux + (point.y - a.y) * uy
        let v = (point.x - a.x) * vx + (point.y - a.y) * vy
        if u < minU { minU = u }
        if u > maxU { maxU = u }
        if v < minV { minV = v }
        if v > maxV { maxV = v }
      }
      let width = maxU - minU
      let height = maxV - minV
      let area = width * height
      if area < bestArea {
        bestArea = area
        func at(_ u: Double, _ v: Double) -> PointD {
          PointD(x: a.x + u * ux + v * vx, y: a.y + u * uy + v * vy)
        }
        best = MinRect(
          corners: [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)],
          shortSide: min(width, height))
      }
    }
    return best ?? MinRect(corners: Array(repeating: first, count: 4), shortSide: 0)
  }

  /// 按 x 稳定排序（插入排序，四个点）。Kotlin 的 sortedBy 是稳定的，这里也要稳定
  private static func stableSortedByX(_ points: [PointD]) -> [PointD] {
    var sorted = points
    if sorted.count < 2 { return sorted }
    for index in 1..<sorted.count {
      let item = sorted[index]
      var position = index - 1
      while position >= 0 && sorted[position].x > item.x {
        sorted[position + 1] = sorted[position]
        position -= 1
      }
      sorted[position + 1] = item
    }
    return sorted
  }

  /// 把矩形四个角排成左上、右上、右下、左下（照官方示例：按 x 排序，左边两个里 y 小的是左上，右边两个里 y 小的是右上）
  static func orderCorners(_ points: [PointD]) -> [PointD] {
    let sorted = stableSortedByX(points)
    let (topLeft, bottomLeft) = sorted[1].y > sorted[0].y ? (sorted[0], sorted[1]) : (sorted[1], sorted[0])
    let (topRight, bottomRight) = sorted[3].y > sorted[2].y ? (sorted[2], sorted[3]) : (sorted[3], sorted[2])
    return [topLeft, topRight, bottomRight, bottomLeft]
  }

  private static let eps = 1e-6
  private static let arcTolerance = 0.25

  /// 把检测到的框往外扩（DB 后处理的 unclip）：扩出去的距离 = 面积 × unclipRatio / 周长，拐角是圆弧。
  /// 对应 PaddleX 用的 pyclipper 圆角偏移（和安卓一样用浮点算，不取整）。
  static func unclip(_ points: [PointD], ratio unclipRatio: Double) -> [PointD] {
    if points.count < 3 { return points }
    var signedArea = 0.0
    var perimeter = 0.0
    for index in points.indices {
      let p1 = points[index]
      let p2 = points[(index + 1) % points.count]
      signedArea += p1.x * p2.y - p2.x * p1.y
      perimeter += distance(p1, p2)
    }
    signedArea /= 2.0
    let area = abs(signedArea)
    if !area.isFinite || !perimeter.isFinite || area <= eps || perimeter <= eps { return points }
    let offset = area * unclipRatio / perimeter
    if !offset.isFinite || offset <= eps { return points }
    let clockwise = signedArea > 0.0
    var normals: [PointD] = []
    normals.reserveCapacity(points.count)
    for index in points.indices {
      let start = points[index]
      let end = points[(index + 1) % points.count]
      let dx = end.x - start.x
      let dy = end.y - start.y
      let length = hypot(dx, dy)
      if !length.isFinite || length <= eps { return points }
      normals.append(clockwise ? PointD(x: dy / length, y: -dx / length) : PointD(x: -dy / length, y: dx / length))
    }
    var expanded: [PointD] = []
    for index in points.indices {
      let center = points[index]
      let from = normals[(index - 1 + normals.count) % normals.count]
      let to = normals[index]
      let startAngle = atan2(from.y, from.x)
      var endAngle = atan2(to.y, to.x)
      if clockwise {
        while endAngle < startAngle { endAngle += 2.0 * Double.pi }
      } else {
        while endAngle > startAngle { endAngle -= 2.0 * Double.pi }
      }
      let sweep = endAngle - startAngle
      let ratio = min(max(1.0 - arcTolerance / offset, -1.0), 1.0)
      let halfStep = acos(ratio)
      let step = 2.0 * ((halfStep.isFinite && halfStep > eps) ? halfStep : Double.pi / 16.0)
      let steps = max(Int((abs(sweep) / step).rounded(.up)), 1)
      for stepIndex in 0...steps {
        let angle = startAngle + sweep * Double(stepIndex) / Double(steps)
        let point = PointD(x: center.x + cos(angle) * offset, y: center.y + sin(angle) * offset)
        if let last = expanded.last, distance(point, last) <= eps { continue }
        expanded.append(point)
      }
    }
    return expanded.count >= 3 ? expanded : points
  }
}
