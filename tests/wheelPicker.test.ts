/**
 * 安卓日期、时间滚轮面板的纯逻辑：年份范围、每月天数、按最早日期灰掉和夹取、上方那一行的文字、分钟档位、停在第几行。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeWheelDate,
  initialWheelDate,
  isDayDisabled,
  isMonthDisabled,
  isYearDisabled,
  nearestEnabledIndex,
  resolveWheelDate,
  wheelDateToStr,
  wheelDays,
  wheelHours,
  wheelIndexAt,
  wheelMinutes,
  wheelMonths,
  wheelYears,
} from '../src/lib/wheelPicker';

describe('年份范围', () => {
  it('从 2000 年到今年 + 30 年', () => {
    const years = wheelYears({ today: '2026-11-21', value: null, minimumDate: null });
    assert.equal(years[0], 2000);
    assert.equal(years.at(-1), 2056);
    assert.equal(years.length, 57);
  });

  it('有最早日期：早于它所在年的年份照样列出来，只是灰掉；早于 2000 年的最早日期不往前加年份', () => {
    const years = wheelYears({ today: '2026-11-21', value: null, minimumDate: '2026-11-09' });
    assert.equal(years[0], 2000);
    assert.equal(isYearDisabled(2025, '2026-11-09'), true);
    assert.equal(isYearDisabled(2026, '2026-11-09'), false);
    assert.equal(isYearDisabled(2025, null), false);
    assert.equal(wheelYears({ today: '2026-11-21', value: null, minimumDate: '1995-03-01' })[0], 2000);
  });

  it('当前值、最早日期在范围外时把那一年也列进来，打开面板不会改掉原来的日期', () => {
    assert.equal(wheelYears({ today: '2026-11-21', value: '1998-06-01', minimumDate: null })[0], 1998);
    assert.equal(wheelYears({ today: '2026-11-21', value: '2070-01-01', minimumDate: null }).at(-1), 2070);
    assert.equal(wheelYears({ today: '2026-11-21', value: null, minimumDate: '2060-01-01' }).at(-1), 2060);
  });
});

describe('月份、日数', () => {
  it('月份 1～12，日数跟着年月变：闰年 2 月 29 天、平年 28 天、小月 30 天、大月 31 天', () => {
    assert.deepEqual(wheelMonths(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(wheelDays(2028, 2).length, 29);
    assert.equal(wheelDays(2027, 2).length, 28);
    assert.equal(wheelDays(2100, 2).length, 28);
    assert.equal(wheelDays(2000, 2).length, 29);
    assert.equal(wheelDays(2026, 11).length, 30);
    assert.equal(wheelDays(2026, 12).length, 31);
    assert.equal(wheelDays(2026, 12)[0], 1);
  });

  it('选中的日超过当月天数时改成当月最后一天', () => {
    assert.deepEqual(resolveWheelDate({ year: 2027, month: 2, day: 31 }, null), { year: 2027, month: 2, day: 28 });
    assert.deepEqual(resolveWheelDate({ year: 2028, month: 2, day: 31 }, null), { year: 2028, month: 2, day: 29 });
    assert.deepEqual(resolveWheelDate({ year: 2026, month: 11, day: 31 }, null), { year: 2026, month: 11, day: 30 });
    assert.deepEqual(resolveWheelDate({ year: 2026, month: 12, day: 31 }, null), { year: 2026, month: 12, day: 31 });
  });
});

describe('最早日期', () => {
  const minimum = '2026-11-09';

  it('早于最早日期的年、月、日灰掉，当天能选', () => {
    assert.equal(isMonthDisabled(2026, 10, minimum), true);
    assert.equal(isMonthDisabled(2026, 11, minimum), false);
    assert.equal(isMonthDisabled(2027, 1, minimum), false);
    assert.equal(isMonthDisabled(2025, 12, minimum), true);
    assert.equal(isDayDisabled({ year: 2026, month: 11, day: 8 }, minimum), true);
    assert.equal(isDayDisabled({ year: 2026, month: 11, day: 9 }, minimum), false);
    assert.equal(isDayDisabled({ year: 2026, month: 12, day: 1 }, minimum), false);
    assert.equal(isDayDisabled({ year: 2026, month: 11, day: 8 }, null), false);
  });

  it('拨到早了的那一列弹回最早可选的值，其他列不动', () => {
    // 年拨到 2025：年弹回 2026，11 月 21 日不早于最早日期，不动
    assert.deepEqual(resolveWheelDate({ year: 2025, month: 11, day: 21 }, minimum), { year: 2026, month: 11, day: 21 });
    // 年拨到 2025、月是 3 月：年弹回 2026 后 3 月早了，月也改成 11 月；日 21 不早，不动
    assert.deepEqual(resolveWheelDate({ year: 2025, month: 3, day: 21 }, minimum), { year: 2026, month: 11, day: 21 });
    // 同年同月日早了：日改成 9 日
    assert.deepEqual(resolveWheelDate({ year: 2026, month: 11, day: 3 }, minimum), { year: 2026, month: 11, day: 9 });
    // 年月都晚于最早日期：日随便选
    assert.deepEqual(resolveWheelDate({ year: 2027, month: 1, day: 3 }, minimum), { year: 2027, month: 1, day: 3 });
  });

  it('夹到最早那月后日超过当月天数，改成当月最后一天', () => {
    assert.deepEqual(resolveWheelDate({ year: 2027, month: 1, day: 31 }, '2027-02-10'), { year: 2027, month: 2, day: 28 });
  });

  it('打开面板停在哪天：有值停在值上，没值停在今天，早于最早日期的停在最早日期', () => {
    assert.equal(wheelDateToStr(initialWheelDate('2027-05-20', '2026-11-21', null)), '2027-05-20');
    assert.equal(wheelDateToStr(initialWheelDate(null, '2026-11-21', null)), '2026-11-21');
    assert.equal(wheelDateToStr(initialWheelDate(null, '2026-11-21', '2026-12-05')), '2026-12-05');
    assert.equal(wheelDateToStr(initialWheelDate('2026-10-01', '2026-11-21', '2026-11-09')), '2026-11-09');
  });
});

describe('上方那一行的文字', () => {
  it('日期、星期几、离今天多久', () => {
    assert.equal(describeWheelDate('2027-05-20', '2026-11-21'), '2027年5月20日 星期四 · 180 天后');
    assert.equal(describeWheelDate('2026-11-21', '2026-11-21'), '2026年11月21日 星期六 · 今天');
    assert.equal(describeWheelDate('2026-11-22', '2026-11-21'), '2026年11月22日 星期日 · 1 天后');
    assert.equal(describeWheelDate('2026-11-18', '2026-11-21'), '2026年11月18日 星期三 · 3 天前');
    assert.equal(describeWheelDate('2026-11-16', '2026-11-21'), '2026年11月16日 星期一 · 5 天前');
  });
});

describe('时间', () => {
  it('时 0～23，分钟 5 分钟一档', () => {
    const hours = wheelHours();
    assert.equal(hours.length, 24);
    assert.equal(hours[0], 0);
    assert.equal(hours.at(-1), 23);
    assert.deepEqual(wheelMinutes(30), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it('现在的分钟不在档上时也列出来，按大小排好', () => {
    assert.deepEqual(wheelMinutes(7), [0, 5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    assert.equal(wheelMinutes(59).at(-1), 59);
  });
});

describe('滚轮停在第几行', () => {
  it('按偏移量四舍五入到最近的一行，超出两头的算第一行 / 最后一行', () => {
    assert.equal(wheelIndexAt(0, 48, 12), 0);
    assert.equal(wheelIndexAt(96, 48, 12), 2);
    assert.equal(wheelIndexAt(119, 48, 12), 2);
    assert.equal(wheelIndexAt(121, 48, 12), 3);
    assert.equal(wheelIndexAt(-30, 48, 12), 0);
    assert.equal(wheelIndexAt(48 * 20, 48, 12), 11);
    assert.equal(wheelIndexAt(100, 48, 0), 0);
  });

  it('停在灰掉的一行时弹到后面最近能选的一行，后面没有再往前找', () => {
    const disabledFlags = [true, true, false, false];
    assert.equal(nearestEnabledIndex(disabledFlags, 0), 2);
    assert.equal(nearestEnabledIndex(disabledFlags, 1), 2);
    assert.equal(nearestEnabledIndex(disabledFlags, 3), 3);
    assert.equal(nearestEnabledIndex([false, true, true], 2), 0);
    assert.equal(nearestEnabledIndex([true, true], 1), 1);
  });
});
