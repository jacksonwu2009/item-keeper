/**
 * 入库价格：单价和总价都可以不填；填了其中一个，另一个按数量自动算。
 * 记住的是「最后改的是哪一个」和它的文字，另一个每次按当前数量现算，所以改数量时自动跟着变。
 * 单价指按入库时选的单位（按箱入库就是每箱的价）。有单测。
 */

export type PriceSource = 'unit' | 'total';

export type PriceDraft = {
  /** 用户最后填的是单价还是总价 */
  source: PriceSource;
  /** 用户填的文字；空串表示没填价格 */
  text: string;
};

export type EntryPrice = { unitPrice: number; totalPrice: number };

/** 单价最多 4 位小数（便宜的东西按个算会很小），总价 2 位 */
export const UNIT_PRICE_DECIMALS = 4;
export const TOTAL_PRICE_DECIMALS = 2;
export const PRICE_MAX = 99999999;

export const EMPTY_PRICE: PriceDraft = { source: 'unit', text: '' };

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function roundTotalPrice(value: number): number {
  return roundTo(value, TOTAL_PRICE_DECIMALS);
}

/** 1 以上的单价留 2 位小数；不到 1 的留 4 位，免得 0.0833 变成 0.08 */
export function roundUnitPrice(value: number): number {
  return Math.abs(value) >= 1 ? roundTo(value, 2) : roundTo(value, UNIT_PRICE_DECIMALS);
}

/** 显示价格：至少 2 位小数，多出来的有效小数（最多 4 位）照样显示，如 2.50、0.0833 */
export function formatPrice(value: number): string {
  const fixed = value.toFixed(UNIT_PRICE_DECIMALS).replace(/0+$/, '');
  const [whole, fraction = ''] = fixed.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** 放进输入框的文字：去掉多余的 0（2.50 → 2.5），和用户自己输的样子一致 */
function toInputText(value: number): string {
  return String(value);
}

function parsePrice(text: string): number | null {
  if (!text || text === '.') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 按当前数量算出两个输入框该显示的文字，以及能保存的价格。
 * qty 是按入库单位的数量（2 箱就是 2）；数量还没填好时，另一个框先空着。
 */
export function derivePrice(
  draft: PriceDraft,
  qty: number | null,
): { unitText: string; totalText: string; price: EntryPrice | null } {
  const value = parsePrice(draft.text);
  const validQty = qty !== null && qty > 0 ? qty : null;
  if (value === null) {
    return draft.source === 'unit'
      ? { unitText: draft.text, totalText: '', price: null }
      : { unitText: '', totalText: draft.text, price: null };
  }
  if (draft.source === 'unit') {
    const totalPrice = validQty === null ? null : roundTotalPrice(value * validQty);
    return {
      unitText: draft.text,
      totalText: totalPrice === null ? '' : toInputText(totalPrice),
      price: totalPrice === null ? null : { unitPrice: value, totalPrice },
    };
  }
  const unitPrice = validQty === null ? null : roundUnitPrice(value / validQty);
  return {
    unitText: unitPrice === null ? '' : toInputText(unitPrice),
    totalText: draft.text,
    price: unitPrice === null ? null : { unitPrice, totalPrice: value },
  };
}

/**
 * 入库单位从「瓶」换成「箱」时，单价跟着换算（每瓶 2 → 每箱 48），保持同一个进价；
 * 填的是总价时不用动，单价会按新数量重新算。
 */
export function convertPriceUnit(draft: PriceDraft, fromSize: number, toSize: number): PriceDraft {
  const value = parsePrice(draft.text);
  if (draft.source !== 'unit' || value === null || !(fromSize > 0) || !(toSize > 0) || fromSize === toSize) return draft;
  return { source: 'unit', text: toInputText(roundUnitPrice((value / fromSize) * toSize)) };
}

/** 上一次入库的进价折成最小单位（每瓶多少钱）。 */
export function perBaseUnitPrice(entry: {
  delta: number;
  unitPrice: number | null;
  totalPrice: number | null;
  inputQty: number | null;
}): number | null {
  if (!(entry.delta > 0)) return null;
  if (entry.totalPrice !== null) return entry.totalPrice / entry.delta;
  if (entry.unitPrice !== null) {
    // 单价是按入库单位的；没记入库单位时就是最小单位
    const size = entry.inputQty && entry.inputQty > 0 ? entry.delta / entry.inputQty : 1;
    return entry.unitPrice / size;
  }
  return null;
}

/** 用上次的进价预填单价（换算成这次的入库单位）。 */
export function defaultPriceDraft(lastPerBaseUnit: number | null, unitSize: number): PriceDraft {
  if (lastPerBaseUnit === null || !(unitSize > 0)) return EMPTY_PRICE;
  return { source: 'unit', text: toInputText(roundUnitPrice(lastPerBaseUnit * unitSize)) };
}

/**
 * 改一条入库记录的价格时，输入框一开始显示的：有总价就从总价算单价（单价是四舍五入过的，反过来乘会差几分），
 * 只记了单价就从单价算总价，都没记就空着
 */
export function storedPriceDraft(stored: { unitPrice: number | null; totalPrice: number | null }): PriceDraft {
  if (stored.totalPrice !== null) return { source: 'total', text: toInputText(stored.totalPrice) };
  if (stored.unitPrice !== null) return { source: 'unit', text: toInputText(stored.unitPrice) };
  return EMPTY_PRICE;
}
