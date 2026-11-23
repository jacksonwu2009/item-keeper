# 拍照识别测试数据

`src/lib/labelParse.ts`（RN）和鸿蒙版 `LabelParse.ets` 用同一批数据，保证几端从同样的文字里认出同样的字段。
照片本身不进仓库，这里只有识别出的文字行。

## 文件

| 文件 | 内容 |
| --- | --- |
| `round1-desktop-PP-OCRv6_small.json` 等 | 第一轮准确率试验：4 张照片在电脑上用 PaddleOCR 3.7 三种手机端模型识别的结果 |
| `round1-desktop-apple-vision.json` | 同一批照片用 macOS Vision（和 iOS 系统识别同一套）识别：没有位置，置信度只有三档 |
| `round1-android-PP-OCRv6_small.json` | 同一批照片在安卓模拟器上用 App 里的原生模块 modules/label-ocr 识别的结果（iOS 原生模块逐行对照用；timing 是那一次的耗时，测试不看） |
| `rules.json` | 手写的规则用例，每条只测一两条规则 |

## 格式（`label-ocr-fixture/1`）

```jsonc
{
  "format": "label-ocr-fixture/1",
  "source": "数据从哪来",
  "engine": "PP-OCRv6_small",        // 识别引擎；手写用例是 handwritten
  "today": "2026-11-22",             // 判断日期合不合理用的「今天」
  "items": [
    {
      "id": "photo1",
      "description": "说明（可选）",
      "width": 720, "height": 1280,  // 坐标系大小（可选）：图片摆正、转正以后的宽高
      "rotation": 0,                 // 为了让字正过来图顺时针转了几度（可选）；lines 的坐标是转正以后的
      "timing": {"totalMs": 5153},   // 可选，识别耗时，只是记录
      "today": "2026-11-22",         // 可选，覆盖上面的
      "target": "production",        // 可选：点的是哪一格的「拍日期」，production / expiry，默认 production
      "shelfLife": {"amount": 12, "unit": "month"}, // 可选：商品资料里已知的保质期，不给就用标签上认出的
      "lines": [
        // 一行字：text 必填；score 是 0–1 的置信度，没有时当 1；
        // box 是四个角 [x, y]（左上、右上、右下、左下），没有位置时是 null 或不写
        {"text": "产品名称：维达纸手帕", "score": 0.964, "box": [[110, 532], [511, 540], [510, 580], [109, 572]]}
      ],
      // 写了的键才比；null 表示应该认不出来
      "expect": {
        "name": "维达纸手帕",          // parseLabel().name
        "nameCandidates": [],          // parseLabel().nameCandidates
        "spec": null,                  // parseLabel().spec
        "shelfLife": {"amount": 3, "unit": "year"}, // unit 是 day / month / year
        "dateElsewhere": "见包装",      // 生产日期印在别处
        "dates": ["2026-09-24"],       // 认出的日期，按出现顺序
        "poor": false,                 // 要不要提示重拍
        "production": null,            // decideDates() 直接能填的生产日期
        "expiry": null,                // decideDates() 直接能填的到期日
        "confirmed": false,            // 生产日期 + 保质期 和到期日对上了
        "options": 0,                  // 分不清时列给人选的个数
        "suggested": -1                // 建议选第几个（下标），没有是 -1
      }
    }
  ]
}
```

decideDates 的参数：`shelfLife` 用 item 里的，没有就用 parseLabel 认出的；`today` 用 item 或文件的；`target` 默认 production。
