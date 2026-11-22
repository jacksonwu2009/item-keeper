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

// ---------- 出库时指定从哪一批出 ----------

/** 从某一批出多少（batchId 是本机批次 id） */
export type BatchAllocation = { batchId: number; quantity: number };

/** 批次的入库日期（有的话）：同过期日期时先入库的先出 */
function addedOnOf(batch: BatchForConsume): string {
  const addedOn = (batch as { addedOn?: unknown }).addedOn;
  return typeof addedOn === 'string' ? addedOn : '';
}

/**
 * 按「先到期先出」排好：过期日期早的在前，没有过期日期的最后；同日期先按入库日期，再按 id
 * （网页版的 id 是服务端编号换成的数，没有先后，不能只靠 id）
 */
export function fifoOrder<T extends BatchForConsume>(batches: readonly T[]): T[] {
  return [...batches]
    .filter((batch) => batch.quantity > 0)
    .sort((a, b) => {
      if (a.expiryDate && b.expiryDate && a.expiryDate !== b.expiryDate) return a.expiryDate < b.expiryDate ? -1 : 1;
      if (a.expiryDate && !b.expiryDate) return -1;
      if (!a.expiryDate && b.expiryDate) return 1;
      return addedOnOf(a).localeCompare(addedOnOf(b)) || a.id - b.id;
    });
}

/** 默认分配（界面预填）：先到期的先出，只列出要出的批次 */
export function defaultAllocation(batches: readonly BatchForConsume[], amount: number): BatchAllocation[] {
  const plan = planConsumption([...batches], amount);
  const byId = new Map(batches.map((batch) => [batch.id, batch]));
  return plan.updates
    .map((update) => ({ batchId: update.id, quantity: roundQty((byId.get(update.id)?.quantity ?? 0) - update.quantity) }))
    .filter((allocation) => allocation.quantity > 0);
}

/** 只留数量大于 0 的、同一批合并，按批次 id 排好（比较、发给服务端用） */
export function normalizeAllocation(allocations: readonly BatchAllocation[]): BatchAllocation[] {
  const byId = new Map<number, number>();
  for (const allocation of allocations) {
    byId.set(allocation.batchId, roundQty((byId.get(allocation.batchId) ?? 0) + allocation.quantity));
  }
  return [...byId]
    .filter(([, quantity]) => quantity > 0)
    .map(([batchId, quantity]) => ({ batchId, quantity }))
    .sort((left, right) => left.batchId - right.batchId);
}

/** 和「先到期先出」的默认分配一样（一样就不用发给服务端） */
export function isDefaultAllocation(
  batches: readonly BatchForConsume[],
  amount: number,
  allocations: readonly BatchAllocation[],
): boolean {
  const mine = normalizeAllocation(allocations);
  const fallback = normalizeAllocation(defaultAllocation(batches, amount));
  return mine.length === fallback.length && mine.every((item, index) => item.batchId === fallback[index].batchId && item.quantity === fallback[index].quantity);
}

/**
 * 指定批次有没有问题：每批不能超过它现有的，合计要等于要出的数量；
 * 要出的比全部库存还多时不能指定（按现有的全部出）。没问题返回 null。
 */
export function allocationError(
  batches: readonly BatchForConsume[],
  amount: number,
  allocations: readonly BatchAllocation[],
): string | null {
  const byId = new Map(batches.map((batch) => [batch.id, batch]));
  const total = roundQty(batches.reduce((sum, batch) => sum + Math.max(batch.quantity, 0), 0));
  if (amount > total) return `现有只有 ${total}，不能指定批次`;
  let sum = 0;
  for (const allocation of allocations) {
    if (!(allocation.quantity >= 0)) return '每一批出的数量不能小于 0';
    const batch = byId.get(allocation.batchId);
    if (!batch) return '指定的批次已经没有了，请重新选';
    if (allocation.quantity > batch.quantity) {
      return `${batch.expiryDate ? `${batch.expiryDate} 到期的` : '不记过期日期的'}那一批只有 ${roundQty(batch.quantity)}`;
    }
    sum = roundQty(sum + allocation.quantity);
  }
  if (sum < roundQty(amount)) return `还差 ${roundQty(amount - sum)} 没分到批次`;
  if (sum > roundQty(amount)) return `多分了 ${roundQty(sum - amount)}`;
  return null;
}

/**
 * 按指定的批次出库（和服务端一样）：先从指定的批次扣（每批最多扣到 0），
 * 指定的不够或者那批没了，差的部分先从没指定的批次按先到期先出补，还不够再从指定批次剩下的补。
 * 没指定时就是先到期先出。fallback：补上的数量；allocated：从指定批次扣到的数量。
 */
export function planAllocatedConsumption(
  batches: readonly BatchForConsume[],
  amount: number,
  allocations: readonly BatchAllocation[] | null,
): ConsumptionPlan & { allocated: number; fallback: number } {
  if (!allocations?.length) {
    const plan = planConsumption([...batches], amount);
    return { ...plan, allocated: 0, fallback: plan.consumed };
  }
  const left = new Map(batches.map((batch) => [batch.id, Math.max(batch.quantity, 0)]));
  let remaining = roundQty(amount);
  let allocated = 0;
  for (const allocation of normalizeAllocation(allocations)) {
    if (remaining <= 0) break;
    const available = left.get(allocation.batchId) ?? 0;
    const take = roundQty(Math.min(available, allocation.quantity, remaining));
    if (take <= 0) continue;
    left.set(allocation.batchId, roundQty(available - take));
    remaining = roundQty(remaining - take);
    allocated = roundQty(allocated + take);
  }
  const chosen = new Set(allocations.map((allocation) => allocation.batchId));
  const others = planConsumption(
    batches.filter((batch) => !chosen.has(batch.id)).map((batch) => ({ ...batch, quantity: left.get(batch.id) ?? 0 })),
    remaining,
  );
  for (const update of others.updates) left.set(update.id, update.quantity);
  const leftovers = planConsumption(
    batches.filter((batch) => chosen.has(batch.id)).map((batch) => ({ ...batch, quantity: left.get(batch.id) ?? 0 })),
    others.shortfall,
  );
  for (const update of leftovers.updates) left.set(update.id, update.quantity);
  const rest = { consumed: roundQty(others.consumed + leftovers.consumed), shortfall: leftovers.shortfall };
  const updates = batches
    .filter((batch) => roundQty(left.get(batch.id) ?? 0) !== roundQty(Math.max(batch.quantity, 0)))
    .map((batch) => ({ id: batch.id, quantity: roundQty(left.get(batch.id) ?? 0) }));
  return {
    updates,
    consumed: roundQty(allocated + rest.consumed),
    shortfall: rest.shortfall,
    allocated,
    fallback: rest.consumed,
  };
}

/** 「最早一批 <日期> 到期，建议先用这批」：最早到期且有过期日期的那一批；没有就 null */
export function earliestBatch<T extends BatchForConsume>(batches: readonly T[]): T | null {
  const first = fifoOrder(batches)[0];
  return first?.expiryDate ? first : null;
}

/** 最早到期的那批还有剩，却从更晚的批次出了：提醒（不拦） */
export function skipsEarliestBatch(batches: readonly BatchForConsume[], allocations: readonly BatchAllocation[]): boolean {
  const earliest = earliestBatch(batches);
  if (!earliest) return false;
  const normalized = normalizeAllocation(allocations);
  const fromEarliest = normalized.find((item) => item.batchId === earliest.id)?.quantity ?? 0;
  const usesOthers = normalized.some((item) => item.batchId !== earliest.id && item.quantity > 0);
  return usesOthers && fromEarliest < earliest.quantity;
}

/** 出库时备注最多几个字（和出库单的备注一样） */
export const NOTE_INPUT_MAX = 200;

/** 出库记录的说明：原因，再跟上备注（「用掉，年会用」）；没填备注就只有原因。和出库单的记录一个写法 */
export function outNote(reason: string, note: string): string {
  const extra = note.trim();
  return extra ? `${reason}，${extra}` : reason;
}
