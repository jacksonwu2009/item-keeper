import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'item-keeper.db';
const DATABASE_VERSION = 6;

/**
 * 表结构
 * - stock_product：食品 / 日用品（kind 区分），一个条码对应一个商品
 * - stock_batch：同一商品不同批次（各自的数量和过期日期）
 * - device / device_assignment：设备及每次领用、退还记录
 * - stock_movement：出入库流水（v2 起）
 * - stock_pack：包装规格，如「1 箱 = 24 瓶」，可带自己的条码（v3 起）
 * - device.purchase_date / warranty_until、device_accessory：设备购买日期、保修到期日、随设备的配件（v4 起）
 * - office：办公点；stock_product、device 各有 office_id，条码只在同一办公点内不重复（v5 起）
 * - stock_movement.unit_price / total_price：入库时填的单价（按入库单位）和总价，可不填；device.invoice_no：发票号（v6 起）
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

  if (currentVersion < 2) {
    // delta：入库为正、出库为负；调整（改批次数量、删批次）按实际变化记正负
    await db.execAsync(`
      CREATE TABLE stock_movement (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES stock_product(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('in', 'out', 'adjust')),
        delta REAL NOT NULL,
        expiry_date TEXT,
        happened_at TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX ix_stock_movement_product ON stock_movement(product_id, happened_at);
    `);
  }

  if (currentVersion < 3) {
    // 库存一律按 stock_product.unit（最小单位）记；包装规格只用于入库出库时换算和显示。
    // stock_movement 记下当时输入的数量和单位（如「2 箱」），delta 仍是最小单位。
    await db.execAsync(`
      CREATE TABLE stock_pack (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES stock_product(id) ON DELETE CASCADE,
        unit TEXT NOT NULL,
        size REAL NOT NULL CHECK (size > 0),
        barcode TEXT,
        sort INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX ix_stock_pack_product ON stock_pack(product_id);
      CREATE UNIQUE INDEX ux_stock_pack_barcode ON stock_pack(barcode) WHERE barcode IS NOT NULL;
      ALTER TABLE stock_movement ADD COLUMN input_qty REAL;
      ALTER TABLE stock_movement ADD COLUMN input_unit TEXT;
    `);
  }

  if (currentVersion < 4) {
    // 配件数量按「每件设备配几个」记；整机领用、退还时一起走
    await db.execAsync(`
      ALTER TABLE device ADD COLUMN purchase_date TEXT;
      ALTER TABLE device ADD COLUMN warranty_until TEXT;
      CREATE TABLE device_accessory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
        sort INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX ix_device_accessory_device ON device_accessory(device_id);
    `);
  }

  if (currentVersion < 5) {
    // 已有数据全部归到 1 号「默认办公点」，用户可以改名。
    // office_id 不加 REFERENCES：SQLite 在开着外键时不允许给已有表加带非空默认值的外键列，删办公点前由应用检查是否为空。
    // 包装条码原来全局唯一，改成普通索引，唯一性由应用按办公点检查。
    await db.execAsync(`
      CREATE TABLE office (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO office (id, name, sort, created_at)
        VALUES (1, '默认办公点', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      ALTER TABLE stock_product ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE device ADD COLUMN office_id INTEGER NOT NULL DEFAULT 1;
      DROP INDEX IF EXISTS ux_stock_product_barcode;
      CREATE UNIQUE INDEX ux_stock_product_office_barcode ON stock_product(office_id, barcode) WHERE barcode IS NOT NULL;
      CREATE INDEX ix_stock_product_office ON stock_product(office_id, kind);
      DROP INDEX IF EXISTS ux_stock_pack_barcode;
      CREATE INDEX ix_stock_pack_barcode ON stock_pack(barcode);
      CREATE INDEX ix_device_office ON device(office_id);
    `);
  }

  if (currentVersion < 6) {
    await db.execAsync(`
      ALTER TABLE stock_movement ADD COLUMN unit_price REAL;
      ALTER TABLE stock_movement ADD COLUMN total_price REAL;
      ALTER TABLE device ADD COLUMN invoice_no TEXT;
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}
