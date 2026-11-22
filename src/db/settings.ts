import type { SQLiteDatabase } from 'expo-sqlite';

import { DEFAULT_BACKUP_REMINDER_DAYS } from '../lib/backupReminder';
import type { ReminderSettings } from '../lib/reminderPlan';
import { isScene, placeToRenameForHome, termsFor, type Scene } from '../lib/terms';

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

/**
 * 使用场景（家庭 / 办公）：只决定界面上的叫法（lib/terms.ts）。没选过返回 null（新装的手机，打开时让用户选）。
 * 不放进 AppSettings：AppSettings 每项都有默认值，分不出「没选过」；备份时单独写 scene 字段（lib/backup.ts）。
 */
const SCENE_KEY = 'usage.scene';

export async function getScene(db: SQLiteDatabase): Promise<Scene | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM setting WHERE key = ?', [SCENE_KEY]);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return isScene(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写场景，不开事务（导入备份时在导入的事务里调）。
 * renameDefaultPlace：切到家庭时，名字还是「默认办公点」的地点改叫「家」（已经有「家」就不改）；撤销导入时不改名，原样还原。
 */
export async function writeScene(db: SQLiteDatabase, scene: Scene, renameDefaultPlace = true): Promise<void> {
  await db.runAsync(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [SCENE_KEY, JSON.stringify(scene)],
  );
  if (scene !== 'home' || !renameDefaultPlace) return;
  const names = (await db.getAllAsync<{ name: string }>('SELECT name FROM office')).map((row) => row.name);
  const from = placeToRenameForHome(names);
  if (from) await db.runAsync('UPDATE office SET name = ? WHERE name = ?', [termsFor('home').defaultPlaceName, from]);
}

export async function saveScene(db: SQLiteDatabase, scene: Scene): Promise<void> {
  await db.withTransactionAsync(() => writeScene(db, scene));
}
