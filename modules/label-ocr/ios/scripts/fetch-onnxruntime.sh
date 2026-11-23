#!/usr/bin/env bash
# 下载 iOS 用的 ONNX Runtime（静态库 xcframework），校验后放到 modules/label-ocr/ios/Frameworks/。
# 打 iOS 包之前跑一次（和 scripts/fetch-ocr-models.sh 一样，下载的东西不进 git）。
#
# 用法：
#   modules/label-ocr/ios/scripts/fetch-onnxruntime.sh         只取 iOS 的 xcframework（打包用）
#   modules/label-ocr/ios/scripts/fetch-onnxruntime.sh --mac   另外取 macOS（Apple 芯片）的动态库和头文件，
#                                                              放到 ios/tests/.build/onnxruntime/，给 macOS 上的测试工具用
#
# 来源：ONNX Runtime 官方发布在 NuGet 上的 Microsoft.ML.OnnxRuntime 包（同一个包里有 iOS、macOS、安卓的库）。
# 为什么不用 CocoaPods 的 onnxruntime-c：它的下载地址 download.onnxruntime.ai 现在证书对不上、下不下来；
# GitHub 上的发布页也打不开。NuGet 包内容是同一份构建，包的 SHA-512 在 NuGet 上公开可查。
#
# 版本：安卓用 Maven 上的 onnxruntime-android 1.21.1；1.21.1 没有发 iOS / NuGet 包，这里用同一系列的 1.21.0。
# 需要：bash、curl、unzip，以及 shasum 或 sha512sum。
set -euo pipefail

VERSION=1.21.0
PACKAGE_URL="https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${VERSION}/microsoft.ml.onnxruntime.${VERSION}.nupkg"
# 整个 .nupkg 的 SHA-512（和 NuGet 目录里公布的 packageHash 是同一个值，那边是 base64）
PACKAGE_SHA512=3dd7711a4d7ab02c8ad01b9d384f4e3e8fdea7d88f8ead515cf3fe052736f63a104b2168f99ceb0e4dd0aeb70e619c356ae6ddb1d13f58c17b03e2a7fd7a1a1e
IOS_ZIP_SHA256=4a1e86cba16cd198ab7a2c3c23671d2304d027009f9300bdff29c6ae192943fd
MAC_DYLIB_SHA256=1bce2d05d778282c912e7fab6d5dfc5fa851f5797e8d0914a62d4adeb1d4d82b

IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRAMEWORKS_DIR="$IOS_DIR/Frameworks"
MAC_DIR="$IOS_DIR/tests/.build/onnxruntime"
WANT_MAC=0
[[ "${1:-}" == "--mac" ]] && WANT_MAC=1

sha512_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 512 "$1" | cut -d' ' -f1; else sha512sum "$1" | cut -d' ' -f1; fi
}
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

ios_ready() { [[ -f "$FRAMEWORKS_DIR/onnxruntime.version" && "$(cat "$FRAMEWORKS_DIR/onnxruntime.version")" == "$VERSION" && -d "$FRAMEWORKS_DIR/onnxruntime.xcframework" ]]; }
mac_ready() { [[ -f "$MAC_DIR/version" && "$(cat "$MAC_DIR/version")" == "$VERSION" && -f "$MAC_DIR/lib/libonnxruntime.dylib" ]]; }

if ios_ready && { [[ $WANT_MAC == 0 ]] || mac_ready; }; then
  echo "ONNX Runtime $VERSION 已经在了：$FRAMEWORKS_DIR"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "下载 ONNX Runtime ${VERSION}（约 120 MB）..."
curl -fsSL --retry 3 -o "$WORK/ort.nupkg" "$PACKAGE_URL"
actual="$(sha512_of "$WORK/ort.nupkg")"
if [[ "$actual" != "$PACKAGE_SHA512" ]]; then
  echo "校验失败：下载的包 SHA-512 是 ${actual}，应该是 $PACKAGE_SHA512" >&2
  exit 1
fi

if ! ios_ready; then
  unzip -q -o "$WORK/ort.nupkg" "runtimes/ios/native/onnxruntime.xcframework.zip" LICENSE ThirdPartyNotices.txt -d "$WORK/pkg"
  zip="$WORK/pkg/runtimes/ios/native/onnxruntime.xcframework.zip"
  [[ "$(sha256_of "$zip")" == "$IOS_ZIP_SHA256" ]] || { echo "校验失败：onnxruntime.xcframework.zip" >&2; exit 1; }
  rm -rf "$FRAMEWORKS_DIR/onnxruntime.xcframework"
  mkdir -p "$FRAMEWORKS_DIR"
  unzip -q -o "$zip" -d "$FRAMEWORKS_DIR"
  cp "$WORK/pkg/LICENSE" "$FRAMEWORKS_DIR/onnxruntime-LICENSE.txt"
  cp "$WORK/pkg/ThirdPartyNotices.txt" "$FRAMEWORKS_DIR/onnxruntime-ThirdPartyNotices.txt"
  echo "$VERSION" > "$FRAMEWORKS_DIR/onnxruntime.version"
  echo "iOS：$FRAMEWORKS_DIR/onnxruntime.xcframework"
fi

if [[ $WANT_MAC == 1 ]] && ! mac_ready; then
  unzip -q -o "$WORK/ort.nupkg" "runtimes/osx-arm64/native/libonnxruntime.dylib" "build/native/include/*" -d "$WORK/pkg"
  dylib="$WORK/pkg/runtimes/osx-arm64/native/libonnxruntime.dylib"
  [[ "$(sha256_of "$dylib")" == "$MAC_DYLIB_SHA256" ]] || { echo "校验失败：libonnxruntime.dylib" >&2; exit 1; }
  rm -rf "$MAC_DIR"
  mkdir -p "$MAC_DIR/lib" "$MAC_DIR/include"
  cp "$dylib" "$MAC_DIR/lib/"
  # 动态库自己登记的名字带版本号（@rpath/libonnxruntime.1.21.0.dylib），链接后按这个名字找
  ln -s libonnxruntime.dylib "$MAC_DIR/lib/libonnxruntime.${VERSION}.dylib"
  cp "$WORK/pkg/build/native/include/"*.h "$MAC_DIR/include/"
  echo "$VERSION" > "$MAC_DIR/version"
  echo "macOS：$MAC_DIR"
fi
