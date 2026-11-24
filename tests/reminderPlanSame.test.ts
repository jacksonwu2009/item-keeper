/**
 * 提醒计划改成按整数天算以后，结果要和原来逐天逐批解析日期的写法完全一样：随机造数据，新旧两种算法逐项比对。
 * 原来的写法原样抄在这里（referenceStatusForDay 等），只用来比对。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addDays, dateStrToLocalDate, diffDays, epochDay, todayStr } from '../src/lib/dates';
import { backupStatus, planBackupReminders } from '../src/lib/backupReminder';
import {
  buildMessage,
  planReminders,
  planUnchangedUntil,
  statusForDay,
  warrantyDueOn,
  type DayStatus,
  type ExpiryEntry,
  type LowStockEntry,
  type PlannedReminder,
  type PlanProduct,
  type PlanWarranty,
  type ReminderSettings,
} from '../src/lib/reminderPlan';
import { WARRANTY_SOON_DAYS } from '../src/lib/warranty';

// ---------- 原来的写法 ----------

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function referenceWarrantyDueOn(warranties: readonly PlanWarranty[], day: string): string[] {
  return warranties.filter((item) => diffDays(item.warrantyUntil, day) === WARRANTY_SOON_DAYS).map((item) => item.name);
}

function referenceStatusForDay(products: PlanProduct[], settings: ReminderSettings, day: string): DayStatus {
  const repeat = positiveInt(settings.repeatEveryDays, 1);
  const expiring: ExpiryEntry[] = [];
  const expired: ExpiryEntry[] = [];
  const lowStock: LowStockEntry[] = [];
  if (settings.expiryEnabled) {
    for (const product of products) {
      const lead = Math.max(0, Math.floor(product.expiryLeadDays ?? settings.expiryLeadDays));
      let mostUrgent: ExpiryEntry | null = null;
      let anyDue = false;
      for (const batch of product.batches) {
        if (!batch.expiryDate || !(batch.quantity > 0)) continue;
        const daysLeft = diffDays(batch.expiryDate, day);
        if (daysLeft > lead) continue;
        const alertStart = addDays(batch.expiryDate, -lead);
        const sinceStart = diffDays(day, alertStart);
        const due = daysLeft === 0 || sinceStart % repeat === 0;
        anyDue = anyDue || due;
        if (!mostUrgent || daysLeft < mostUrgent.daysLeft) {
          mostUrgent = { product, name: product.name, daysLeft, expiryDate: batch.expiryDate, quantity: batch.quantity, due };
        }
      }
      if (mostUrgent) {
        const entry = { ...mostUrgent, due: anyDue };
        (entry.daysLeft < 0 ? expired : expiring).push(entry);
      }
    }
  }
  const lowStockDue = settings.lowStockEnabled && epochDay(day) % repeat === 0;
  if (settings.lowStockEnabled) {
    for (const product of products) {
      if (product.lowStockThreshold === null || product.lowStockThreshold === undefined) continue;
      if (product.totalQty <= product.lowStockThreshold) {
        lowStock.push({ product, name: product.name, qty: product.totalQty, unit: product.unit });
      }
    }
  }
  expiring.sort((a, b) => a.daysLeft - b.daysLeft);
  expired.sort((a, b) => a.daysLeft - b.daysLeft);
  const due = expiring.some((entry) => entry.due) || expired.some((entry) => entry.due) || (lowStockDue && lowStock.length > 0);
  return { expiring, expired, lowStock, due };
}

function referencePlanReminders(
  products: PlanProduct[],
  settings: ReminderSettings,
  now: Date,
  horizonDays = 60,
  maxCount = 60,
  warranties: readonly PlanWarranty[] = [],
): PlannedReminder[] {
  const today = todayStr(now);
  const plan: PlannedReminder[] = [];
  for (let offset = 0; offset <= horizonDays && plan.length < maxCount; offset++) {
    const day = addDays(today, offset);
    const at = dateStrToLocalDate(day, settings.reminderHour, settings.reminderMinute);
    if (at.getTime() <= now.getTime()) continue;
    const status = referenceStatusForDay(products, settings, day);
    const warrantyNames = settings.expiryEnabled ? referenceWarrantyDueOn(warranties, day) : [];
    if (!status.due && !warrantyNames.length) continue;
    const { title, body } = buildMessage(status, warrantyNames);
    plan.push({ day, at, title, body });
  }
  return plan;
}

// ---------- 随机数据 ----------

/** 固定种子的伪随机数，失败时能复现 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function randomDay(random: () => number, around: string): string {
  return addDays(around, Math.floor(random() * 240) - 120);
}

function randomProducts(random: () => number, count: number, today: string): PlanProduct[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    kind: pick(random, ['food', 'daily']),
    name: `物品${index}`,
    unit: pick(random, ['个', '盒', '瓶']),
    totalQty: pick(random, [0, 0.5, 1, 2, 3, 10]),
    lowStockThreshold: pick(random, [null, 0, 1, 2, 5]),
    expiryLeadDays: pick(random, [null, 0, 3, 7, 30, 2.7]),
    batches: Array.from({ length: Math.floor(random() * 4) }, () => ({
      quantity: pick(random, [0, -1, 1, 2.5, 6]),
      expiryDate: random() < 0.15 ? null : randomDay(random, today),
    })),
  }));
}

function randomSettings(random: () => number): ReminderSettings {
  return {
    expiryEnabled: random() < 0.85,
    lowStockEnabled: random() < 0.85,
    expiryLeadDays: pick(random, [0, 3, 7, 14]),
    repeatEveryDays: pick(random, [1, 2, 3, 7, 0, -2, 1.5]),
    reminderHour: pick(random, [0, 8, 9, 21, 23]),
    reminderMinute: pick(random, [0, 30, 59]),
  };
}

function randomWarranties(random: () => number, count: number, today: string): PlanWarranty[] {
  return Array.from({ length: count }, (_, index) => ({ name: `设备${index}`, warrantyUntil: randomDay(random, today) }));
}

/** 比较时把 Date 换成毫秒数 */
function comparable(plan: PlannedReminder[]) {
  return plan.map((item) => ({ ...item, at: item.at.getTime() }));
}

describe('提醒计划按整数天算，结果和原来一样', () => {
  it('随机 300 组数据：planReminders（不同条数上限）、statusForDay、warrantyDueOn 逐项相同', () => {
    for (let round = 0; round < 300; round++) {
      const random = seeded(round + 1);
      // 现在的时间：跨年、月底、一天里的不同时刻
      const now = new Date(2026, pick(random, [0, 1, 2, 11]), 1 + Math.floor(random() * 28), Math.floor(random() * 24), Math.floor(random() * 60));
      const today = todayStr(now);
      const products = randomProducts(random, 1 + Math.floor(random() * 40), today);
      const settings = randomSettings(random);
      const warranties = randomWarranties(random, Math.floor(random() * 6), today);
      for (const maxCount of [1, 28, 60]) {
        assert.deepEqual(
          comparable(planReminders(products, settings, now, 60, maxCount, warranties)),
          comparable(referencePlanReminders(products, settings, now, 60, maxCount, warranties)),
          `第 ${round + 1} 组，最多 ${maxCount} 条`,
        );
      }
      for (const offset of [0, 1, 5, 30]) {
        const day = addDays(today, offset);
        const pageSettings = { ...settings, expiryEnabled: true, lowStockEnabled: true };
        assert.deepEqual(statusForDay(products, pageSettings, day), referenceStatusForDay(products, pageSettings, day), `第 ${round + 1} 组 ${day}`);
        assert.deepEqual(statusForDay(products, settings, day), referenceStatusForDay(products, settings, day));
        assert.deepEqual(warrantyDueOn(warranties, day), referenceWarrantyDueOn(warranties, day));
      }
    }
  });

  it('日期写坏了：和原来报同样的错', () => {
    const now = new Date(2026, 10, 24, 8, 0);
    const settings = randomSettings(seeded(7));
    const fullSettings = { ...settings, expiryEnabled: true, lowStockEnabled: true };
    const broken: PlanProduct[] = [
      { name: '好的', unit: '个', totalQty: 1, lowStockThreshold: null, expiryLeadDays: 3, batches: [{ quantity: 1, expiryDate: '2026-11-26' }] },
      { name: '坏的', unit: '个', totalQty: 1, lowStockThreshold: null, expiryLeadDays: 3, batches: [{ quantity: 1, expiryDate: '2026-13-40' }] },
    ];
    const errorOf = (task: () => unknown) => {
      try {
        task();
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    assert.equal(
      errorOf(() => planReminders(broken, fullSettings, now)),
      errorOf(() => referencePlanReminders(broken, fullSettings, now)),
    );
    assert.equal(errorOf(() => planReminders(broken, fullSettings, now)), '无效日期：2026-13-40');
    const badWarranty = [{ name: '电视', warrantyUntil: '2026/12/01' }];
    assert.equal(
      errorOf(() => planReminders([], fullSettings, now, 60, 60, badWarranty)),
      errorOf(() => referencePlanReminders([], fullSettings, now, 60, 60, badWarranty)),
    );
  });
});

describe('另一个场景的计划缓存到什么时候', () => {
  it('从算的那一刻到 planUnchangedUntil 之前，物品提醒和备份提醒排出来都一样；时、分不正常时不缓存', () => {
    for (let round = 0; round < 200; round++) {
      const random = seeded(1000 + round);
      const now = new Date(2026, Math.floor(random() * 12), 1 + Math.floor(random() * 28), Math.floor(random() * 24), Math.floor(random() * 60), Math.floor(random() * 60));
      const today = todayStr(now);
      const settings = { ...randomSettings(random), reminderHour: Math.floor(random() * 24), reminderMinute: Math.floor(random() * 60) };
      const products = randomProducts(random, 20, today);
      const warranties = randomWarranties(random, 3, today);
      const lastExportAt = `${randomDay(random, today)}T03:00:00.000Z`;
      const status = backupStatus({ lastExportAt, dataSince: null, reminderDays: 30, now });
      const until = planUnchangedUntil(now, settings);
      assert.ok(until !== null && until > now.getTime());
      const base = {
        items: comparable(planReminders(products, settings, now, 60, 28, warranties)),
        backup: comparable(planBackupReminders(status, settings, now, 2)),
      };
      for (const later of [now.getTime() + 1, (now.getTime() + until) / 2, until - 1]) {
        const laterNow = new Date(Math.floor(later));
        const laterStatus = backupStatus({ lastExportAt, dataSince: null, reminderDays: 30, now: laterNow });
        assert.deepEqual(comparable(planReminders(products, settings, laterNow, 60, 28, warranties)), base.items, `第 ${round + 1} 组`);
        assert.deepEqual(comparable(planBackupReminders(laterStatus, settings, laterNow, 2)), base.backup, `第 ${round + 1} 组备份`);
      }
    }
    assert.equal(planUnchangedUntil(new Date(), { reminderHour: 24, reminderMinute: 0 }), null);
    assert.equal(planUnchangedUntil(new Date(), { reminderHour: 9, reminderMinute: 7.5 }), null);
  });
});
