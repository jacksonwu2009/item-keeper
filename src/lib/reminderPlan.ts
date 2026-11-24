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

import { addDays, dateStrToLocalDate, describeDaysLeft, epochDay, todayStr } from './dates';
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
  return createWarrantyCheck(warranties)(lazyDayNumber(day));
}

/**
 * 保修提醒按天查：保修到期日折成天数只算一次（第一次用到时算，日期写错时和逐天解析时在同一处报错），
 * 之后每天只比整数。
 */
function createWarrantyCheck(warranties: readonly PlanWarranty[]): (dayNumber: () => number) => string[] {
  const untilDays: (number | undefined)[] = warranties.map(() => undefined);
  return (dayNumber) => {
    const names: string[] = [];
    warranties.forEach((item, index) => {
      let until = untilDays[index];
      if (until === undefined) {
        until = epochDay(item.warrantyUntil);
        untilDays[index] = until;
      }
      if (until - dayNumber() === WARRANTY_SOON_DAYS) names.push(item.name);
    });
    return names;
  };
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
  return createDayPlanner(products, settings).status(day, lazyDayNumber(day));
}

/** 某天是自 1970-01-01 起第几天，第一次用到时才算（和原来逐次解析时一样，用不到就不解析） */
function lazyDayNumber(day: string): () => number {
  let value: number | null = null;
  return () => {
    if (value === null) value = epochDay(day);
    return value;
  };
}

/**
 * 一批东西算提醒要用的天数：过期那天、开始提醒那天折成「自 1970-01-01 起第几天」。
 * 第一次用到时才算，之后每天只做整数加减（不再每天每批解析日期字符串）；日期写错时和原来逐天解析时在同一处报同样的错。
 */
type BatchDays = { batch: PlanBatch; expiry: number | null; alertStart: number | null };
type ProductDays = { product: PlanProduct; lead: number; batches: BatchDays[] };

/** 这一批过期那天离 day 还有几天（a - b 的天数差，和 diffDays 一样） */
function daysLeftOf(entry: BatchDays, dayNumber: () => number): number {
  if (entry.expiry === null) entry.expiry = epochDay(entry.batch.expiryDate as string);
  return entry.expiry - dayNumber();
}

/** 开始提醒那天到 day 过了几天：开始提醒那天 = 过期日期往前 lead 天（照原来先算出日期字符串再折成天数，日期出界时同样报错） */
function sinceAlertStart(entry: BatchDays, lead: number, dayNumber: () => number): number {
  if (entry.alertStart === null) entry.alertStart = epochDay(addDays(entry.batch.expiryDate as string, -lead));
  return dayNumber() - entry.alertStart;
}

/**
 * 按天算提醒状态的准备工作：每样东西的提醒提前天数、要看的批次（有过期日期、有数量的）、库存不足的名单只算一次，
 * 之后每一天只做整数运算。结果和逐天调 diffDays / addDays 完全一样（单测里随机造数据比对）。
 */
function createDayPlanner(products: PlanProduct[], settings: ReminderSettings) {
  const repeat = positiveInt(settings.repeatEveryDays, 1);
  let prepared: ProductDays[] | null = null;
  let lowStock: LowStockEntry[] | null = null;

  function productDays(): ProductDays[] {
    if (prepared === null) {
      prepared = products.map((product) => ({
        product,
        lead: Math.max(0, Math.floor(product.expiryLeadDays ?? settings.expiryLeadDays)),
        batches: product.batches
          .filter((batch) => batch.expiryDate && batch.quantity > 0)
          .map((batch) => ({ batch, expiry: null, alertStart: null })),
      }));
    }
    return prepared;
  }

  function lowStockEntries(): LowStockEntry[] {
    if (lowStock === null) {
      lowStock = [];
      for (const product of products) {
        if (product.lowStockThreshold === null || product.lowStockThreshold === undefined) continue;
        if (product.totalQty <= product.lowStockThreshold) {
          lowStock.push({ product, name: product.name, qty: product.totalQty, unit: product.unit });
        }
      }
    }
    return lowStock;
  }

  /** 这天是否该发通知：只看有没有一项轮到提醒，找到一项就停（不拼名单） */
  function isDue(dayNumber: () => number): boolean {
    if (settings.expiryEnabled) {
      for (const { lead, batches } of productDays()) {
        for (const entry of batches) {
          const daysLeft = daysLeftOf(entry, dayNumber);
          if (daysLeft > lead) continue;
          const sinceStart = sinceAlertStart(entry, lead, dayNumber);
          if (daysLeft === 0 || sinceStart % repeat === 0) return true;
        }
      }
    }
    const lowStockDue = settings.lowStockEnabled && dayNumber() % repeat === 0;
    return lowStockDue && lowStockEntries().length > 0;
  }

  function status(day: string, dayNumber: () => number): DayStatus {
    const expiring: ExpiryEntry[] = [];
    const expired: ExpiryEntry[] = [];

    if (settings.expiryEnabled) {
      for (const { product, lead, batches } of productDays()) {
        // 同一商品多个批次时，只保留最紧急的一条，但只要有一批轮到提醒就算轮到。
        let urgent: { batch: PlanBatch; daysLeft: number } | null = null;
        let anyDue = false;
        for (const entry of batches) {
          const daysLeft = daysLeftOf(entry, dayNumber);
          if (daysLeft > lead) continue;
          const sinceStart = sinceAlertStart(entry, lead, dayNumber);
          const due = daysLeft === 0 || sinceStart % repeat === 0;
          anyDue = anyDue || due;
          if (!urgent || daysLeft < urgent.daysLeft) urgent = { batch: entry.batch, daysLeft };
        }
        if (urgent) {
          const entry: ExpiryEntry = {
            product,
            name: product.name,
            daysLeft: urgent.daysLeft,
            expiryDate: urgent.batch.expiryDate as string,
            quantity: urgent.batch.quantity,
            due: anyDue,
          };
          (entry.daysLeft < 0 ? expired : expiring).push(entry);
        }
      }
    }

    const lowStockDue = settings.lowStockEnabled && dayNumber() % repeat === 0;
    // 每次给一份新的名单（调用方可能会排序），名单里的条目是同一批
    const lowStockList = settings.lowStockEnabled ? [...lowStockEntries()] : [];

    expiring.sort((a, b) => a.daysLeft - b.daysLeft);
    expired.sort((a, b) => a.daysLeft - b.daysLeft);

    const due =
      expiring.some((entry) => entry.due) ||
      expired.some((entry) => entry.due) ||
      (lowStockDue && lowStockList.length > 0);

    return { expiring, expired, lowStock: lowStockList, due };
  }

  return { isDue, status };
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
  const planner = createDayPlanner(products, settings);
  const warrantyCheck = createWarrantyCheck(warranties);
  for (let offset = 0; offset <= horizonDays && plan.length < maxCount; offset++) {
    const day = addDays(today, offset);
    const at = dateStrToLocalDate(day, settings.reminderHour, settings.reminderMinute);
    if (at.getTime() <= now.getTime()) continue;
    const dayNumber = lazyDayNumber(day);
    // 先只判断这天要不要发（找到一项就停），要发才拼名单（先拼名单再看保修，和原来逐项算的先后一样）
    const status = planner.isDue(dayNumber) ? planner.status(day, dayNumber) : null;
    // 保修提醒跟着「到期提醒」开关走
    const warrantyNames = settings.expiryEnabled ? warrantyCheck(dayNumber) : [];
    if (!status && !warrantyNames.length) continue;
    const { title, body } = buildMessage(status ?? planner.status(day, dayNumber), warrantyNames);
    plan.push({ day, at, title, body });
  }
  return plan;
}

/**
 * 用 now 排出来的提醒（planReminders、backupReminder.ts 的 planBackupReminders），到哪个时刻之前都不会变（毫秒时间戳）：
 * 这两个计划只跟「今天是哪天」和「各天的提醒时刻过了没有」有关。提醒时刻是正常的时、分时，今天的提醒时刻还没到就是那个时刻，
 * 过了就是明天零点（明天以后的提醒时刻都在明天零点之后）。时、分不正常（导入了坏设置）返回 null，表示别缓存。
 */
export function planUnchangedUntil(now: Date, time: { reminderHour: number; reminderMinute: number }): number | null {
  const { reminderHour: hour, reminderMinute: minute } = time;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const today = todayStr(now);
  const todayAt = dateStrToLocalDate(today, hour, minute).getTime();
  if (todayAt > now.getTime()) return todayAt;
  return dateStrToLocalDate(addDays(today, 1)).getTime();
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
