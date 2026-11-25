/**
 * 过期日期输入框（components/ExpiryInput.tsx）填出来要保存的值：纯函数，有单测。
 * 鸿蒙版在 ui/stock/StockFormRules.ets（expiryValueOf），规则一样。
 */

import { expiryFromShelfLife, formatDate, formatShortDate, type ShelfLife, type ShelfLifeUnit } from './dates';

/** 直接选到期日 / 按包装上的「生产日期 + 保质期」算 / 不记录 */
export type ExpiryMode = 'date' | 'shelf' | 'none';

/**
 * expiry 是到期日；shelfLife 是「生产日期+保质期」填法下填的保质期（别的填法是 null），新建物品时记进商品资料；
 * productionDate 是记在入库记录上的生产日期：「生产日期+保质期」填法下是算到期日用的那天，
 * 「选到期日」填法下是拍照认出、没点「不记」的那天，别的情况是 null
 */
export type ExpiryValue = { expiry: string | null; error: string | null; shelfLife: ShelfLife | null; productionDate: string | null };

/** 过期日期输入框里的全部内容 */
export type ExpiryDraft = {
  mode: ExpiryMode;
  expiry: string | null;
  /** 生产日期那一格；两种填法共用，切换填法时不变 */
  productionDate: string | null;
  /** 「选到期日」填法下也记生产日期：拍日期、拍包装认出了生产日期时是 true，点「不记」变 false，手动选的不算 */
  keepProductionDate: boolean;
  shelfAmountText: string;
  shelfUnit: ShelfLifeUnit;
};

/** 「选到期日」填法下要记的生产日期（到期日下面那一行显示的）；没有这一行时是 null */
export function keptProductionDate(draft: ExpiryDraft): string | null {
  return draft.mode === 'date' && draft.keepProductionDate && draft.productionDate ? draft.productionDate : null;
}

/** 「选到期日」填法下到期日下面那一行的字：「生产日期 9月30日」，不是今年的带上年份 */
export function keptProductionLabel(date: string, thisYear: number = new Date().getFullYear()): string {
  return `生产日期 ${date.slice(0, 4) === String(thisYear) ? formatShortDate(date) : formatDate(date)}`;
}

/** 按填法算出要保存的过期日期、保质期、生产日期，或者为什么还不能保存 */
export function expiryValueOf(draft: ExpiryDraft): ExpiryValue {
  if (draft.mode === 'none') return { expiry: null, error: null, shelfLife: null, productionDate: null };
  if (draft.mode === 'date') {
    return draft.expiry
      ? { expiry: draft.expiry, error: null, shelfLife: null, productionDate: keptProductionDate(draft) }
      : { expiry: null, error: '请选择过期日期', shelfLife: null, productionDate: null };
  }
  const amount = Number(draft.shelfAmountText);
  const shelfLife: ShelfLife | null =
    draft.shelfAmountText.trim() !== '' && Number.isInteger(amount) && amount > 0 ? { amount, unit: draft.shelfUnit } : null;
  if (!draft.productionDate) return { expiry: null, error: '请选择生产日期', shelfLife, productionDate: null };
  if (!shelfLife) return { expiry: null, error: '保质期请填正整数', shelfLife: null, productionDate: null };
  return {
    expiry: expiryFromShelfLife(draft.productionDate, amount, draft.shelfUnit),
    error: null,
    shelfLife,
    productionDate: draft.productionDate,
  };
}
