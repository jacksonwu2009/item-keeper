/**
 * 拍照识别在界面上的几件事（纯函数，有单测）：
 * - 取景框在照片里是哪一块（只认框里的字）；
 * - 照片拍得行不行、认出来的东西够不够，不够时提示什么；
 * - 认出来的日期、保质期怎么填进「过期日期」那几格，哪几格标「识别」「没认出来」。
 */

import { addDays, expiryFromShelfLife, formatDate, formatShelfLife, type ShelfLife } from './dates';
import type { LabelParseResult } from './labelParse';

/** 拍日期的结果：能分清的生产日期 / 到期日（认不出的是 null） */
export type DateScanResult = { production: string | null; expiry: string | null; confirmed: boolean };

/** 拍包装的结果：背面标签认出的字段，加上日期（喷码或标签上的，已经分好或人选好；跳过了喷码就是 null） */
export type LabelScanResult = { label: LabelParseResult; dates: DateScanResult | null };

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
/** 相对整张照片（摆正以后）的一块，0–1 */
export type NormalizedRect = Rect;

/**
 * 取景框在照片里对应哪一块。相机预览是「铺满」显示的（照片等比放大到盖满预览区，多出来的两头裁掉），
 * 所以按同样的比例倒推回去；四周多留 margin（框的宽高的比例），手抖、没对齐也不会切掉字。
 * App 只竖着用：预览是竖的，照片宽高按竖的算（有的手机返回的宽高没按方向转）。
 */
export function frameToCrop(view: Size, frame: Rect, photo: Size, margin = 0.08): NormalizedRect {
  const portrait = view.height >= view.width;
  const photoWidth = portrait ? Math.min(photo.width, photo.height) : Math.max(photo.width, photo.height);
  const photoHeight = portrait ? Math.max(photo.width, photo.height) : Math.min(photo.width, photo.height);
  const scale = Math.max(view.width / photoWidth, view.height / photoHeight);
  const shownWidth = photoWidth * scale;
  const shownHeight = photoHeight * scale;
  const offsetX = (view.width - shownWidth) / 2;
  const offsetY = (view.height - shownHeight) / 2;
  const left = (frame.x - frame.width * margin - offsetX) / shownWidth;
  const top = (frame.y - frame.height * margin - offsetY) / shownHeight;
  const right = (frame.x + frame.width * (1 + margin) - offsetX) / shownWidth;
  const bottom = (frame.y + frame.height * (1 + margin) - offsetY) / shownHeight;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x = clamp(left);
  const y = clamp(top);
  return { x, y, width: Math.max(0.01, clamp(right) - x), height: Math.max(0.01, clamp(bottom) - y) };
}

export type ScanProblem = {
  title: string;
  /** 给人看的几条建议 */
  tips: string[];
};

const RETAKE_TIPS = ['靠近一点，让字占满框，对好焦再拍', '避开灯光、窗户的反光，暗的地方打开补光', '拍的时候手别动'];

/** 拍背面标签：照片糊，或者名称、规格、保质期、日期一项都没认出来时提示重拍 */
export function labelScanProblem(result: LabelParseResult): ScanProblem | null {
  if (result.quality.poor) return { title: '照片有点糊，请重拍', tips: RETAKE_TIPS };
  const found = result.name || result.spec || result.shelfLife || result.dateElsewhere || result.dates.length;
  if (!found) return { title: '没认出名称、规格、保质期', tips: ['对准包装背面印着「产品名称」「净含量」「保质期」的那块标签', ...RETAKE_TIPS] };
  return null;
}

/** 拍日期：照片糊，或者一个日期都没认出来时提示重拍 */
export function dateScanProblem(result: LabelParseResult): ScanProblem | null {
  if (result.quality.poor) return { title: '照片有点糊，请重拍', tips: RETAKE_TIPS };
  if (!result.dates.length) return { title: '没认出日期', tips: ['只框住印着日期的那一小块（瓶盖、封口、袋边上的喷码）', ...RETAKE_TIPS] };
  return null;
}

/** 拍照识别填的格子：recognized = 照片里认出来的（蓝底、标「识别」），missing = 没认出来，要人填 */
export type ScanTag = 'recognized' | 'missing';

export type ExpiryFill = {
  /** 过期日期的填法：直接填到期日，还是生产日期 + 保质期 */
  mode: 'date' | 'shelf';
  expiry: string | null;
  productionDate: string | null;
  /** 保质期；mode 是 shelf 又不知道时是 null，要人填 */
  shelfLife: ShelfLife | null;
  tags: { expiry?: ScanTag; productionDate?: ScanTag; shelfLife?: ScanTag };
  /** 日期下面的一句提示，例如「✓ 和喷码上的到期日一致」 */
  note: string | null;
};

/**
 * 认出来的日期、保质期怎么填进过期日期那几格：
 * - 生产日期 + 保质期正好等于印着的到期日：按「生产日期+保质期」填，提示对上了；
 * - 有到期日（生产日期对不上或没有）：直接填到期日；
 * - 只有生产日期：按「生产日期+保质期」填，保质期不知道时空着让人填；
 * - 日期都没认出来、但认出了保质期或标签写了「见瓶盖」：按「生产日期+保质期」，生产日期标「没认出来」，提示单独拍喷码；
 * - 和日期有关的什么都没认出来：返回 null，过期日期那几格不动。
 * shelfLifeRecognized：保质期是不是这次从照片里认出来的（是就标「识别」，商品资料里本来就有的不标）。
 */
export function planExpiryFill({
  dates,
  shelfLife,
  shelfLifeRecognized,
  dateElsewhere,
}: {
  dates: DateScanResult;
  shelfLife: ShelfLife | null;
  shelfLifeRecognized: boolean;
  dateElsewhere: string | null;
}): ExpiryFill | null {
  if (!dates.production && !dates.expiry && !shelfLife && !dateElsewhere) return null;
  const shelfTag = shelfLifeRecognized && shelfLife ? ('recognized' as const) : shelfLife ? undefined : ('missing' as const);
  if (dates.production && dates.expiry && dates.confirmed && shelfLife) {
    return {
      mode: 'shelf',
      expiry: dates.expiry,
      productionDate: dates.production,
      shelfLife,
      tags: { productionDate: 'recognized', ...(shelfTag ? { shelfLife: shelfTag } : {}) },
      note: '✓ 按保质期算出的到期日和印着的到期日一致',
    };
  }
  if (dates.expiry) {
    return { mode: 'date', expiry: dates.expiry, productionDate: null, shelfLife, tags: { expiry: 'recognized' }, note: null };
  }
  if (dates.production) {
    return {
      mode: 'shelf',
      expiry: null,
      productionDate: dates.production,
      shelfLife,
      tags: { productionDate: 'recognized', ...(shelfTag ? { shelfLife: shelfTag } : {}) },
      note: shelfLife ? null : '没认出保质期，请照包装上写的填',
    };
  }
  return {
    mode: 'shelf',
    expiry: null,
    productionDate: null,
    shelfLife,
    tags: { productionDate: 'missing', ...(shelfTag ? { shelfLife: shelfTag } : {}) },
    note: dateElsewhere
      ? `标签上写「${dateElsewhere}」——点「拍日期」单独拍喷码，或者手动选`
      : '没认出生产日期——点「拍日期」拍喷码，或者手动选',
  };
}

/** 选日期时的提示：按保质期算出的到期日，和认出的另一个日期对不对得上 */
export function describeShelfCheck(production: string, shelfLife: ShelfLife | null, others: string[]): string | null {
  if (!shelfLife) return null;
  const expiry = expiryFromShelfLife(production, shelfLife.amount, shelfLife.unit);
  const matched = others.some((other) => other === expiry || other === addDays(expiry, 1));
  return `按保质期 ${formatShelfLife(shelfLife)}算：${formatDate(expiry)} 到期${matched ? '，✓ 和喷码上的另一个日期一致' : ''}`;
}
