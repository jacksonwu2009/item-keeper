import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDays,
  addMonths,
  describeDaysLeft,
  diffDays,
  expiryFromShelfLife,
  isValidDateStr,
} from '../src/lib/dates';
import { planReminders, statusForDay, type PlanProduct, type ReminderSettings } from '../src/lib/reminderPlan';
import { parseQty, planConsumption } from '../src/lib/stock';

const settings: ReminderSettings = {
  expiryEnabled: true,
  lowStockEnabled: true,
  expiryLeadDays: 7,
  repeatEveryDays: 1,
  reminderHour: 9,
  reminderMinute: 0,
};

function product(overrides: Partial<PlanProduct>): PlanProduct {
  return {
    name: '牛奶',
    unit: '盒',
    totalQty: 5,
    lowStockThreshold: 1,
    expiryLeadDays: null,
    batches: [],
    ...overrides,
  };
}

describe('dates', () => {
  it('跨月跨年加减天数', () => {
    assert.equal(addDays('2026-12-30', 3), '2027-01-02');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(diffDays('2027-01-02', '2026-12-30'), 3);
  });

  it('加月份落到月末', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  });

  it('按生产日期和保质期算到期日', () => {
    assert.equal(expiryFromShelfLife('2026-11-01', 30, 'day'), '2026-11-30');
    assert.equal(expiryFromShelfLife('2026-11-18', 12, 'month'), '2027-11-17');
    assert.equal(expiryFromShelfLife('2026-11-18', 1, 'year'), '2027-11-17');
  });

  it('校验日期', () => {
    assert.equal(isValidDateStr('2026-02-29'), false);
    assert.equal(isValidDateStr('2028-02-29'), true);
    assert.equal(isValidDateStr('2026-13-01'), false);
  });

  it('剩余天数的说法', () => {
    assert.equal(describeDaysLeft(-2), '已过期 2 天');
    assert.equal(describeDaysLeft(0), '今天到期');
    assert.equal(describeDaysLeft(1), '明天到期');
    assert.equal(describeDaysLeft(6), '6 天后到期');
  });
});

describe('出库先扣先到期的批次', () => {
  it('按过期日期顺序扣，没有日期的最后扣', () => {
    const plan = planConsumption(
      [
        { id: 1, quantity: 2, expiryDate: null },
        { id: 2, quantity: 1, expiryDate: '2026-12-01' },
        { id: 3, quantity: 3, expiryDate: '2026-11-20' },
      ],
      5,
    );
    assert.deepEqual(plan.updates, [
      { id: 3, quantity: 0 },
      { id: 2, quantity: 0 },
      { id: 1, quantity: 1 },
    ]);
    assert.equal(plan.consumed, 5);
    assert.equal(plan.shortfall, 0);
  });

  it('不够扣时报告缺口', () => {
    const plan = planConsumption([{ id: 1, quantity: 1.5, expiryDate: null }], 2);
    assert.equal(plan.consumed, 1.5);
    assert.equal(plan.shortfall, 0.5);
  });

  it('解析数量', () => {
    assert.equal(parseQty('1,5'), 1.5);
    assert.equal(parseQty('-1'), null);
    assert.equal(parseQty(''), null);
  });
});

describe('提醒状态', () => {
  it('进入提前期才算快到期，过期单独列', () => {
    const products = [
      product({ name: '牛奶', batches: [{ quantity: 2, expiryDate: '2026-11-21' }] }),
      product({ name: '面包', batches: [{ quantity: 1, expiryDate: '2026-11-17' }] }),
      product({ name: '大米', batches: [{ quantity: 1, expiryDate: '2027-06-01' }] }),
    ];
    const status = statusForDay(products, settings, '2026-11-18');
    assert.deepEqual(
      status.expiring.map((entry) => [entry.name, entry.daysLeft]),
      [['牛奶', 3]],
    );
    assert.deepEqual(
      status.expired.map((entry) => [entry.name, entry.daysLeft]),
      [['面包', -1]],
    );
    assert.equal(status.due, true);
  });

  it('数量为 0 的批次不提醒', () => {
    const status = statusForDay(
      [product({ batches: [{ quantity: 0, expiryDate: '2026-11-18' }] })],
      settings,
      '2026-11-18',
    );
    assert.equal(status.expiring.length, 0);
  });

  it('商品自己的提前天数优先', () => {
    const products = [product({ expiryLeadDays: 30, batches: [{ quantity: 1, expiryDate: '2026-12-10' }] })];
    assert.equal(statusForDay(products, settings, '2026-11-18').expiring.length, 1);
  });

  it('库存 ≤ 下限才算不足，没设下限不提醒', () => {
    const products = [
      product({ name: '纸巾', totalQty: 1, lowStockThreshold: 1 }),
      product({ name: '洗衣液', totalQty: 2, lowStockThreshold: 1 }),
      product({ name: '牙膏', totalQty: 0, lowStockThreshold: null }),
    ];
    const status = statusForDay(products, settings, '2026-11-18');
    assert.deepEqual(
      status.lowStock.map((entry) => entry.name),
      ['纸巾'],
    );
  });

  it('关掉到期提醒后不再列到期', () => {
    const status = statusForDay(
      [product({ batches: [{ quantity: 1, expiryDate: '2026-11-18' }] })],
      { ...settings, expiryEnabled: false },
      '2026-11-18',
    );
    assert.equal(status.expiring.length, 0);
    assert.equal(status.due, false);
  });
});

describe('提醒计划', () => {
  const now = new Date(2026, 10, 18, 10, 0); // 2026-11-18 10:00，已过当天 9 点

  it('每天提醒：从明天开始，到期当天也提醒，过期后继续', () => {
    const plan = planReminders(
      [product({ lowStockThreshold: null, batches: [{ quantity: 1, expiryDate: '2026-11-21' }] })],
      settings,
      now,
      5,
    );
    assert.deepEqual(
      plan.map((reminder) => reminder.day),
      ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'],
    );
    assert.equal(plan[0].at.getHours(), 9);
    assert.match(plan[2].body, /牛奶 今天到期/);
    assert.match(plan[3].body, /牛奶 已过期 1 天/);
  });

  it('每 3 天提醒：从进入提前期那天起算，到期当天一定提醒', () => {
    const plan = planReminders(
      [product({ lowStockThreshold: null, batches: [{ quantity: 1, expiryDate: '2026-11-28' }] })],
      { ...settings, repeatEveryDays: 3 },
      now,
      15,
    );
    // 提前期从 11-21 开始：11-21、11-24、11-27，到期日 11-28，过期后 11-30、12-03
    assert.deepEqual(
      plan.map((reminder) => reminder.day),
      ['2026-11-21', '2026-11-24', '2026-11-27', '2026-11-28', '2026-11-30', '2026-12-03'],
    );
  });

  it('当天提醒时间还没到时，今天也排', () => {
    const early = new Date(2026, 10, 18, 8, 0);
    const plan = planReminders([product({ totalQty: 0, lowStockThreshold: 1 })], settings, early, 1);
    assert.equal(plan[0].day, '2026-11-18');
    assert.match(plan[0].title, /1 样库存不足/);
  });

  it('库存提醒按固定节奏，不随重排往后推', () => {
    const products = [product({ totalQty: 0, lowStockThreshold: 1 })];
    const repeat = { ...settings, repeatEveryDays: 3 };
    const fromToday = planReminders(products, repeat, now, 9).map((reminder) => reminder.day);
    const fromTomorrow = planReminders(products, repeat, new Date(2026, 10, 19, 10, 0), 9).map(
      (reminder) => reminder.day,
    );
    // 今天排和明天重排，落在同样的日子上
    assert.equal(fromToday.length, 3);
    assert.deepEqual(fromTomorrow, fromToday);
  });

  it('最多排 maxCount 条', () => {
    const products = [product({ totalQty: 0, lowStockThreshold: 1 })];
    assert.equal(planReminders(products, settings, now, 120, 60).length, 60);
  });

  it('没有需要提醒的就不排', () => {
    assert.equal(planReminders([product({})], settings, now).length, 0);
  });
});
