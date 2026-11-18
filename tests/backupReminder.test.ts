import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_SCOPES } from '../src/lib/backup';
import {
  backupMessage,
  backupStatus,
  countsAsBackup,
  FULL_BACKUP_SCOPE,
  planBackupReminders,
} from '../src/lib/backupReminder';

/** 本地时间 */
function at(year: number, month: number, day: number, hour = 10, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

const time = { reminderHour: 9, reminderMinute: 0 };

describe('备份提醒', () => {
  it('分类、办公点都全选才算备份', () => {
    assert.deepEqual([...FULL_BACKUP_SCOPE], ALL_SCOPES);
    assert.equal(countsAsBackup(['food', 'daily', 'devices', 'settings'], true), true);
    // 只导出一部分办公点（汇总手机只导出北京）不算
    assert.equal(countsAsBackup(['food', 'daily', 'devices', 'settings'], false), false);
    assert.equal(countsAsBackup(['food', 'daily', 'devices'], true), false);
    assert.equal(countsAsBackup(['food', 'settings'], true), false);
  });

  it('上次导出后满 60 天提醒，按本地日期算', () => {
    const lastExportAt = at(2026, 9, 1, 23, 30).toISOString();
    const before = backupStatus({ lastExportAt, dataSince: null, reminderDays: 60, now: at(2026, 10, 30) });
    assert.deepEqual(before && [before.daysSince, before.dueDay, before.due], [59, '2026-10-31', false]);
    const due = backupStatus({ lastExportAt, dataSince: null, reminderDays: 60, now: at(2026, 10, 31) });
    assert.deepEqual(due && [due.daysSince, due.due, due.lastExportDay], [60, true, '2026-09-01']);
    assert.equal(due && backupMessage(due), '已经 60 天没导出备份了');
  });

  it('没导出过从最早录入那天算；没数据、设成 0 不提醒', () => {
    const status = backupStatus({
      lastExportAt: null,
      dataSince: at(2026, 9, 1).toISOString(),
      reminderDays: 60,
      now: at(2026, 11, 18),
    });
    assert.deepEqual(status && [status.lastExportDay, status.daysSince, status.due], [null, 78, true]);
    assert.equal(status && backupMessage(status), '数据已经记了 78 天，还没导出过备份');
    assert.equal(backupStatus({ lastExportAt: null, dataSince: null, reminderDays: 60, now: at(2026, 11, 18) }), null);
    assert.equal(
      backupStatus({ lastExportAt: null, dataSince: at(2026, 1, 1).toISOString(), reminderDays: 0, now: at(2026, 11, 18) }),
      null,
    );
  });

  it('通知：还没到日子从那天起，每 7 天一条，最多 4 条', () => {
    const status = backupStatus({
      lastExportAt: at(2026, 11, 1).toISOString(),
      dataSince: null,
      reminderDays: 60,
      now: at(2026, 11, 18),
    });
    const plan = planBackupReminders(status, time, at(2026, 11, 18));
    assert.deepEqual(
      plan.map((item) => item.day),
      ['2026-12-31', '2027-01-07', '2027-01-14', '2027-01-21'],
    );
    assert.equal(plan[0].at.getHours(), 9);
    assert.match(plan[0].body, /已经 60 天没导出备份了/);
    assert.match(plan[1].body, /已经 67 天/);
  });

  it('通知：已经过了日子，今天提醒时间没过就今天，过了就明天', () => {
    const status = backupStatus({
      lastExportAt: at(2026, 9, 1).toISOString(),
      dataSince: null,
      reminderDays: 60,
      now: at(2026, 11, 18, 8),
    });
    assert.equal(planBackupReminders(status, time, at(2026, 11, 18, 8))[0].day, '2026-11-18');
    assert.equal(planBackupReminders(status, time, at(2026, 11, 18, 10))[0].day, '2026-11-19');
    assert.deepEqual(planBackupReminders(null, time, at(2026, 11, 18)), []);
  });
});
