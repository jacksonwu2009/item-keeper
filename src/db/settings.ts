import type { SQLiteDatabase } from 'expo-sqlite';

import { DEFAULT_BACKUP_REMINDER_DAYS } from '../lib/backupReminder';
import type { ReminderSettings } from '../lib/reminderPlan';

export type AppSettings = ReminderSettings & {
  /** 新建食品 / 日用品时默认的库存下限 */
  defaultLowStockThreshold: number;
  /** 扫到没见过的条码时，是否联网查商品名 */
  onlineLookup: boolean;
  /** 超过几天没导出备份就提醒；0 = 不提醒 */
  backupReminderDays: number;
};

export const DEFAULT_SETTINGS: AppSettings = {
  expiryEnabled: true,
  lowStockEnabled: true,
  expiryLeadDays: 7,
  repeatEveryDays: 1,
  reminderHour: 9,
  reminderMinute: 0,
  defaultLowStockThreshold: 1,
  onlineLookup: true,
  backupReminderDays: DEFAULT_BACKUP_REMINDER_DAYS,
};

export async function getSettings(db: SQLiteDatabase): Promise<AppSettings> {
  const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM setting');
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue;
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (typeof parsed === typeof DEFAULT_SETTINGS[row.key as keyof AppSettings]) merged[row.key] = parsed;
    } catch {
      // 坏值直接忽略，用默认值
    }
  }
  return merged as AppSettings;
}

export async function saveSettings(db: SQLiteDatabase, patch: Partial<AppSettings>): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      await db.runAsync(
        'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)],
      );
    }
  });
}

/**
 * 上次完整导出备份的时间（ISO）。这是这台手机自己的状态，不放进 AppSettings，
 * 所以不会随备份文件导出，导入别人的设置也不会改它。
 */
const LAST_EXPORT_KEY = 'backup.lastExportAt';

export async function getLastExportAt(db: SQLiteDatabase): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM setting WHERE key = ?', [LAST_EXPORT_KEY]);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export async function setLastExportAt(db: SQLiteDatabase, iso: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [LAST_EXPORT_KEY, JSON.stringify(iso)],
  );
}

/** 手机上最早录入的物品或设备的时间；什么都没有返回 null。从没导出过时，备份提醒从这天算起。 */
export async function getDataSince(db: SQLiteDatabase): Promise<string | null> {
  const row = await db.getFirstAsync<{ since: string | null }>(
    `SELECT MIN(created_at) AS since FROM (
       SELECT created_at FROM stock_product UNION ALL SELECT created_at FROM device
     )`,
  );
  return row?.since ?? null;
}
