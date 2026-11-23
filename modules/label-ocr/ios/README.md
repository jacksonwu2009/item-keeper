# 拍照识别 · iOS 原生模块

`modules/label-ocr` 的 iOS 部分（Swift）。和安卓一样：在手机上用 PaddleOCR 的 PP-OCRv6_small 模型、ONNX Runtime 推理，
把一张图片变成一行行文字（文字、四个角的位置、置信度）。不联网，照片不出手机。JS 接口见 `../index.ts`、`../src/LabelOcr.types.ts`，两端完全一样。

## 打 iOS 包（给打包的人）

这台开发机装不了 Xcode，iOS 包用 Expo 的云端构建（EAS Build）打。

### 需要

- 付费的苹果开发者账号（Apple Developer Program）：装到真机要用它签名。EAS 会引导你登录、自动生成证书和描述文件。
- Expo 账号：EAS 云端构建要登录（`npx eas-cli@latest login`）。
- 一台 iPhone，iOS 16.4 或更新（Expo SDK 58 的最低版本；ONNX Runtime 1.21 要求 15.1，不另外抬高）。
- 自己的电脑：Node.js、npm、`curl`、`unzip`，能上网（要下载模型和 ONNX Runtime，一共约 150 MB）。
  用 EAS 云端构建时本机**不需要** Xcode；要在自己的 Mac 上打包（`npx expo run:ios`）才需要 Xcode 16 或更新。

### 步骤

在项目根目录：

```bash
npm ci

# 1. 下载模型（和安卓共用，放 modules/label-ocr/models/，不进 git）
scripts/fetch-ocr-models.sh

# 2. 下载 iOS 用的 ONNX Runtime（静态库，放 modules/label-ocr/ios/Frameworks/，不进 git）
modules/label-ocr/ios/scripts/fetch-onnxruntime.sh
```

两个脚本都会校验文件的 SHA-256 / SHA-512，已经下好的不会重下。缺了任何一个，`pod install`（EAS 打包时会跑）会直接报错并提示运行这两个脚本。

这两样东西不进 git，但打包要用。EAS 上传项目时默认按 `.gitignore` 跳过文件，所以项目根目录有一个 `.easignore`
（内容和 `.gitignore` 一样，只是不忽略这两个目录），上传时会带上它们。想确认上传包里有没有：

```bash
npx eas-cli@latest build:inspect --platform ios --profile development --stage archive --output ./eas-archive
ls ./eas-archive/modules/label-ocr/models/PP-OCRv6_small ./eas-archive/modules/label-ocr/ios/Frameworks
```

#### 打开发版（development build）

Expo Go 里只有它自带的原生模块，加载不了这个模块（`isLabelOcrAvailable()` 是 false），所以要打自己的开发版：

```bash
# 开发版要 expo-dev-client（会改 package.json，第一次打的时候装）
npx expo install expo-dev-client

# 没有 eas.json 时生成一个（里面有 development 配置：developmentClient: true、distribution: internal）
npx eas-cli@latest build:configure

# 内部分发要先登记 iPhone（按提示在手机上打开链接、装描述文件）
npx eas-cli@latest device:create

# 云端打包
npx eas-cli@latest build --profile development --platform ios
```

打完 EAS 会给一个链接 / 二维码，用 iPhone 打开安装。iOS 16 起第一次打开要先开「设置 → 隐私与安全性 → 开发者模式」，重启后确认。

开发版只是一个壳，界面代码从电脑上的开发服务器加载：

```bash
npx expo start --dev-client
```

手机和电脑在同一个网络里，打开 App 选这台电脑（或扫终端里的二维码）。

> 不想连开发服务器的话，可以改打内部分发的预览版（JS 打包在里面）：`eas.json` 里加一个
> `"preview": { "distribution": "internal" }`，然后 `npx eas-cli@latest build --profile preview --platform ios`，不用装 expo-dev-client。

### 装好以后怎么验证

先断网（开飞行模式）也试一次：识别全在手机上做，断网应该照样能用。

1. **入库拍日期**：找一个已有的物品 → 入库 → 生产日期（或过期日期）旁边点「拍日期」→ 小取景框只框住喷码拍一张。
   - 只认出一个日期时直接填进去；认出几个时上面显示裁出来的那一小块，下面列候选点选。
   - 商品资料里有保质期时，会按生产日期算出到期日；喷码上也印了到期日时互相对照，对上了打勾。
2. **新增物品拍包装**：扫一个本机和商品库都没有的条码 → 条码下面点「拍包装识别」→ 先拍背面标签，标签写「见瓶盖 / 见封口」时接着拍喷码（可跳过），也可以从相册选。
   - 核对页里认出来的格子是蓝底、标「识别」，点开能改；没认出的留空、标「没认出来」。
   - 点「保存」才保存。

每一种最好都试：横着拍、竖着拍、包装侧着拍（字是竖的，App 会自己转正）、从相册选 iPhone 拍的 HEIC 照片、反光或很暗的（应该提示重拍）。

识别过程的日志在 Mac 的「控制台」App 里（连上手机，搜 `LabelOcr`）：每次识别一行，带图片大小、认出几行、转了几度、加载 / 读图 / 检测 / 识别各用了多少毫秒。
第一次识别要加载模型（几百毫秒到一两秒），之后一张一般在一秒以内。

## 代码结构

| 路径 | 内容 |
| --- | --- |
| `LabelOcrModule.swift` | Expo 胶水：`prepareAsync`、`recognizeAsync`，排到串行后台队列，错误转成 `ERR_LABEL_OCR_*` |
| `Engine/` | 纯 Swift 引擎，只用 Foundation、ImageIO、CoreGraphics（不依赖 UIKit、Expo）：读图摆正裁剪、检测前处理、DB 后处理、裁行、识别前处理、CTC 解码、方向判断 |
| `Engine/LabelOcrRunner.swift` | 「uri → 返回给 JS 的结果」整段，App 和 macOS 测试工具都调它 |
| `OrtBridge/` | ONNX Runtime C API 的一层 C 包装（onnxruntime 的 xcframework 没有 module map，Swift 不能直接引用它的头文件） |
| `scripts/fetch-onnxruntime.sh` | 下载、校验 ONNX Runtime 1.21.0（官方 NuGet 包 Microsoft.ML.OnnxRuntime 里的 iOS xcframework） |
| `../LabelOcr.podspec` | CocoaPods 配置。放在 `modules/label-ocr/` 下而不是 `ios/` 下：模型在共用的 `models/`，CocoaPods 只能打包 podspec 所在目录里的文件 |
| `tests/` | macOS 上的测试（不打进 App），见下面 |

算法和安卓（`../android/.../*.kt`）一一对应：同样的缩放、DB 后处理（连通块 + 凸包 + 最小外接矩形 + unclip）、
裁行、识别输入、CTC 解码和方向判断，参数也一样（检测长边最多 1600、DB 0.3 / 0.6 / 1.5、读图长边最多 2560）。改一边时另一边也要改。

ONNX Runtime 不用 CocoaPods 上的 `onnxruntime-c`：它的下载地址（download.onnxruntime.ai）现在证书不对、下不下来。
NuGet 上的官方包里是同一份 iOS 构建，版本和安卓（Maven 上的 1.21.1）同一系列。

## 在 Mac 上测试（不需要 Xcode）

```bash
modules/label-ocr/ios/tests/run-mac-tests.sh <照片目录>
# 可选：ANDROID_RESULTS=<安卓结果>  PADDLE_PYTHON=<装了 paddleocr 3.x 的 python>
```

只要 Command Line Tools（`swiftc`、`clang`）。脚本会下载 macOS 版的 ONNX Runtime（同一个版本），然后：

1. 把 `Engine/` 和测试工具编译成命令行程序（和 App 是同一份 Swift 代码）；
2. 用照抄 ExpoModulesCore 签名的桩模块给 `LabelOcrModule.swift` 做类型检查（真的 ExpoModulesCore 在这里编不了）；
3. 单测（`tests/unit/`）：几何、DB 后处理、CTC、yml 字典解析（给了 `PADDLE_PYTHON` 时逐字和 PyYAML 读的比）、
   EXIF 八种方向和 crop（和 ImageIO 自己摆正的结果逐像素比）；
4. 端到端：照片目录里每张图识别 3 次（`tests/cli/`），结果和耗时写到 `tests/.build/results/ios.json`；
5. 和安卓的结果逐行对照（`tests/compare.py`）；
6. 给了 `PADDLE_PYTHON` 时和电脑上的 PaddleOCR 对照：整段逐行对照，再分阶段对照（`tests/paddle_stages.py`、
   `tests/stages/`、`tests/stage_compare.py`）——同一张检测概率图比后处理、同一批裁好的行比识别、同一个输入张量比模型输出。

照片不进仓库。
