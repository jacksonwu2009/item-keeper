/**
 * 家庭、办公两个场景的提醒合到一起发：同一时刻合成一条加前缀，时间不同各发各的，只有一边有不加前缀。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKUP_REMINDER_SLOTS_PER_SCENE, backupStatus, planBackupReminders } from '../src/lib/backupReminder';
import {
  ITEM_REMINDER_SLOTS_PER_SCENE,
  mergeScenePlans,
  planReminders,
  type PlannedReminder,
  type PlanProduct,
  type ReminderSettings,
} from '../src/lib/reminderPlan';

function reminder(day: string, hour: number, title: string, body: string): PlannedReminder {
  const [year, month, date] = day.split('-').map(Number);
  return { day, at: new Date(year, month - 1, date, hour, 0), title, body };
}

describe('两个场景的提醒合到一起', () => {
  it('同一天同一时刻都有：合成一条，标题、正文里分别用「家里：」「公司：」开头，家里的在前', () => {
    const merged = mergeScenePlans([
      { scene: 'office', items: [reminder('2026-11-24', 9, '1 样库存不足', '库存不足：纸巾（剩 1 包）')], backup: [] },
      { scene: 'home', items: [reminder('2026-11-24', 9, '2 样快到期', '牛奶 还剩 2 天；面包 明天到期')], backup: [] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, '家里：2 样快到期；公司：1 样库存不足');
    assert.equal(merged[0].body, '家里：牛奶 还剩 2 天；面包 明天到期\n公司：库存不足：纸巾（剩 1 包）');
    assert.equal(merged[0].day, '2026-11-24');
    assert.equal(merged[0].at.getHours(), 9);
  });

  it('时间不同各发各的，不加前缀；按时间排好', () => {
    const merged = mergeScenePlans([
      { scene: 'home', items: [reminder('2026-11-24', 20, '1 样已过期', '酸奶 已过期 1 天')], backup: [] },
      { scene: 'office', items: [reminder('2026-11-24', 9, '1 样库存不足', '库存不足：纸巾（剩 1 包）')], backup: [] },
    ]);
    assert.deepEqual(
      merged.map((item) => [item.at.getHours(), item.title]),
      [
        [9, '1 样库存不足'],
        [20, '1 样已过期'],
      ],
    );
  });

  it('只有一个场景有东西：原样，不加前缀（和只用一个场景时一样，物品提醒、备份提醒各一条）', () => {
    const items = [reminder('2026-11-24', 9, '1 样快到期', '牛奶 明天到期'), reminder('2026-11-25', 9, '1 样快到期', '牛奶 今天到期')];
    const backup = [reminder('2026-11-24', 9, '该备份了', '已经 60 天没导出备份了。')];
    const merged = mergeScenePlans([
      { scene: 'office', items, backup },
      { scene: 'home', items: [], backup: [] },
    ]);
    assert.deepEqual(
      merged.map((item) => [item.day, item.title]),
      [
        ['2026-11-24', '1 样快到期'],
        ['2026-11-24', '该备份了'],
        ['2026-11-25', '1 样快到期'],
      ],
    );
  });

  it('同一时刻：物品提醒合成一条、备份提醒合成一条；只有一边有的那类也加前缀', () => {
    const merged = mergeScenePlans([
      {
        scene: 'home',
        items: [reminder('2026-11-24', 9, '1 样快到期', '牛奶 明天到期')],
        backup: [reminder('2026-11-24', 9, '该备份了', '已经 60 天没导出备份了。')],
      },
      {
        scene: 'office',
        items: [reminder('2026-11-24', 9, '2 样库存不足', '库存不足：纸巾、笔')],
        backup: [],
      },
    ]);
    assert.deepEqual(
      merged.map((item) => item.title),
      ['家里：1 样快到期；公司：2 样库存不足', '家里：该备份了'],
    );
    assert.equal(merged[1].body, '家里：已经 60 天没导出备份了。');
  });

  it('两个场景的备份提醒同一时刻也合成一条', () => {
    const merged = mergeScenePlans([
      { scene: 'home', items: [], backup: [reminder('2026-12-01', 9, '该备份了', '家里的话')] },
      { scene: 'office', items: [], backup: [reminder('2026-12-01', 9, '该备份了', '公司的话')] },
    ]);
    assert.deepEqual(merged.map((item) => [item.title, item.body]), [['家里：该备份了；公司：该备份了', '家里：家里的话\n公司：公司的话']]);
  });

  it('只读到一个场景（另一个库读不出来）时照常发', () => {
    const items = [reminder('2026-11-24', 9, '1 样快到期', '牛奶 明天到期')];
    assert.deepEqual(mergeScenePlans([{ scene: 'home', items, backup: [] }]), items);
  });

  it('通知条数按场景平分：每个场景物品 28 条、备份 2 条，合起来不超过 60', () => {
    assert.equal(ITEM_REMINDER_SLOTS_PER_SCENE, 28);
    assert.equal(BACKUP_REMINDER_SLOTS_PER_SCENE, 2);
    const settings: ReminderSettings = {
      expiryEnabled: true,
      lowStockEnabled: true,
      expiryLeadDays: 7,
      repeatEveryDays: 1,
      reminderHour: 9,
      reminderMinute: 0,
    };
    const lowStock: PlanProduct = { name: '纸巾', unit: '包', totalQty: 0, lowStockThreshold: 1, expiryLeadDays: null, batches: [] };
    const now = new Date(2026, 10, 23, 8, 0);
    const status = backupStatus({ lastExportAt: null, dataSince: '2026-01-01T00:00:00.000Z', reminderDays: 60, now });
    const plan = (hour: number) => {
      const timed = { ...settings, reminderHour: hour };
      return {
        items: planReminders([lowStock], timed, now, 60, ITEM_REMINDER_SLOTS_PER_SCENE),
        backup: planBackupReminders(status, timed, now, BACKUP_REMINDER_SLOTS_PER_SCENE),
      };
    };
    const home = plan(9);
    const office = plan(10);
    assert.equal(home.items.length, 28);
    assert.equal(home.backup.length, 2);
    // 时间不同：一条都不合，正好 60 条
    assert.equal(mergeScenePlans([{ scene: 'home', ...home }, { scene: 'office', ...office }]).length, 60);
    // 时间一样：每天合成一条
    const sameTime = mergeScenePlans([{ scene: 'home', ...home }, { scene: 'office', ...plan(9) }]);
    assert.equal(sameTime.length, 30);
    assert.match(sameTime[0].title, /^家里：.*；公司：/);
  });
});
