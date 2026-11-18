import type { SQLiteDatabase } from 'expo-sqlite';

import { todayStr } from '../lib/dates';
import { planConsumption, roundQty, type StockKind } from '../lib/stock';

export type StockProduct = {
  id: number;
  kind: StockKind;
  barcode: string | null;
  name: string;
  brand: string | null;
  spec: string | null;
  unit: string;
  location: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StockProductSummary = StockProduct & {
  totalQty: number;
  nearestExpiry: string | null;
  batchCount: number;
};

export type StockBatch = {
  id: number;
  productId: number;
  quantity: number;
  expiryDate: string | null;
  addedOn: string;
  note: string | null;
};

export type StockProductInput = {
  kind: StockKind;
  barcode: string | null;
  name: string;
  brand: string | null;
  spec: string | null;
  unit: string;
  location: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  note: string | null;
};

export type BatchInput = {
  quantity: number;
  expiryDate: string | null;
  note?: string | null;
};

const PRODUCT_COLUMNS = `
  p.id, p.kind, p.barcode, p.name, p.brand, p.spec, p.unit, p.location,
  p.low_stock_threshold AS lowStockThreshold,
  p.expiry_lead_days AS expiryLeadDays,
  p.note, p.created_at AS createdAt, p.updated_at AS updatedAt`;

const BATCH_COLUMNS = `
  id, product_id AS productId, quantity, expiry_date AS expiryDate, added_on AS addedOn, note`;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function listProducts(db: SQLiteDatabase, kind?: StockKind): Promise<StockProductSummary[]> {
  const where = kind ? 'WHERE p.kind = ?' : '';
  const params = kind ? [kind] : [];
  return db.getAllAsync<StockProductSummary>(
    `SELECT ${PRODUCT_COLUMNS},
            COALESCE(SUM(b.quantity), 0) AS totalQty,
            MIN(b.expiry_date) AS nearestExpiry,
            COUNT(b.id) AS batchCount
       FROM stock_product p
       LEFT JOIN stock_batch b ON b.product_id = p.id AND b.quantity > 0
       ${where}
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE`,
    params,
  );
}

export async function getProduct(db: SQLiteDatabase, id: number): Promise<StockProduct | null> {
  return db.getFirstAsync<StockProduct>(`SELECT ${PRODUCT_COLUMNS} FROM stock_product p WHERE p.id = ?`, [id]);
}

export async function findProductByBarcode(db: SQLiteDatabase, barcode: string): Promise<StockProduct | null> {
  return db.getFirstAsync<StockProduct>(`SELECT ${PRODUCT_COLUMNS} FROM stock_product p WHERE p.barcode = ?`, [
    barcode.trim(),
  ]);
}

export async function listBatches(db: SQLiteDatabase, productId: number): Promise<StockBatch[]> {
  return db.getAllAsync<StockBatch>(
    `SELECT ${BATCH_COLUMNS} FROM stock_batch
      WHERE product_id = ? AND quantity > 0
      ORDER BY expiry_date IS NULL, expiry_date, id`,
    [productId],
  );
}

export async function listAllBatches(db: SQLiteDatabase): Promise<StockBatch[]> {
  return db.getAllAsync<StockBatch>(`SELECT ${BATCH_COLUMNS} FROM stock_batch WHERE quantity > 0`);
}

function productParams(input: StockProductInput) {
  return [
    input.kind,
    emptyToNull(input.barcode),
    input.name.trim(),
    emptyToNull(input.brand),
    emptyToNull(input.spec),
    input.unit.trim() || '件',
    emptyToNull(input.location),
    input.lowStockThreshold,
    input.expiryLeadDays,
    emptyToNull(input.note),
  ];
}

export async function createProduct(
  db: SQLiteDatabase,
  input: StockProductInput,
  firstBatch: BatchInput | null,
): Promise<number> {
  let productId = 0;
  await db.withTransactionAsync(async () => {
    const now = nowIso();
    const result = await db.runAsync(
      `INSERT INTO stock_product
         (kind, barcode, name, brand, spec, unit, location, low_stock_threshold, expiry_lead_days, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...productParams(input), now, now],
    );
    productId = result.lastInsertRowId;
    if (firstBatch && firstBatch.quantity > 0) {
      await insertBatch(db, productId, firstBatch);
    }
  });
  return productId;
}

export async function updateProduct(db: SQLiteDatabase, id: number, input: StockProductInput): Promise<void> {
  await db.runAsync(
    `UPDATE stock_product
        SET kind = ?, barcode = ?, name = ?, brand = ?, spec = ?, unit = ?, location = ?,
            low_stock_threshold = ?, expiry_lead_days = ?, note = ?, updated_at = ?
      WHERE id = ?`,
    [...productParams(input), nowIso(), id],
  );
}

export async function deleteProduct(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM stock_product WHERE id = ?', [id]);
}

async function insertBatch(db: SQLiteDatabase, productId: number, batch: BatchInput): Promise<void> {
  await db.runAsync(
    'INSERT INTO stock_batch (product_id, quantity, expiry_date, added_on, note) VALUES (?, ?, ?, ?, ?)',
    [productId, roundQty(batch.quantity), batch.expiryDate, todayStr(), emptyToNull(batch.note ?? null)],
  );
}

/** 入库：过期日期相同的批次直接合并数量，否则新开一个批次。 */
export async function stockIn(db: SQLiteDatabase, productId: number, batch: BatchInput): Promise<void> {
  if (!(batch.quantity > 0)) return;
  await db.withTransactionAsync(async () => {
    const existing = await db.getFirstAsync<{ id: number; quantity: number }>(
      `SELECT id, quantity FROM stock_batch
        WHERE product_id = ? AND quantity > 0 AND expiry_date IS ?
        ORDER BY id LIMIT 1`,
      [productId, batch.expiryDate],
    );
    if (existing) {
      await db.runAsync('UPDATE stock_batch SET quantity = ? WHERE id = ?', [
        roundQty(existing.quantity + batch.quantity),
        existing.id,
      ]);
    } else {
      await insertBatch(db, productId, batch);
    }
    await db.runAsync('UPDATE stock_product SET updated_at = ? WHERE id = ?', [nowIso(), productId]);
  });
}

/** 出库：先到期的批次先扣。返回实际扣掉的数量和不够扣的部分。 */
export async function stockOut(
  db: SQLiteDatabase,
  productId: number,
  amount: number,
): Promise<{ consumed: number; shortfall: number }> {
  let outcome = { consumed: 0, shortfall: amount };
  await db.withTransactionAsync(async () => {
    const batches = await listBatches(db, productId);
    const plan = planConsumption(batches, amount);
    for (const update of plan.updates) {
      if (update.quantity <= 0) {
        await db.runAsync('DELETE FROM stock_batch WHERE id = ?', [update.id]);
      } else {
        await db.runAsync('UPDATE stock_batch SET quantity = ? WHERE id = ?', [update.quantity, update.id]);
      }
    }
    await db.runAsync('UPDATE stock_product SET updated_at = ? WHERE id = ?', [nowIso(), productId]);
    outcome = { consumed: plan.consumed, shortfall: plan.shortfall };
  });
  return outcome;
}

export async function updateBatch(db: SQLiteDatabase, batchId: number, batch: BatchInput): Promise<void> {
  if (!(batch.quantity > 0)) {
    await deleteBatch(db, batchId);
    return;
  }
  await db.runAsync('UPDATE stock_batch SET quantity = ?, expiry_date = ? WHERE id = ?', [
    roundQty(batch.quantity),
    batch.expiryDate,
    batchId,
  ]);
}

export async function deleteBatch(db: SQLiteDatabase, batchId: number): Promise<void> {
  await db.runAsync('DELETE FROM stock_batch WHERE id = ?', [batchId]);
}

export async function listLocations(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ location: string }>(
    `SELECT location FROM stock_product WHERE location IS NOT NULL
      GROUP BY location ORDER BY MAX(updated_at) DESC LIMIT 12`,
  );
  return rows.map((row) => row.location);
}
