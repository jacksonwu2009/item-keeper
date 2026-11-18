/**
 * 备份提醒：超过 N 天没导出备份就提醒。纯函数，有单测。
 * - 「备份过」指用「导出全部」导出：分类、办公点都全选，手机上的东西一样不落。
 * - 从没导出过的，从最早录入东西的那天算起；手机上什么都没有就不提醒。
 * - 到了日子在提醒页显示，并在提醒时间发通知；没导出就每 7 天再提醒一次（最多先排 4 条）。
 */

// 只引类型：backup → db/settings → 这里，引值会绕成循环依赖
import type { BackupScope } from './backup';
import { addDays, dateStrToLocalDate, diffDays, toDateStr, todayStr } from './dates';
import type { PlannedReminder } from './reminderPlan';

export const DEFAULT_BACKUP_REMINDER_DAYS = 60;
export const BACKUP_REPEAT_DAYS = 7;
/** iOS 每个 App 最多挂 64 条本地通知：到期提醒用 56 条，备份提醒留 4 条 */
export const BACKUP_REMINDER_SLOTS = 4;

/** 全部分类，和 backup.ts 的 ALL_SCOPES 一致（单测里核对） */
export const FULL_BACKUP_SCOPE: readonly BackupScope[] = ['food', 'daily', 'devices', 'settings'];

/** 这次导出算不算一次完整备份：分类全选，办公点也全选（allOffices） */
export function countsAsBackup(scope: readonly BackupScope[], allOffices: boolean): boolean {
  return allOffices && FULL_BACKUP_SCOPE.every((item) => scope.includes(item));
}

export type BackupStatus = {
  /** 上次导出那天；没导出过为 null */
  lastExportDay: string | null;
  /** 从哪天算起（上次导出那天，或最早录入那天） */
  sinceDay: string;
  /** 到今天过了几天 */
  daysSince: number;
  /** 哪天开始提醒 */
  dueDay: string;
  /** 今天该提醒了 */
  due: boolean;
};

/**
 * reminderDays 为 0 表示不提醒，返回 null；手机上没有数据、也没导出过，返回 null。
 * lastExportAt、dataSince 是 ISO 时间，按手机本地日期算天数。
 */
export function backupStatus(input: {
  lastExportAt: string | null;
  dataSince: string | null;
  reminderDays: number;
  now: Date;
}): BackupStatus | null {
  if (!(input.reminderDays > 0)) return null;
  const sinceIso = input.lastExportAt ?? input.dataSince;
  if (!sinceIso) return null;
  const sinceDate = new Date(sinceIso);
  if (Number.isNaN(sinceDate.getTime())) return null;
  const sinceDay = toDateStr(sinceDate);
  const today = todayStr(input.now);
  const dueDay = addDays(sinceDay, input.reminderDays);
  return {
    lastExportDay: input.lastExportAt ? sinceDay : null,
    sinceDay,
    daysSince: Math.max(0, diffDays(today, sinceDay)),
    dueDay,
    due: diffDays(today, dueDay) >= 0,
  };
}

/** 提醒页和通知里的那句话 */
export function backupMessage(status: Pick<BackupStatus, 'lastExportDay' | 'daysSince'>): string {
  return status.lastExportDay
    ? `已经 ${status.daysSince} 天没导出备份了`
    : `数据已经记了 ${status.daysSince} 天，还没导出过备份`;
}

/** 排通知：从该提醒的那天（已经过了就从今天或明天）起，每 7 天一条，最多 maxCount 条。 */
export function planBackupReminders(
  status: BackupStatus | null,
  reminderTime: { reminderHour: number; reminderMinute: number },
  now: Date,
  maxCount = BACKUP_REMINDER_SLOTS,
): PlannedReminder[] {
  if (!status) return [];
  const today = todayStr(now);
  let day = diffDays(status.dueDay, today) > 0 ? status.dueDay : today;
  const plan: PlannedReminder[] = [];
  // 今天的提醒时间已经过了就从明天开始，之后按 7 天的节奏
  for (let guard = 0; plan.length < maxCount && guard < maxCount + 2; guard++) {
    const at = dateStrToLocalDate(day, reminderTime.reminderHour, reminderTime.reminderMinute);
    if (at.getTime() > now.getTime()) {
      const daysSince = diffDays(day, status.sinceDay);
      plan.push({
        day,
        at,
        title: '该备份了',
        body: `${backupMessage({ lastExportDay: status.lastExportDay, daysSince })}。打开物品管家，在「设置 → 导入导出」导出一份存好。`,
      });
      day = addDays(day, BACKUP_REPEAT_DAYS);
    } else {
      day = addDays(day, 1);
    }
  }
  return plan;
}
