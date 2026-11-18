import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'item-keeper.db';
const DATABASE_VERSION = 1;

/**
 * 表结构
 * - stock_product：食品 / 日用品（kind 区分），一个条码对应一个商品
 * - stock_batch：同一商品不同批次（各自的数量和过期日期）
 * - device / device_assignment：设备及每次领用、退还记录
 * - setting：键值设置
 */
export async function migrateDbIfNeeded(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = row?.user_version ?? 0;
  if (currentVersion >= DATABASE_VERSION) return;

  if (currentVersion === 0) {
    await db.execAsync(`
      CREATE TABLE stock_product (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('food', 'daily')),
        barcode TEXT,
        name TEXT NOT NULL,
        brand TEXT,
        spec TEXT,
        unit TEXT NOT NULL DEFAULT '件',
        location TEXT,
        low_stock_threshold REAL,
        expiry_lead_days INTEGER,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ux_stock_product_barcode ON stock_product(barcode) WHERE barcode IS NOT NULL;
      CREATE INDEX ix_stock_product_kind ON stock_product(kind);

      CREATE TABLE stock_batch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES stock_product(id) ON DELETE CASCADE,
        quantity REAL NOT NULL,
        expiry_date TEXT,
        added_on TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX ix_stock_batch_product ON stock_batch(product_id);

      CREATE TABLE device (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        model TEXT,
        serial_no TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE device_assignment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        person TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        issued_on TEXT NOT NULL,
        returned_on TEXT,
        note TEXT
      );
      CREATE INDEX ix_device_assignment_device ON device_assignment(device_id);

      CREATE TABLE setting (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}
