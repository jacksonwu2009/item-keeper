#!/usr/bin/env bash
# 准备拍照识别用的模型（PaddleOCR PP-OCRv6_small，ONNX 格式）：下载官方原版并校验 sha256，
# 再用 scripts/quantize-ocr-models.mjs 把权重压小（int8 / fp16，推理时还原成 float，见那个脚本），校验输出的 sha256。
#
# 安装包里放压过的版本（约 13 MB，官方原版约 31 MB），在 modules/label-ocr/models/PP-OCRv6_small/{det,rec}/，不进 git；
# 安卓打包时当作 assets 打进去（modules/label-ocr/android/build.gradle），iOS 也从这个目录打包。
# 官方原版下载到工程外的缓存目录（默认 ~/.cache/item-keeper/ocr-models/，几个工作区共用），不会打进安装包。
# 已经有、校验对的都不再下、不再压。scripts/build-android.sh 打包前会先跑这个脚本。
#
# 需要：curl、tar、shasum（或 sha256sum）、Node.js（工程本来就要，压模型只用 Node 自带的功能）。
#
# 来源：PaddlePaddle 官方发布的 ONNX 模型（Apache-2.0）。先从 Hugging Face 按固定版本下载，
# 下不了再用飞桨的模型镜像（同一份文件，sha256 一样）。
#
# 用法：scripts/fetch-ocr-models.sh
# 环境变量（可选）：ITEM_KEEPER_CACHE_DIR  缓存目录，默认 ${XDG_CACHE_HOME:-~/.cache}/item-keeper
set -euo pipefail

cd "$(dirname "$0")/.."
models_dir="modules/label-ocr/models/PP-OCRv6_small"
cache_dir="${ITEM_KEEPER_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/item-keeper}"
original_dir="${cache_dir}/ocr-models/PP-OCRv6_small"

# 子目录 Hugging Face 仓库 固定版本
det_repo="PaddlePaddle/PP-OCRv6_small_det_onnx"
det_revision="28fe5895c24fd108c19eb3e8479f4ab385fbfc62"
rec_repo="PaddlePaddle/PP-OCRv6_small_rec_onnx"
rec_revision="b8f84f0b80c529de40b4fbb3544b84fa7233a513"
mirror_base="https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"

# 官方原版文件的 sha256
original_sha256() {
  case "$1" in
    det/inference.onnx) echo d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e ;;
    det/inference.yml) echo 193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516 ;;
    rec/inference.onnx) echo 5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634 ;;
    rec/inference.yml) echo ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1 ;;
    *) return 1 ;;
  esac
}

# 打包用的文件的 sha256：模型是压过的（改了 quantize-ocr-models.mjs 要跟着改这里），yml 和原版一样
packed_sha256() {
  case "$1" in
    det/inference.onnx) echo 1644fa01899220f687b6a6c6fec37bd10771054231aaac76a41fdbd8b1535276 ;;
    rec/inference.onnx) echo 6b76f3040ccd850cdaefae93c1fb74afc8d7502a5e36ab9d9e4d59b6da57edb6 ;;
    *) original_sha256 "$1" ;;
  esac
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

# matches <文件> <sha256>
matches() {
  [ -f "$1" ] && [ "$(sha256_of "$1")" = "$2" ]
}

original_ok() {
  matches "${original_dir}/$1/inference.onnx" "$(original_sha256 "$1/inference.onnx")" &&
    matches "${original_dir}/$1/inference.yml" "$(original_sha256 "$1/inference.yml")"
}

# 从镜像下载整个包（tar），解出里面的文件
fetch_from_mirror() {
  local part="$1" tmp
  tmp="$(mktemp -d)"
  echo "  从飞桨模型镜像下载 PP-OCRv6_small_${part}_onnx_infer.tar"
  curl -fsSL --retry 3 --max-time 900 -o "${tmp}/model.tar" "${mirror_base}/PP-OCRv6_small_${part}_onnx_infer.tar"
  tar -xf "${tmp}/model.tar" -C "${tmp}"
  mkdir -p "${original_dir}/${part}"
  cp "${tmp}/PP-OCRv6_small_${part}_onnx_infer/inference.onnx" "${tmp}/PP-OCRv6_small_${part}_onnx_infer/inference.yml" "${original_dir}/${part}/"
  rm -rf "${tmp}"
}

fetch_original() {
  local part="$1" repo="$2" revision="$3" file
  if original_ok "${part}"; then
    return
  fi
  mkdir -p "${original_dir}/${part}"
  # 以前的版本把官方原版直接放在 models_dir 里：有的话拷过来，不用再下
  for file in inference.onnx inference.yml; do
    if matches "${models_dir}/${part}/${file}" "$(original_sha256 "${part}/${file}")"; then
      cp "${models_dir}/${part}/${file}" "${original_dir}/${part}/${file}"
    fi
  done
  if original_ok "${part}"; then
    return
  fi
  echo "${part}：下载官方原版到 ${original_dir}/${part}"
  local ok=1
  for file in inference.onnx inference.yml; do
    if ! curl -fsSL --retry 3 --max-time 900 -o "${original_dir}/${part}/${file}.part" \
      "https://huggingface.co/${repo}/resolve/${revision}/${file}"; then
      ok=0
      break
    fi
    mv "${original_dir}/${part}/${file}.part" "${original_dir}/${part}/${file}"
  done
  rm -f "${original_dir}/${part}"/*.part
  if [ "${ok}" = 0 ] || ! original_ok "${part}"; then
    echo "  Hugging Face 下载失败或校验不对，换镜像"
    fetch_from_mirror "${part}"
  fi
  for file in inference.onnx inference.yml; do
    if ! matches "${original_dir}/${part}/${file}" "$(original_sha256 "${part}/${file}")"; then
      echo "错误：${original_dir}/${part}/${file} 的 sha256 不对（应为 $(original_sha256 "${part}/${file}")）" >&2
      exit 1
    fi
  done
  echo "  校验通过"
}

pack_part() {
  local part="$1" repo="$2" revision="$3"
  if matches "${models_dir}/${part}/inference.onnx" "$(packed_sha256 "${part}/inference.onnx")" &&
    matches "${models_dir}/${part}/inference.yml" "$(packed_sha256 "${part}/inference.yml")"; then
    echo "${part}：已有，校验通过"
    return
  fi
  fetch_original "${part}" "${repo}" "${revision}"
  echo "${part}：压缩权重"
  mkdir -p "${models_dir}/${part}"
  node scripts/quantize-ocr-models.mjs "${original_dir}/${part}/inference.onnx" "${models_dir}/${part}/inference.onnx.part" "${part}"
  if ! matches "${models_dir}/${part}/inference.onnx.part" "$(packed_sha256 "${part}/inference.onnx")"; then
    rm -f "${models_dir}/${part}/inference.onnx.part"
    echo "错误：压出来的 ${part}/inference.onnx 和预期的不一样（sha256 应为 $(packed_sha256 "${part}/inference.onnx")）。" >&2
    echo "改过 scripts/quantize-ocr-models.mjs 的话，要重新对照识别效果，再更新这里的 sha256" >&2
    exit 1
  fi
  mv "${models_dir}/${part}/inference.onnx.part" "${models_dir}/${part}/inference.onnx"
  cp "${original_dir}/${part}/inference.yml" "${models_dir}/${part}/inference.yml"
  echo "  校验通过"
}

pack_part det "${det_repo}" "${det_revision}"
pack_part rec "${rec_repo}" "${rec_revision}"
echo "模型在 ${models_dir}"
