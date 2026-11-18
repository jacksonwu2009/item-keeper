/** 设备保修与配件的纯函数（有单测）。 */

import { diffDays, expiryFromShelfLife, formatDate } from './dates';

export type WarrantyLevel = 'ok' | 'soon' | 'expired';
export type WarrantyStatus = { level: WarrantyLevel; text: string; daysLeft: number };

/** 剩这么多天以内算「快过保」 */
export const WARRANTY_SOON_DAYS = 30;

export function warrantyStatus(warrantyUntil: string | null, today: string): WarrantyStatus | null {
  if (!warrantyUntil) return null;
  const daysLeft = diffDays(warrantyUntil, today);
  if (daysLeft < 0) return { level: 'expired', text: `已过保 ${-daysLeft} 天`, daysLeft };
  if (daysLeft === 0) return { level: 'soon', text: '保修今天到期', daysLeft };
  if (daysLeft <= WARRANTY_SOON_DAYS) return { level: 'soon', text: `保修还剩 ${daysLeft} 天`, daysLeft };
  return { level: 'ok', text: `保修到 ${formatDate(warrantyUntil)}`, daysLeft };
}

export type WarrantyUnit = 'month' | 'year';

/** 按购买日期和保修年限算保修到期日：购买 2026-11-18、保修 1 年 → 2027-11-17。 */
export function warrantyEnd(purchaseDate: string, amount: number, unit: WarrantyUnit): string {
  return expiryFromShelfLife(purchaseDate, amount, unit);
}

export type Accessory = { name: string; quantity: number };

/** 「充电器 ×1、扩展坞 ×2」 */
export function describeAccessories(accessories: Accessory[]): string {
  return accessories.map((item) => `${item.name} ×${item.quantity}`).join('、');
}

/** 配件清单校验：名称不能空、不能重复，数量 1–9999 的整数。 */
export function validateAccessories(accessories: Accessory[]): string | null {
  const seen = new Set<string>();
  for (const item of accessories) {
    const name = item.name.trim();
    if (!name) return '配件名称不能为空';
    if (seen.has(name)) return `配件「${name}」重复了`;
    seen.add(name);
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 9999) {
      return `配件「${name}」的数量要是 1 到 9999 的整数`;
    }
  }
  return null;
}
