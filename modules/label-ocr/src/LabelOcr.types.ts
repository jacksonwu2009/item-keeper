/**
 * 拍照识别（OCR）原生模块对 JS 的接口。安卓（Kotlin）和 iOS（Swift）都按这里的结构返回。
 *
 * 只做「图片 → 一行行文字」：每行的文字、四个角的位置、置信度，加上图片宽高。
 * 从文字里找名称、规格、保质期、日期是 src/lib/labelParse.ts 的事，和引擎无关。
 */

/** 一个点：[x, y]，单位是像素，坐标系见 OcrResult.width / height */
export type OcrPoint = [number, number];

/** 一行字的四个角，顺序是左上、右上、右下、左下（按字的阅读方向） */
export type OcrBox = [OcrPoint, OcrPoint, OcrPoint, OcrPoint];

export type OcrLine = {
  /** 认出的文字 */
  text: string;
  /** 置信度 0–1（各字符概率的平均） */
  score: number;
  /** 这一行在图里的位置 */
  box: OcrBox;
};

/** 只认图里的一块：相对整张图（按 EXIF 摆正以后）的比例，都在 0–1 之间 */
export type OcrCrop = { x: number; y: number; width: number; height: number };

export type RecognizeOptions = {
  /** 拍日期用的小取景框：只认这一块，字在小图里更大、更快 */
  crop?: OcrCrop | null;
};

export type OcrTiming = {
  /** 第一次识别时加载模型的时间；已经加载过是 0 */
  loadMs: number;
  /** 读图、摆正、裁剪 */
  decodeMs: number;
  /** 文字检测（找出每一行在哪） */
  detMs: number;
  /** 文字识别（每一行是什么字），含判断方向 */
  recMs: number;
  /** 从收到调用到返回的总时间 */
  totalMs: number;
};

export type OcrResult = {
  lines: OcrLine[];
  /**
   * 坐标系的宽高：图片按 EXIF 摆正、按 crop 裁过、再按 rotation 转正以后的大小。
   * lines 里的坐标都在这个坐标系里，字是正着的（从左往右读）。
   */
  width: number;
  height: number;
  /** 为了让字正过来，图顺时针转了多少度。手机竖着拍横排的字是 0；包装侧着拍是 90 或 270 */
  rotation: 0 | 90 | 180 | 270;
  /** 用的模型，例如 PP-OCRv6_small */
  model: string;
  timing: OcrTiming;
};
