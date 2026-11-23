#!/usr/bin/env bash
# 本机打安卓安装包（APK），不需要 Expo 账号。
#
# 需要：
#   - JDK 17 或更新（运行 Gradle 用；React Native 的构建会按需自动准备 JDK 17 工具链）
#   - Android SDK：platforms;android-37.0、build-tools;37.0.0、ndk;27.1.12297006、cmake;3.22.1
#     （brew install --cask android-commandlinetools，再用 sdkmanager 安装）
#
# 用法：
#   scripts/build-android.sh            只打 arm64（现在的安卓手机基本都是），包小、打得快
#   ARCHS=armeabi-v7a,arm64-v8a scripts/build-android.sh   兼容老手机
#
# 产物：dist/item-keeper-<版本>.apk。release 包用调试签名，只适合自己装，不能上架。
# 拍照识别的模型不在 git 里，打包前先下载（已有且校验对的不再下），见 scripts/fetch-ocr-models.sh。
set -euo pipefail

cd "$(dirname "$0")/.."
: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@25}"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
: "${ARCHS:=arm64-v8a}"
export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME" NODE_ENV=production

scripts/fetch-ocr-models.sh

CI=1 npx expo prebuild --platform android --no-install
git checkout -- package.json 2>/dev/null || true   # prebuild 会改 scripts，保持原样

(cd android && ./gradlew assembleRelease -PreactNativeArchitectures="$ARCHS" --console=plain)

version=$(node -p "require('./app.json').expo.version")
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk "dist/item-keeper-$version.apk"
echo "APK: dist/item-keeper-$version.apk"
