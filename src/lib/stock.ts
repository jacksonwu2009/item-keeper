/** 库存相关的纯函数。 */

export type StockKind = 'food' | 'daily';

export const KIND_LABEL: Record<StockKind, string> = {
  food: '食品',
  daily: '日用品',
};

export const DEFAULT_UNITS: Record<StockKind, string[]> = {
  food: ['件', '个', '袋', '盒', '瓶', '罐', '箱', '包', 'kg', '斤'],
  daily: ['件', '个', '包', '卷', '瓶', '盒', '支', '块', '箱', '提'],
};

export function isStockKind(value: unknown): value is StockKind {
  return value === 'food' || value === 'daily';
}

/** 数量保留两位小数，避免 0.1 + 0.2 这类浮点误差显示出来。 */
export function roundQty(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatQty(value: number): string {
  return String(roundQty(value));
}

export function parseQty(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return roundQty(value);
}

export type BatchForConsume = { id: number; quantity: number; expiryDate: string | null };

export type ConsumptionPlan = {
  /** 每个受影响批次的新数量；为 0 的批次由调用方删除。 */
  updates: { id: number; quantity: number }[];
  consumed: number;
  /** 想出库的比现有库存多出来的部分。 */
  shortfall: number;
};

/** 出库按「先到期先出」：过期日期早的批次先扣，没有过期日期的最后扣。 */
export function planConsumption(batches: BatchForConsume[], amount: number): ConsumptionPlan {
  const ordered = [...batches]
    .filter((batch) => batch.quantity > 0)
    .sort((a, b) => {
      if (a.expiryDate && b.expiryDate && a.expiryDate !== b.expiryDate) {
        return a.expiryDate < b.expiryDate ? -1 : 1;
      }
      if (a.expiryDate && !b.expiryDate) return -1;
      if (!a.expiryDate && b.expiryDate) return 1;
      return a.id - b.id;
    });

  let remaining = roundQty(amount);
  const updates: { id: number; quantity: number }[] = [];
  for (const batch of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    updates.push({ id: batch.id, quantity: roundQty(batch.quantity - take) });
    remaining = roundQty(remaining - take);
  }
  return { updates, consumed: roundQty(amount - remaining), shortfall: remaining };
}
