import type { SQLiteDatabase } from 'expo-sqlite';

import type { ReminderSettings } from '../lib/reminderPlan';

export type AppSettings = ReminderSettings & {
  /** 新建食品 / 日用品时默认的库存下限 */
  defaultLowStockThreshold: number;
  /** 扫到没见过的条码时，是否联网查商品名 */
  onlineLookup: boolean;
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
