import { requireOptionalNativeModule } from 'expo';

import type { OcrResult, RecognizeOptions } from './src/LabelOcr.types';

export type { OcrBox, OcrCrop, OcrLine, OcrPoint, OcrResult, OcrTiming, RecognizeOptions } from './src/LabelOcr.types';

/**
 * 原生模块 LabelOcr（安卓 Kotlin、iOS Swift）。识别全在手机上做：PaddleOCR 的 PP-OCRv6_small 模型，
 * ONNX Runtime 推理，模型打在安装包里，不联网。
 *
 * 原生侧要实现：
 * - prepareAsync(): Promise<void> —— 预先加载模型（打开相机时调，按快门后就不用再等加载）；重复调用没关系
 * - recognizeAsync(uri, options): Promise<OcrResult> —— uri 是本机图片（file://，安卓也收 content://）；
 *   在后台线程识别，不卡界面；读不了图时 reject，code 是 ERR_LABEL_OCR_IMAGE；模型缺失、加载失败是
 *   ERR_LABEL_OCR_MODEL；推理出错是 ERR_LABEL_OCR_FAILED。一个字也没认出来不算错，lines 为空
 */
type NativeLabelOcr = {
  prepareAsync(): Promise<void>;
  recognizeAsync(uri: string, options: RecognizeOptions): Promise<OcrResult>;
};

const native = requireOptionalNativeModule<NativeLabelOcr>('LabelOcr');

/** 这台手机上能不能用拍照识别（网页版、没带原生模块的包里是 false） */
export function isLabelOcrAvailable(): boolean {
  return native !== null;
}

/** 预先加载模型；不可用时什么也不做 */
export async function prepareLabelOcrAsync(): Promise<void> {
  if (native) await native.prepareAsync();
}

/** 识别一张本机图片里的文字。不可用时抛错，调用前先看 isLabelOcrAvailable() */
export async function recognizeLabelAsync(uri: string, options: RecognizeOptions = {}): Promise<OcrResult> {
  if (!native) throw new Error('这台手机上不能用拍照识别');
  return native.recognizeAsync(uri, { crop: options.crop ?? null });
}
