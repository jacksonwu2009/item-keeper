/**
 * 提醒页的列表：每组只显示前几样，其余点「查看全部」；每行的文字尽量短，手机上一行放得下。纯函数，有单测。
 * 鸿蒙版提醒页用同一套规则。
 */
import { describeDaysLeft } from './dates';
import type { ExpiryEntry, LowStockEntry } from './reminderPlan';
import { formatQty, isStockKind, KIND_LABEL } from './stock';
import { warrantyStatus } from './warranty';

/** 提醒页每组最多显示几样 */
export const REMINDER_PREVIEW_LIMIT = 5;

/** 「查看全部」能打开的几组 */
export type ReminderGroup = 'expired' | 'expiring' | 'lowStock' | 'warranty';

export const REMINDER_GROUPS: readonly ReminderGroup[] = ['expired', 'expiring', 'lowStock', 'warranty'];

export const REMINDER_GROUP_TITLES: Record<ReminderGroup, string> = {
  expired: '已过期',
  expiring: '快到期',
  lowStock: '库存不足',
  warranty: '保修快到期的设备',
};

export function isReminderGroup(value: unknown): value is ReminderGroup {
  return typeof value === 'string' && (REMINDER_GROUPS as readonly string[]).includes(value);
}

/** 前几样和还剩几样没显示 */
export function previewOf<T>(items: readonly T[], limit: number = REMINDER_PREVIEW_LIMIT): { shown: T[]; hidden: number } {
  return { shown: items.slice(0, limit), hidden: Math.max(0, items.length - limit) };
}

/** 「查看全部 12 样」 */
export function moreText(total: number): string {
  return `查看全部 ${total} 样`;
}

/** 日期：和今天同一年只写月日（11月18日），不同年写全（2027年1月3日） */
export function shortDateIn(date: string, today: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return date.slice(0, 4) === today.slice(0, 4) ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

/** 这一组里食品、日用品都有时才在每行写分类；只有一种就不写 */
export function showKindFor(entries: readonly { product: { kind?: string } }[]): boolean {
  return new Set(entries.map((entry) => entry.product.kind)).size > 1;
}

function kindOf(product: { kind?: string }): string | null {
  return isStockKind(product.kind) ? KIND_LABEL[product.kind] : null;
}

export type RowText = { subtitle: string; chip: string };

/** 已过期、快到期的一行：下面一行写哪天到期，右边标签写还有几天和这批剩多少 */
export function expiryRowText(entry: ExpiryEntry, today: string, showKind: boolean): RowText {
  const subtitle = [showKind ? kindOf(entry.product) : null, `${shortDateIn(entry.expiryDate, today)}到期`]
    .filter(Boolean)
    .join(' · ');
  return { subtitle, chip: `${describeDaysLeft(entry.daysLeft)} · ${formatQty(entry.quantity)} ${entry.product.unit}` };
}

/** 库存不足的一行：下面一行写下限，右边标签写剩多少 */
export function lowStockRowText(entry: LowStockEntry, showKind: boolean): RowText {
  const subtitle = [showKind ? kindOf(entry.product) : null, `下限 ${formatQty(entry.product.lowStockThreshold ?? 0)} ${entry.unit}`]
    .filter(Boolean)
    .join(' · ');
  return { subtitle, chip: `剩 ${formatQty(entry.qty)} ${entry.unit}` };
}

/** 库存不足按缺得多少排：一点没有的在前，再按剩下的占下限的比例从小到大 */
export function sortLowStock(entries: readonly LowStockEntry[]): LowStockEntry[] {
  const ratio = (entry: LowStockEntry) => {
    const threshold = entry.product.lowStockThreshold ?? 0;
    return threshold > 0 ? entry.qty / threshold : entry.qty;
  };
  return [...entries].sort((left, right) => ratio(left) - ratio(right) || left.qty - right.qty || left.name.localeCompare(right.name));
}

/** 保修 30 天内到期（含今天）的设备，最快到期的在前（家庭场景提醒页那一组） */
export function warrantySoonDevices<T extends { warrantyUntil: string | null }>(
  devices: readonly T[],
  today: string,
): { device: T; daysLeft: number }[] {
  return devices
    .map((device) => ({ device, status: warrantyStatus(device.warrantyUntil, today) }))
    .filter((entry) => entry.status?.level === 'soon')
    .map((entry) => ({ device: entry.device, daysLeft: entry.status?.daysLeft ?? 0 }))
    .sort((left, right) => left.daysLeft - right.daysLeft);
}

/** 保修快到期那一行的标签：「剩 12 天」/「今天到期」 */
export function warrantyChipText(daysLeft: number): string {
  return daysLeft > 0 ? `剩 ${daysLeft} 天` : '今天到期';
}
