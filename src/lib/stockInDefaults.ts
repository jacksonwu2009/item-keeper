/**
 * 入库面板的默认值：按这个物品以前的记录带出过期日期的填法，带出的格子标「按上次」「按资料」，人能改。
 * 改入库价格时的说明文字。都是纯函数，有单测。
 */
import { formatDate, formatShortDate, parseDateStr, toDateStr, type ShelfLife } from './dates';
import type { ExpiryFill } from './labelScan';
import { formatQty } from './stock';

export type ExpiryFillMode = 'date' | 'shelf' | 'none';

/** 上一次入库：用到过期日期，和当时填的生产日期（按「生产日期+保质期」填才有；老记录、别的填法是 null） */
export type LastStockIn = { expiryDate: string | null; productionDate?: string | null };

/** 带出的到期日下面那句提示：上次那批的到期日只能当参考，新买的一般更晚，所以宁可偏早 */
export const LAST_EXPIRY_NOTE = '按上次那批的到期日填的，请照包装上的改';

/**
 * 过期日期怎么默认填：
 * - 没入过库：商品资料里有保质期就按「生产日期+保质期」（保质期标「按资料」），否则食品选到期日、日用品不记录；
 * - 上次没记过期日期：这次也默认不记录；
 * - 上次记了、商品资料里有保质期：按「生产日期+保质期」，保质期带出来，生产日期空着让人选或拍
 *   （不默认今天：东西多半不是今天生产的，按今天算到期日会算晚）；
 * - 上次记了、没有保质期：选到期日，默认填上次那批的到期日，标「按上次」，提示请照包装改。
 * 商品资料里的保质期就是「按生产日期算」那种填法记下的（入库时用这种填法会记进去），所以有保质期就当上次是这种填法。
 */
export function stockInExpiryDefaults({
  last,
  shelfLife,
  isFood,
  canScan,
}: {
  last: LastStockIn | null;
  shelfLife: ShelfLife | null;
  isFood: boolean;
  /** 能不能拍日期（手机上有识别模块） */
  canScan: boolean;
}): { mode: ExpiryFillMode; fill: ExpiryFill | null } {
  const byShelfLife = (life: ShelfLife): { mode: ExpiryFillMode; fill: ExpiryFill } => ({
    mode: 'shelf',
    fill: {
      mode: 'shelf',
      expiry: null,
      productionDate: null,
      shelfLife: life,
      tags: { shelfLife: 'saved' },
      note: canScan ? '生产日期请照包装选，或点「拍日期」拍喷码' : '生产日期请照包装选',
    },
  });
  if (!last) {
    if (shelfLife) return byShelfLife(shelfLife);
    return { mode: isFood ? 'date' : 'none', fill: null };
  }
  if (!last.expiryDate) return { mode: 'none', fill: null };
  if (shelfLife) return byShelfLife(shelfLife);
  return {
    mode: 'date',
    fill: {
      mode: 'date',
      expiry: last.expiryDate,
      productionDate: null,
      shelfLife: null,
      tags: { expiry: 'last' },
      note: LAST_EXPIRY_NOTE,
    },
  };
}

/**
 * 上次入库填的生产日期：生产日期格子下面「同上次」按钮用的那一天；上次没记生产日期（或者没入过库）是 null，不出按钮。
 * 只认入库时真填过、存下来的，不拿「到期日 − 保质期」倒推：上次可能是直接选的到期日，保质期也可能改过，倒推出来的不准。
 */
export function lastProductionDate(last: LastStockIn | null): string | null {
  const date = last?.productionDate;
  if (!date || !parseDateStr(date)) return null;
  return date;
}

/**
 * 「同上次：2026年10月12日」按钮上的字；不该出按钮时是 null：
 * 上次没记生产日期，或者生产日期那一格已经是这一天（点过了，或者人自己选了同一天）。
 */
export function sameAsLastLabel(lastDate: string | null, current: string | null): string | null {
  if (!lastDate || lastDate === current) return null;
  return `同上次：${formatDate(lastDate)}`;
}

/** 一条入库记录：哪天、几件（当时按什么单位填的），改价格时写在上面 */
export type StockInRecord = {
  happenedAt: string;
  delta: number;
  inputQty: number | null;
  inputUnit: string | null;
  expiryDate: string | null;
};

/** 入库时按什么单位、多少件填的（单价按这个单位算）；没记单位就是最小单位 */
export function enteredQtyOf(record: StockInRecord, baseUnit: string): { qty: number; unit: string } {
  if (record.inputUnit && record.inputQty !== null && record.inputQty > 0) return { qty: record.inputQty, unit: record.inputUnit };
  return { qty: record.delta, unit: baseUnit };
}

/** 「11月20日入库 2 箱（48 瓶），2027年1月31日到期」：时间是 ISO（UTC），按手机本地日期显示 */
export function describeStockIn(record: StockInRecord, baseUnit: string): string {
  const entered = enteredQtyOf(record, baseUnit);
  const qty =
    entered.unit === baseUnit
      ? `${formatQty(entered.qty)} ${baseUnit}`
      : `${formatQty(entered.qty)} ${entered.unit}（${formatQty(record.delta)} ${baseUnit}）`;
  const day = formatShortDate(toDateStr(new Date(record.happenedAt)));
  return `${day}入库 ${qty}${record.expiryDate ? `，${formatDate(record.expiryDate)}到期` : ''}`;
}
