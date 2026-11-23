#!/usr/bin/env bash
# 下载拍照识别用的模型（PaddleOCR PP-OCRv6_small，ONNX 格式），校验 sha256。
#
# 模型几十 MB，不进 git。放到 modules/label-ocr/models/PP-OCRv6_small/{det,rec}/，
# 安卓打包时当作 assets 打进去（modules/label-ocr/android/build.gradle），iOS 也从这个目录打包。
# 已经下好、校验对的不再下。scripts/build-android.sh 打包前会先跑这个脚本。
#
# 来源：PaddlePaddle 官方发布的 ONNX 模型（Apache-2.0）。先从 Hugging Face 按固定版本下载，
# 下不了再用飞桨的模型镜像（同一份文件，sha256 一样）。
#
# 用法：scripts/fetch-ocr-models.sh
set -euo pipefail

cd "$(dirname "$0")/.."
models_dir="modules/label-ocr/models/PP-OCRv6_small"

# 子目录 Hugging Face 仓库 固定版本
det_repo="PaddlePaddle/PP-OCRv6_small_det_onnx"
det_revision="28fe5895c24fd108c19eb3e8479f4ab385fbfc62"
rec_repo="PaddlePaddle/PP-OCRv6_small_rec_onnx"
rec_revision="b8f84f0b80c529de40b4fbb3544b84fa7233a513"
mirror_base="https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"

# 文件 sha256
expected_sha256() {
  case "$1" in
    det/inference.onnx) echo d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e ;;
    det/inference.yml) echo 193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516 ;;
    rec/inference.onnx) echo 5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634 ;;
    rec/inference.yml) echo ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1 ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

is_valid() {
  [ -f "${models_dir}/$1" ] && [ "$(sha256_of "${models_dir}/$1")" = "$(expected_sha256 "$1")" ]
}

# 从镜像下载整个包（tar），解出里面的文件
fetch_from_mirror() {
  local part="$1" tmp
  tmp="$(mktemp -d)"
  echo "  从飞桨模型镜像下载 PP-OCRv6_small_${part}_onnx_infer.tar"
  curl -fsSL --retry 3 --max-time 900 -o "${tmp}/model.tar" "${mirror_base}/PP-OCRv6_small_${part}_onnx_infer.tar"
  tar -xf "${tmp}/model.tar" -C "${tmp}"
  mkdir -p "${models_dir}/${part}"
  cp "${tmp}/PP-OCRv6_small_${part}_onnx_infer/inference.onnx" "${tmp}/PP-OCRv6_small_${part}_onnx_infer/inference.yml" "${models_dir}/${part}/"
  rm -rf "${tmp}"
}

fetch_part() {
  local part="$1" repo="$2" revision="$3" file
  if is_valid "${part}/inference.onnx" && is_valid "${part}/inference.yml"; then
    echo "${part}：已有，校验通过"
    return
  fi
  echo "${part}：下载中"
  mkdir -p "${models_dir}/${part}"
  local ok=1
  for file in inference.onnx inference.yml; do
    if ! curl -fsSL --retry 3 --max-time 900 -o "${models_dir}/${part}/${file}.part" \
      "https://huggingface.co/${repo}/resolve/${revision}/${file}"; then
      ok=0
      break
    fi
    mv "${models_dir}/${part}/${file}.part" "${models_dir}/${part}/${file}"
  done
  rm -f "${models_dir}/${part}"/*.part
  if [ "${ok}" = 0 ] || ! is_valid "${part}/inference.onnx" || ! is_valid "${part}/inference.yml"; then
    echo "  Hugging Face 下载失败或校验不对，换镜像"
    fetch_from_mirror "${part}"
  fi
  for file in inference.onnx inference.yml; do
    if ! is_valid "${part}/${file}"; then
      echo "错误：${models_dir}/${part}/${file} 的 sha256 不对（应为 $(expected_sha256 "${part}/${file}")）" >&2
      exit 1
    fi
  done
  echo "  校验通过"
}

fetch_part det "${det_repo}" "${det_revision}"
fetch_part rec "${rec_repo}" "${rec_revision}"
echo "模型在 ${models_dir}"
