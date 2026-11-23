/**
 * 包装单位换算（纯函数，有单测）。
 *
 * 库存一律按物品的「最小单位」记（如 瓶）。包装规格描述「1 箱 = 24 瓶」「1 提 = 6 瓶」，
 * 入库出库时可以按任一单位填，换算成最小单位入账；显示时再拆成「2 箱 2 瓶」方便看。
 */

import { formatQty, roundQty } from './stock';

export type PackUnit = {
  /** 包装单位名，如 箱 */
  unit: string;
  /** 1 个包装 = 多少个最小单位 */
  size: number;
  /** 这一层包装自己的条码（整箱外包装上的码），可空 */
  barcode: string | null;
};

export type UnitOption = { value: string; label: string; size: number };

/** 单位选项：最小单位排第一，包装按从大到小。 */
export function unitOptions(baseUnit: string, packs: PackUnit[]): UnitOption[] {
  const sorted = [...packs].sort((a, b) => b.size - a.size);
  return [
    { value: baseUnit, label: baseUnit, size: 1 },
    ...sorted.map((pack) => ({
      value: pack.unit,
      label: `${pack.unit}（${formatQty(pack.size)} ${baseUnit}）`,
      size: pack.size,
    })),
  ];
}

/** 某单位的数量换算成最小单位；单位不认识时返回 null。 */
export function toBaseQty(qty: number, unit: string, baseUnit: string, packs: PackUnit[]): number | null {
  if (unit === baseUnit) return roundQty(qty);
  const pack = packs.find((candidate) => candidate.unit === unit);
  return pack ? roundQty(qty * pack.size) : null;
}

/**
 * 把最小单位的数量拆成「2 箱 2 瓶」。只在包装都是整数倍、数量是整数、
 * 并且至少能凑出一个包装时返回，否则返回 null（直接显示最小单位就够了）。
 */
export function formatBreakdown(qty: number, baseUnit: string, packs: PackUnit[]): string | null {
  const usable = packs.filter((pack) => Number.isInteger(pack.size) && pack.size > 1).sort((a, b) => b.size - a.size);
  if (!usable.length || !Number.isInteger(roundQty(qty)) || qty < usable[usable.length - 1].size) return null;
  let remaining = roundQty(qty);
  const parts: string[] = [];
  for (const pack of usable) {
    const count = Math.floor(remaining / pack.size);
    if (count > 0) {
      parts.push(`${count} ${pack.unit}`);
      remaining -= count * pack.size;
    }
  }
  if (remaining > 0) parts.push(`${remaining} ${baseUnit}`);
  return parts.join(' ');
}

/** 规格说明，如「1 箱 = 24 瓶，1 提 = 6 瓶」。 */
export function describePacks(baseUnit: string, packs: PackUnit[]): string {
  return [...packs]
    .sort((a, b) => b.size - a.size)
    .map((pack) => `1 ${pack.unit} = ${formatQty(pack.size)} ${baseUnit}`)
    .join('，');
}

/** 校验包装规格，返回给用户看的错误，没问题返回 null。 */
export function validatePacks(baseUnit: string, packs: PackUnit[]): string | null {
  const seen = new Set<string>([baseUnit.trim()]);
  for (const pack of packs) {
    const unit = pack.unit.trim();
    if (!unit) return '包装单位名称不能为空';
    if (seen.has(unit)) {
      return unit === baseUnit.trim() ? `包装单位不能和最小单位「${unit}」同名` : `包装单位「${unit}」重复了`;
    }
    seen.add(unit);
    if (!Number.isFinite(pack.size) || pack.size <= 0) return `「1 ${unit}」等于多少${baseUnit}要填大于 0 的数`;
    if (pack.size === 1) return `「1 ${unit} = 1 ${baseUnit}」没有意义，不用设这个包装`;
  }
  const barcodes = packs.map((pack) => pack.barcode?.trim()).filter((code): code is string => !!code);
  if (new Set(barcodes).size !== barcodes.length) return '两个包装用了同一个条码';
  return null;
}

/** 没设包装规格时举的例子：「1 箱 = 12 瓶」；最小单位就是箱时换成提 */
export function packExample(baseUnit: string): string {
  const pack = ['箱', '提', '包'].find((unit) => unit !== baseUnit) ?? '箱';
  return `1 ${pack} = 12 ${baseUnit}`;
}
