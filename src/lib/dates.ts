/**
 * 日期工具。全应用统一用本地日期字符串 YYYY-MM-DD 表示「哪一天」，
 * 天数加减走 UTC 运算，避免夏令时把一天算成 23 或 25 小时。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function toDateStr(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayStr(now: Date = new Date()): string {
  return toDateStr(now);
}

type DateParts = { year: number; month: number; day: number };

export function parseDateStr(value: string): DateParts | null {
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isValidDateStr(value: string | null | undefined): value is string {
  return typeof value === 'string' && parseDateStr(value) !== null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mustParse(value: string): DateParts {
  const parts = parseDateStr(value);
  if (!parts) throw new Error(`无效日期：${value}`);
  return parts;
}

function toUtcMs(value: string): number {
  const { year, month, day } = mustParse(value);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 某天在本地时区的某个时刻，用来排通知。 */
export function dateStrToLocalDate(value: string, hour = 0, minute = 0): Date {
  const { year, month, day } = mustParse(value);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function addDays(value: string, days: number): string {
  return fromUtcMs(toUtcMs(value) + days * DAY_MS);
}

/** 加月份；目标月没有这一天时取月末（1 月 31 日 + 1 个月 = 2 月 28/29 日）。 */
export function addMonths(value: string, months: number): string {
  const { year, month, day } = mustParse(value);
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12 + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${pad2(targetMonth)}-${pad2(targetDay)}`;
}

export function addYears(value: string, years: number): string {
  return addMonths(value, years * 12);
}

/** a 比 b 晚几天（a - b）。 */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtcMs(a) - toUtcMs(b)) / DAY_MS);
}

/** 自 1970-01-01 起的天数，用来让「每 N 天提醒一次」有固定的节奏。 */
export function epochDay(value: string): number {
  return Math.round(toUtcMs(value) / DAY_MS);
}

export type ShelfLifeUnit = 'day' | 'month' | 'year';

/**
 * 按包装上的「生产日期 + 保质期」算到期日。
 * 保质期 N 天：生产当天算第 1 天，最后一天是生产日期 + N - 1。
 * 保质期 N 个月 / 年：到期日是生产日期加 N 个月 / 年的前一天。
 */
export function expiryFromShelfLife(productionDate: string, amount: number, unit: ShelfLifeUnit): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('保质期必须大于 0');
  if (unit === 'day') return addDays(productionDate, amount - 1);
  const end = unit === 'month' ? addMonths(productionDate, amount) : addYears(productionDate, amount);
  return addDays(end, -1);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parts = parseDateStr(value);
  if (!parts) return value;
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parts = parseDateStr(value);
  if (!parts) return value;
  return `${parts.month}月${parts.day}日`;
}

/** 距离到期还有几天的说法：已过期 3 天 / 今天到期 / 明天到期 / 5 天后到期。 */
export function describeDaysLeft(daysLeft: number): string {
  if (daysLeft < 0) return `已过期 ${-daysLeft} 天`;
  if (daysLeft === 0) return '今天到期';
  if (daysLeft === 1) return '明天到期';
  return `${daysLeft} 天后到期`;
}

export function formatTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}
