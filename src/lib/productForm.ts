/**
 * 新增 / 改资料表单（components/StockProductForm.tsx）里不画界面的部分（同 RN 联网版 lib/productDraft.ts 的做法）：
 * - 改资料页「保质期」那一格：怎么校验、打开时怎么带出（新建页没有这一格，保质期在「这次入库」里填）；
 * - 改资料页「改过没有」：和打开时的值比，改回原样不算（返回前要不要问「放弃修改？」）。
 * 纯函数，有单测。
 */
import { validShelfLife } from '../db/stock';
import type { ShelfLife, ShelfLifeUnit } from './dates';
import type { PriceDraft } from './price';
import type { StockKind } from './stock';

/** 「保质期」那一格：数量的文字（空着 = 没填）和单位 */
export type ShelfDraft = { shelfText: string; shelfUnit: ShelfLifeUnit };

export const SHELF_LIFE_ERROR = '请填 1–9999 的整数，留空表示不记';

/** 填的保质期：空着、不是 1–9999 的整数都是 null（填了但不对的由 shelfLifeError 报错） */
export function draftShelfLife(draft: ShelfDraft): ShelfLife | null {
  if (draft.shelfText.trim() === '') return null;
  return validShelfLife({ amount: Number(draft.shelfText), unit: draft.shelfUnit });
}

/** 保质期那一格的错误：空着不算错，填了但不是 1–9999 的整数才报 */
export function shelfLifeError(draft: ShelfDraft): string | null {
  return draft.shelfText.trim() !== '' && !draftShelfLife(draft) ? SHELF_LIFE_ERROR : null;
}

/** 保质期格子的初始文字、单位：没填时空着、单位默认「个月」 */
export function shelfDraftOf(shelfLife: ShelfLife | null | undefined): ShelfDraft {
  return { shelfText: shelfLife ? String(shelfLife.amount) : '', shelfUnit: shelfLife?.unit ?? 'month' };
}

/** 改资料页上能改的每一格（都是表单里的原样文字、选项）：打开时记一份，返回前和现在的比 */
export type ProductFormValues = ShelfDraft & {
  officeId: number;
  kind: StockKind;
  barcode: string;
  name: string;
  category: string | null;
  spec: string;
  unit: string;
  location: string;
  lowStockText: string;
  leadText: string;
  note: string;
  /** 包装规格：每行的单位、数量、条码（行的编号、离开过条码框这些不算） */
  packs: { unit: string; sizeText: string; barcode: string }[];
  /** 「最近一次入库的价格」（没有这条入库记录时是空的） */
  lastInPrice: PriceDraft;
};

/** 改资料页改过没有：任何一格和打开时不一样就算改过；改了又改回原样不算 */
export function productFormChanged(opened: ProductFormValues, current: ProductFormValues): boolean {
  const plainKeys = [
    'officeId',
    'kind',
    'barcode',
    'name',
    'category',
    'spec',
    'unit',
    'location',
    'lowStockText',
    'leadText',
    'note',
    'shelfText',
    'shelfUnit',
  ] as const;
  if (plainKeys.some((key) => opened[key] !== current[key])) return true;
  if (opened.packs.length !== current.packs.length) return true;
  const packChanged = opened.packs.some((pack, index) => {
    const now = current.packs[index];
    return pack.unit !== now.unit || pack.sizeText !== now.sizeText || pack.barcode !== now.barcode;
  });
  if (packChanged) return true;
  return opened.lastInPrice.source !== current.lastInPrice.source || opened.lastInPrice.text !== current.lastInPrice.text;
}
