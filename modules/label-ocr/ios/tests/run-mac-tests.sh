#!/usr/bin/env bash
# 在 macOS（Apple 芯片）上编译并测试 iOS 拍照识别引擎，一条命令重跑。不需要 Xcode，只要 Command Line Tools（swiftc、clang）。
#
# ios/Engine/ 是纯 Swift（Foundation、ImageIO、CoreGraphics），和 App 里是同一份代码；
# 这里用 swiftc 把它和 ONNX Runtime 的 macOS 版（同一版本 1.21.0）编成命令行工具来跑。
#
# 用法：
#   modules/label-ocr/ios/tests/run-mac-tests.sh [照片目录]
# 环境变量（都可选）：
#   LABEL_OCR_PHOTOS  照片目录（照片不进仓库）；也可以当第一个参数。不给就只跑单测和类型检查
#   ANDROID_RESULTS   安卓上同一批照片的识别结果（tests/fixtures/label-ocr/ 的格式，或者 {照片名: OcrResult} 的 JSON）；
#                     不给时在 tests/fixtures/label-ocr/ 里找文件名带 android 的
#   PADDLE_PYTHON     装了 paddleocr 3.x 的 Python（例如某个 venv 的 bin/python）；给了就和电脑上的 PaddleOCR 对照
#                     （整段对照 + 分阶段对照：同一张概率图、同一批裁好的行、同一个输入张量）
#
# 结果都在 modules/label-ocr/ios/tests/.build/results/ 下（不进 git）。
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$(cd "$TESTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$IOS_DIR/../../.." && pwd)"
BUILD="$TESTS_DIR/.build"
RESULTS="$BUILD/results"
MODELS="$IOS_DIR/../models/PP-OCRv6_small"
PHOTOS="${1:-${LABEL_OCR_PHOTOS:-}}"
mkdir -p "$BUILD" "$RESULTS"

step() { printf '\n==== %s\n' "$*"; }

step "准备 ONNX Runtime（macOS 版）和模型"
"$IOS_DIR/scripts/fetch-onnxruntime.sh" --mac
if [[ ! -f "$MODELS/det/inference.onnx" || ! -f "$MODELS/rec/inference.onnx" ]]; then
  "$REPO_ROOT/scripts/fetch-ocr-models.sh"
fi
ORT="$BUILD/onnxruntime"

step "编译"
cd "$IOS_DIR"
clang -O2 -Wall -Wextra -Werror -c OrtBridge/LabelOcrOrt.c -I "$ORT/include" -o "$BUILD/LabelOcrOrt.o"
swift_build() {
  local output="$1"
  shift
  swiftc -O -swift-version 5 -warnings-as-errors -import-objc-header OrtBridge/LabelOcrOrt.h Engine/*.swift "$@" \
    "$BUILD/LabelOcrOrt.o" -L "$ORT/lib" -lonnxruntime -Xlinker -rpath -Xlinker "$ORT/lib" -o "$BUILD/$output"
}
swift_build label-ocr-cli tests/cli/main.swift
swift_build label-ocr-stages tests/stages/main.swift
swift_build label-ocr-unit tests/unit/main.swift
echo "引擎和测试工具编译通过（$(swiftc --version 2>&1 | head -1)）"

step "Expo 胶水层类型检查（对照照抄签名的桩，不是真的 ExpoModulesCore，见 tests/expo-typecheck/）"
mkdir -p "$BUILD/expo-typecheck"
swiftc -emit-module -parse-as-library -module-name ExpoModulesCore tests/expo-typecheck/ExpoModulesCoreStub.swift \
  -emit-module-path "$BUILD/expo-typecheck/ExpoModulesCore.swiftmodule"
swiftc -typecheck -swift-version 5 -warnings-as-errors -module-name LabelOcr -I "$BUILD/expo-typecheck" \
  -import-objc-header OrtBridge/LabelOcrOrt.h LabelOcrModule.swift Engine/*.swift
echo "LabelOcrModule.swift 类型检查通过"

step "单测"
unit_args=(--models "$MODELS")
if [[ -n "${PADDLE_PYTHON:-}" ]]; then
  # 参考字典：PyYAML 读出来的 character_dict
  "$PADDLE_PYTHON" -I -c "
import json, sys, yaml
data = yaml.safe_load(open(sys.argv[1], encoding='utf-8'))
json.dump(data['PostProcess']['character_dict'], open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
" "$MODELS/rec/inference.yml" "$BUILD/dict-pyyaml.json"
  unit_args+=(--dict-reference "$BUILD/dict-pyyaml.json")
fi
"$BUILD/label-ocr-unit" "${unit_args[@]}"

if [[ -z "$PHOTOS" ]]; then
  echo
  echo "没给照片目录（参数或 LABEL_OCR_PHOTOS），端到端识别和对照跳过"
  exit 0
fi

shopt -s nullglob nocaseglob
photos=("$PHOTOS"/*.jpg "$PHOTOS"/*.jpeg "$PHOTOS"/*.png "$PHOTOS"/*.heic)
shopt -u nullglob nocaseglob
# 只要 photo1.jpg 这种原图，不要试验时转过的副本
filtered=()
for photo in "${photos[@]}"; do
  [[ "$(basename "$photo")" == rotated-* ]] || filtered+=("$photo")
done
photos=("${filtered[@]}")
[[ ${#photos[@]} -gt 0 ]] || { echo "照片目录里没有图片：$PHOTOS" >&2; exit 1; }

step "端到端识别（每张跑 3 次：第 1 次含加载模型，耗时取后面的）"
"$BUILD/label-ocr-cli" --models "$MODELS" --out "$RESULTS/ios.json" --repeat 3 "${photos[@]}"

android="${ANDROID_RESULTS:-}"
if [[ -z "$android" ]]; then
  for candidate in "$REPO_ROOT"/tests/fixtures/label-ocr/*android*.json; do
    [[ -f "$candidate" ]] && android="$candidate" && break
  done
fi
if [[ -n "$android" ]]; then
  step "和安卓逐行对照：$android"
  python3 "$TESTS_DIR/compare.py" "$RESULTS/ios.json" "$android" --label-a iOS --label-b 安卓 \
    --json "$RESULTS/compare-android.json" || true
  if [[ -n "${PADDLE_PYTHON:-}" ]]; then
    # iOS 用系统的 JPEG 解码（ImageIO），安卓用 libjpeg-turbo，两边解出来的像素有一点差别。
    # 用 libjpeg-turbo（PIL）解好存成 PNG 再给 iOS 引擎，输入像素和安卓一样，结果应该和安卓逐字、逐像素一样
    step "和安卓逐行对照（输入像素也一样：用 libjpeg-turbo 解码后给 iOS 引擎）"
    rm -rf "$RESULTS/libjpeg-png"
    mkdir -p "$RESULTS/libjpeg-png"
    "$PADDLE_PYTHON" -I -c "
import sys
from pathlib import Path
from PIL import Image, ImageOps
out = Path(sys.argv[1])
for photo in map(Path, sys.argv[2:]):
    with Image.open(photo) as image:
        ImageOps.exif_transpose(image).convert('RGB').save(out / (photo.stem + '.png'))
" "$RESULTS/libjpeg-png" "${photos[@]}"
    "$BUILD/label-ocr-cli" --models "$MODELS" --out "$RESULTS/ios-libjpeg.json" "$RESULTS/libjpeg-png"/*.png >/dev/null
    python3 "$TESTS_DIR/compare.py" "$RESULTS/ios-libjpeg.json" "$android" --label-a "iOS（libjpeg 像素）" --label-b 安卓 \
      --quiet --max-box-px 0 --max-score-diff 0 --json "$RESULTS/compare-android-libjpeg.json" \
      && echo "同样的像素输入，iOS 和安卓的结果完全一样" || echo "同样的像素输入，iOS 和安卓的结果有差别（见上）"
  fi
else
  echo
  echo "没找到安卓的识别结果（ANDROID_RESULTS 或 tests/fixtures/label-ocr/*android*.json），和安卓的对照跳过"
fi

if [[ -n "${PADDLE_PYTHON:-}" ]]; then
  step "电脑上的 PaddleOCR：按 iOS 认出的方向把照片转正后识别"
  "$PADDLE_PYTHON" -I "$TESTS_DIR/paddle_reference.py" --out "$RESULTS/paddle.json" --rotate-like "$RESULTS/ios.json" \
    "${photos[@]}" 2>&1 | grep -v -i -E 'warn|creating model|model files already' || true
  step "和 PaddleOCR 逐行对照"
  python3 "$TESTS_DIR/compare.py" "$RESULTS/ios.json" "$RESULTS/paddle.json" --label-a iOS --label-b PaddleOCR \
    --json "$RESULTS/compare-paddle.json" || true

  step "分阶段对照（每一段吃和 PaddleOCR 一样的输入）"
  rm -rf "$RESULTS/stages"
  "$PADDLE_PYTHON" -I "$TESTS_DIR/paddle_stages.py" --out "$RESULTS/stages" --rotate-like "$RESULTS/ios.json" \
    "${photos[@]}" 2>&1 | grep -v -i -E 'warn|creating model|model files already' || true
  "$BUILD/label-ocr-stages" --models "$MODELS" --stages "$RESULTS/stages" --out "$RESULTS/stages-ios.json"
  python3 "$TESTS_DIR/stage_compare.py" "$RESULTS/stages" "$RESULTS/stages-ios.json" --json "$RESULTS/compare-stages.json"
else
  echo
  echo "没给 PADDLE_PYTHON，和电脑上 PaddleOCR 的对照跳过"
fi
