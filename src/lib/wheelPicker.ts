/**
 * 安卓日期、时间滚轮面板（components/WheelPicker.tsx）用的纯逻辑：年份范围、按最早日期灰掉和夹取、日数跟着年月变、
 * 面板上方那一行的文字、分钟档位、按滚动位置算停在第几行。纯函数，有单测。日期一律是本地日期字符串 YYYY-MM-DD（见 dates.ts）。
 */
import { daysInMonth, diffDays, parseDateStr } from './dates';

/** 年份滚轮从哪一年开始 */
export const WHEEL_FIRST_YEAR = 2000;
/** 年份滚轮最晚到今年往后多少年 */
export const WHEEL_YEARS_AHEAD = 30;
/** 分钟几分钟一档，和 iOS 系统滚轮的 minuteInterval 一样 */
export const WHEEL_MINUTE_STEP = 5;

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 滚轮上选中的年、月、日（month 从 1 开始） */
export type WheelDate = { year: number; month: number; day: number };

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function toWheelDate(value: string): WheelDate {
  const parts = parseDateStr(value);
  if (!parts) throw new Error(`无效日期：${value}`);
  return parts;
}

export function wheelDateToStr(date: WheelDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

/**
 * 年份滚轮列哪些年：从 2000 年到今年 + 30 年，最早能选的是 2000 年和最早日期所在年里大的那个——
 * 早于最早日期所在年的年份照样列出来，只是灰掉（见 isYearDisabled）。
 * 当前值落在范围外时把它所在的年也列进来，免得打开面板就把原来的日期改掉；最早日期晚于范围时也列到它那年。
 */
export function wheelYears({
  today,
  value,
  minimumDate,
}: {
  today: string;
  value: string | null;
  minimumDate: string | null;
}): number[] {
  const valueYear = value ? parseDateStr(value)?.year : undefined;
  const minimumYear = minimumDate ? parseDateStr(minimumDate)?.year : undefined;
  const firstYear = Math.min(WHEEL_FIRST_YEAR, valueYear ?? WHEEL_FIRST_YEAR);
  const lastYear = Math.max(
    toWheelDate(today).year + WHEEL_YEARS_AHEAD,
    valueYear ?? WHEEL_FIRST_YEAR,
    minimumYear ?? WHEEL_FIRST_YEAR,
  );
  return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
}

export function wheelMonths(): number[] {
  return Array.from({ length: 12 }, (_, index) => index + 1);
}

/** 日数跟着年月变：2 月 28 / 29 天，小月 30 天 */
export function wheelDays(year: number, month: number): number[] {
  return Array.from({ length: daysInMonth(year, month) }, (_, index) => index + 1);
}

function minimumParts(minimumDate: string | null): WheelDate | null {
  return minimumDate ? parseDateStr(minimumDate) : null;
}

/** 早于最早日期所在年的年份灰掉 */
export function isYearDisabled(year: number, minimumDate: string | null): boolean {
  const minimum = minimumParts(minimumDate);
  return !!minimum && year < minimum.year;
}

/** 选中的年份里，早于最早日期所在月的月份灰掉 */
export function isMonthDisabled(year: number, month: number, minimumDate: string | null): boolean {
  const minimum = minimumParts(minimumDate);
  if (!minimum) return false;
  return year < minimum.year || (year === minimum.year && month < minimum.month);
}

/** 选中的年月里，早于最早日期的日子灰掉 */
export function isDayDisabled(date: WheelDate, minimumDate: string | null): boolean {
  const minimum = minimumParts(minimumDate);
  if (!minimum) return false;
  return wheelDateToStr(date) < wheelDateToStr(minimum);
}

/**
 * 拨动某一列之后整理选中的日期：先按最早日期一列一列往上夹（年早了改成最早那年；同一年里月早了改成最早那月；
 * 同年同月里日早了改成最早那天），只动早了的那几列；再把超过当月天数的日改成当月最后一天（1 月 31 日拨到 2 月 = 2 月 28 / 29 日）。
 */
export function resolveWheelDate(date: WheelDate, minimumDate: string | null): WheelDate {
  let { year, month, day } = date;
  const minimum = minimumParts(minimumDate);
  if (minimum) {
    if (year < minimum.year) year = minimum.year;
    if (year === minimum.year && month < minimum.month) month = minimum.month;
    if (year === minimum.year && month === minimum.month && day < minimum.day) day = minimum.day;
  }
  return { year, month, day: Math.min(day, daysInMonth(year, month)) };
}

/** 打开面板时滚轮停在哪天：有值停在值上，没值停在今天；早于最早日期的停在最早日期那天 */
export function initialWheelDate(value: string | null, today: string, minimumDate: string | null): WheelDate {
  const start = value ?? today;
  return toWheelDate(minimumDate && start < minimumDate ? minimumDate : start);
}

/** 面板上方那一行：2027年5月20日 星期四 · 180 天后 / 今天 / 3 天前 */
export function describeWheelDate(date: string, today: string): string {
  const { year, month, day } = toWheelDate(date);
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const daysFromToday = diffDays(date, today);
  const distance = daysFromToday === 0 ? '今天' : daysFromToday > 0 ? `${daysFromToday} 天后` : `${-daysFromToday} 天前`;
  return `${year}年${month}月${day}日 ${weekday} · ${distance}`;
}

export function wheelHours(): number[] {
  return Array.from({ length: 24 }, (_, index) => index);
}

/** 分钟按 5 分钟一档；现在的值不在档上时（比如以前存的 09:07）也列出来，免得打开面板就被改掉 */
export function wheelMinutes(current: number, step = WHEEL_MINUTE_STEP): number[] {
  const options = Array.from({ length: Math.ceil(60 / step) }, (_, index) => index * step);
  return options.includes(current) ? options : [...options, current].sort((left, right) => left - right);
}

/** 滚动停下时停在第几行：按偏移量四舍五入到最近的一行，超出两头的算第一行 / 最后一行 */
export function wheelIndexAt(offset: number, rowHeight: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.min(rowCount - 1, Math.max(0, Math.round(offset / rowHeight)));
}

/**
 * 停在灰掉的一行时弹到哪一行：往后找最近的能选的（灰掉的都是早于最早日期的，在前面），后面没有再往前找；
 * 本来就能选的原样返回。
 */
export function nearestEnabledIndex(disabledFlags: readonly boolean[], index: number): number {
  if (!disabledFlags[index]) return index;
  for (let next = index + 1; next < disabledFlags.length; next++) {
    if (!disabledFlags[next]) return next;
  }
  for (let previous = index - 1; previous >= 0; previous--) {
    if (!disabledFlags[previous]) return previous;
  }
  return index;
}
