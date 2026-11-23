/**
 * 提醒计划：纯函数，不碰数据库和通知 API，方便单测。
 *
 * 规则
 * - 每天固定时刻最多发一条汇总通知。
 * - 到期提醒：某批次进入「到期前 N 天」后开始提醒，此后每隔 repeatEveryDays 天提醒一次；
 *   到期当天一定提醒；过期后仍按同样间隔提醒，直到这批东西被用掉或删除。
 * - 库存提醒：库存 ≤ 下限时，每隔 repeatEveryDays 天提醒一次（按固定日历节奏，
 *   不会因为每天打开 App 重新排程而一直往后推）。
 * - 某天只要有一项「轮到提醒」，那天就发通知，内容列出当天所有需要注意的东西。
 * - 保修提醒（只在家庭场景传进来）：设备保修到期前 30 天那一天提醒一次，写进那天的汇总通知；那天本来没有通知就单发一条。
 * - 家庭、办公两个场景各排各的（各用自己的提醒设置），再合到一起（mergeScenePlans）：
 *   同一天同一时刻两边都有提醒就合成一条，分别用「家里：」「公司：」开头；时间不同各发各的；只有一个场景有就不加前缀。
 */

import { addDays, dateStrToLocalDate, describeDaysLeft, diffDays, epochDay, todayStr } from './dates';
import { SCENE_REMINDER_PREFIX, SCENES, type Scene } from './terms';
import { WARRANTY_SOON_DAYS } from './warranty';

/** iOS 每个 App 最多挂 64 条本地通知，物品提醒和备份提醒一共用 60 条，两个场景平分：每个场景物品提醒 28 条、备份提醒 2 条 */
export const ITEM_REMINDER_SLOTS_PER_SCENE = 28;

export type ReminderSettings = {
  expiryEnabled: boolean;
  lowStockEnabled: boolean;
  /** 到期前几天开始提醒（商品没单独设置时用这个）。 */
  expiryLeadDays: number;
  /** 每隔几天提醒一次，1 = 每天。 */
  repeatEveryDays: number;
  reminderHour: number;
  reminderMinute: number;
};

export type PlanBatch = { quantity: number; expiryDate: string | null };

export type PlanProduct = {
  /** 提醒页跳转用，排通知时不需要 */
  id?: number;
  kind?: string;
  name: string;
  unit: string;
  totalQty: number;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  batches: PlanBatch[];
};

/** 要提醒保修的设备：名字（多个地点时带地点前缀）和保修到期日 */
export type PlanWarranty = { name: string; warrantyUntil: string };

/** 这一天该提醒保修的设备名：保修到期日正好是 30 天后的 */
export function warrantyDueOn(warranties: readonly PlanWarranty[], day: string): string[] {
  return warranties.filter((item) => diffDays(item.warrantyUntil, day) === WARRANTY_SOON_DAYS).map((item) => item.name);
}

export type PlannedReminder = {
  /** 哪一天（YYYY-MM-DD） */
  day: string;
  /** 本地时间的触发时刻 */
  at: Date;
  title: string;
  body: string;
};

export type ExpiryEntry = { product: PlanProduct; name: string; daysLeft: number; expiryDate: string; quantity: number; due: boolean };
export type LowStockEntry = { product: PlanProduct; name: string; qty: number; unit: string };

export type DayStatus = {
  expiring: ExpiryEntry[];
  expired: ExpiryEntry[];
  lowStock: LowStockEntry[];
  due: boolean;
};

const BODY_LIMIT = 160;

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** 某一天的提醒状态：有哪些快到期 / 已过期 / 库存不足，以及这天是否该发通知。 */
export function statusForDay(products: PlanProduct[], settings: ReminderSettings, day: string): DayStatus {
  const repeat = positiveInt(settings.repeatEveryDays, 1);
  const expiring: ExpiryEntry[] = [];
  const expired: ExpiryEntry[] = [];
  const lowStock: LowStockEntry[] = [];

  if (settings.expiryEnabled) {
    for (const product of products) {
      const lead = Math.max(0, Math.floor(product.expiryLeadDays ?? settings.expiryLeadDays));
      // 同一商品多个批次时，只保留最紧急的一条，但只要有一批轮到提醒就算轮到。
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
          mostUrgent = {
            product,
            name: product.name,
            daysLeft,
            expiryDate: batch.expiryDate,
            quantity: batch.quantity,
            due,
          };
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

  const due =
    expiring.some((entry) => entry.due) ||
    expired.some((entry) => entry.due) ||
    (lowStockDue && lowStock.length > 0);

  return { expiring, expired, lowStock, due };
}

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 100) / 100);
}

export function buildMessage(status: DayStatus, warrantyNames: readonly string[] = []): { title: string; body: string } {
  const titleParts: string[] = [];
  if (status.expiring.length) titleParts.push(`${status.expiring.length} 样快到期`);
  if (status.expired.length) titleParts.push(`${status.expired.length} 样已过期`);
  if (status.lowStock.length) titleParts.push(`${status.lowStock.length} 样库存不足`);
  if (warrantyNames.length) titleParts.push(`${warrantyNames.length} 件设备保修快到期`);

  const lines: string[] = [];
  for (const entry of [...status.expired, ...status.expiring]) {
    lines.push(`${entry.name} ${describeDaysLeft(entry.daysLeft)}`);
  }
  if (status.lowStock.length) {
    const names = status.lowStock.map((entry) => `${entry.name}（剩 ${formatQty(entry.qty)} ${entry.unit}）`);
    lines.push(`库存不足：${names.join('、')}`);
  }
  if (warrantyNames.length) lines.push(`保修 ${WARRANTY_SOON_DAYS} 天后到期：${warrantyNames.join('、')}，有问题趁保修期内报修`);

  let body = lines.join('；');
  if (body.length > BODY_LIMIT) body = `${body.slice(0, BODY_LIMIT - 1)}…`;
  return { title: titleParts.join('，'), body };
}

/**
 * 从现在起往后 horizonDays 天的通知计划（最多 maxCount 条；iOS 每个 App 最多挂 64 条本地通知）。
 * 假设这段时间里库存不变；用户一改库存就会重新排。
 */
export function planReminders(
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
    const status = statusForDay(products, settings, day);
    // 保修提醒跟着「到期提醒」开关走
    const warrantyNames = settings.expiryEnabled ? warrantyDueOn(warranties, day) : [];
    if (!status.due && !warrantyNames.length) continue;
    const { title, body } = buildMessage(status, warrantyNames);
    plan.push({ day, at, title, body });
  }
  return plan;
}

/** 一个场景排好的提醒：物品（到期、库存、保修）的汇总通知和备份提醒分开放，合并时同类的才合成一条 */
export type ScenePlan = { scene: Scene; items: PlannedReminder[]; backup: PlannedReminder[] };

type Tagged = { scene: Scene; kind: 'items' | 'backup'; reminder: PlannedReminder };

function prefixed(entries: readonly Tagged[]): PlannedReminder {
  const [first] = entries;
  return {
    day: first.reminder.day,
    at: first.reminder.at,
    title: entries.map((entry) => `${SCENE_REMINDER_PREFIX[entry.scene]}${entry.reminder.title}`).join('；'),
    body: entries.map((entry) => `${SCENE_REMINDER_PREFIX[entry.scene]}${entry.reminder.body}`).join('\n'),
  };
}

/**
 * 把两个场景排好的提醒合成要发的通知，按时间排好。
 * - 某个时刻只有一个场景有提醒：原样发，不加前缀（和只用一个场景时一样）。
 * - 同一时刻两个场景都有：物品提醒合成一条、备份提醒合成一条，标题和正文里每个场景那部分分别用「家里：」「公司：」开头
 *   （标题用「；」隔开，正文分行）；只有一边有的那一类也加上前缀，分得清是哪边的。家里的在前。
 */
export function mergeScenePlans(plans: readonly ScenePlan[]): PlannedReminder[] {
  const byTime = new Map<number, Tagged[]>();
  for (const plan of plans) {
    for (const kind of ['items', 'backup'] as const) {
      for (const reminder of plan[kind]) {
        const time = reminder.at.getTime();
        const group = byTime.get(time) ?? [];
        group.push({ scene: plan.scene, kind, reminder });
        byTime.set(time, group);
      }
    }
  }
  const merged: PlannedReminder[] = [];
  for (const time of [...byTime.keys()].sort((left, right) => left - right)) {
    const group = byTime.get(time) ?? [];
    const scenes = new Set(group.map((entry) => entry.scene));
    for (const kind of ['items', 'backup'] as const) {
      const entries = group
        .filter((entry) => entry.kind === kind)
        .sort((left, right) => SCENES.indexOf(left.scene) - SCENES.indexOf(right.scene));
      if (!entries.length) continue;
      if (scenes.size < 2) merged.push(...entries.map((entry) => entry.reminder));
      else merged.push(prefixed(entries));
    }
  }
  return merged;
}
