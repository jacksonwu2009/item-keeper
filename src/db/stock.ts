import type { SQLiteDatabase } from 'expo-sqlite';

import { todayStr } from '../lib/dates';
import type { PackUnit } from '../lib/packs';
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

export type MovementType = 'in' | 'out' | 'adjust';

export type StockMovement = {
  id: number;
  productId: number;
  type: MovementType;
  /** 入库为正、出库为负 */
  delta: number;
  expiryDate: string | null;
  happenedAt: string;
  note: string | null;
  /** 当时输入的数量和单位，如 2 箱；按最小单位输入时与 delta 相同 */
  inputQty: number | null;
  inputUnit: string | null;
};

/** 用户输入时用的数量和单位，记进流水里方便以后看「当时是按箱进的」。 */
export type EntryQty = { qty: number; unit: string };

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
  /** 包装规格（如 1 箱 = 24 瓶）。库存按 unit（最小单位）记。 */
  packs: PackUnit[];
};

export type BatchInput = {
  /** 最小单位的数量 */
  quantity: number;
  expiryDate: string | null;
  note?: string | null;
  entry?: EntryQty | null;
};

export type BarcodeMatch = { product: StockProduct; pack: PackUnit | null };

const PRODUCT_COLUMNS = `
  p.id, p.kind, p.barcode, p.name, p.brand, p.spec, p.unit, p.location,
  p.low_stock_threshold AS lowStockThreshold,
  p.expiry_lead_days AS expiryLeadDays,
  p.note, p.created_at AS createdAt, p.updated_at AS updatedAt`;

const BATCH_COLUMNS = `
  id, product_id AS productId, quantity, expiry_date AS expiryDate, added_on AS addedOn, note`;

const MOVEMENT_COLUMNS = `
  id, product_id AS productId, type, delta, expiry_date AS expiryDate, happened_at AS happenedAt, note,
  input_qty AS inputQty, input_unit AS inputUnit`;

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

/** 按条码找物品：先找物品本身的条码，再找包装（整箱、整包）的条码。 */
export async function findByBarcode(db: SQLiteDatabase, barcode: string): Promise<BarcodeMatch | null> {
  const code = barcode.trim();
  if (!code) return null;
  const product = await findProductByBarcode(db, code);
  if (product) return { product, pack: null };
  const pack = await db.getFirstAsync<PackUnit & { productId: number }>(
    'SELECT product_id AS productId, unit, size, barcode FROM stock_pack WHERE barcode = ?',
    [code],
  );
  if (!pack) return null;
  const owner = await getProduct(db, pack.productId);
  return owner ? { product: owner, pack: { unit: pack.unit, size: pack.size, barcode: pack.barcode } } : null;
}

/** 物品条码和包装条码都不能和别的物品撞；撞了抛出给用户看的错误。 */
async function assertBarcodesFree(db: SQLiteDatabase, input: StockProductInput, selfId: number | null): Promise<void> {
  const own = [input.barcode, ...input.packs.map((pack) => pack.barcode)]
    .map((code) => code?.trim())
    .filter((code): code is string => !!code);
  if (new Set(own).size !== own.length) throw new Error('物品条码和包装条码不能相同');
  for (const code of own) {
    const match = await findByBarcode(db, code);
    if (match && match.product.id !== selfId) {
      throw new Error(`条码 ${code} 已经给「${match.product.name}」${match.pack ? `的${match.pack.unit}` : ''}用了`);
    }
  }
}

export async function listPacks(db: SQLiteDatabase, productId: number): Promise<PackUnit[]> {
  return db.getAllAsync<PackUnit>('SELECT unit, size, barcode FROM stock_pack WHERE product_id = ? ORDER BY sort, id', [
    productId,
  ]);
}

export async function listAllPacks(db: SQLiteDatabase): Promise<(PackUnit & { productId: number })[]> {
  return db.getAllAsync<PackUnit & { productId: number }>(
    'SELECT product_id AS productId, unit, size, barcode FROM stock_pack ORDER BY product_id, sort, id',
  );
}

async function savePacks(db: SQLiteDatabase, productId: number, packs: PackUnit[]): Promise<void> {
  await db.runAsync('DELETE FROM stock_pack WHERE product_id = ?', [productId]);
  let sort = 0;
  for (const pack of packs) {
    await db.runAsync('INSERT INTO stock_pack (product_id, unit, size, barcode, sort) VALUES (?, ?, ?, ?, ?)', [
      productId,
      pack.unit.trim(),
      pack.size,
      emptyToNull(pack.barcode),
      sort++,
    ]);
  }
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
  await assertBarcodesFree(db, input, null);
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
    await savePacks(db, productId, input.packs);
    if (firstBatch && firstBatch.quantity > 0) {
      await insertBatch(db, productId, firstBatch);
      await recordMovement(db, productId, 'in', firstBatch.quantity, firstBatch.expiryDate, firstBatch.note ?? null, firstBatch.entry);
    }
  });
  return productId;
}

export async function updateProduct(db: SQLiteDatabase, id: number, input: StockProductInput): Promise<void> {
  await assertBarcodesFree(db, input, id);
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE stock_product
          SET kind = ?, barcode = ?, name = ?, brand = ?, spec = ?, unit = ?, location = ?,
              low_stock_threshold = ?, expiry_lead_days = ?, note = ?, updated_at = ?
        WHERE id = ?`,
      [...productParams(input), nowIso(), id],
    );
    await savePacks(db, id, input.packs);
  });
}

export async function deleteProduct(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM stock_product WHERE id = ?', [id]);
}

async function recordMovement(
  db: SQLiteDatabase,
  productId: number,
  type: MovementType,
  delta: number,
  expiryDate: string | null,
  note: string | null,
  entry: EntryQty | null = null,
): Promise<void> {
  if (roundQty(delta) === 0 && type !== 'adjust') return;
  await db.runAsync(
    `INSERT INTO stock_movement (product_id, type, delta, expiry_date, happened_at, note, input_qty, input_unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [productId, type, roundQty(delta), expiryDate, nowIso(), emptyToNull(note), entry ? roundQty(entry.qty) : null, entry?.unit ?? null],
  );
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
    await recordMovement(db, productId, 'in', batch.quantity, batch.expiryDate, batch.note ?? null, batch.entry);
    await db.runAsync('UPDATE stock_product SET updated_at = ? WHERE id = ?', [nowIso(), productId]);
  });
}

/** 出库：先到期的批次先扣。返回实际扣掉的数量和不够扣的部分。note 是出库原因（用掉、过期丢弃……）。 */
export async function stockOut(
  db: SQLiteDatabase,
  productId: number,
  amount: number,
  note: string | null = null,
  entry: EntryQty | null = null,
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
    // 不够扣时只按实际扣掉的最小单位记，不再记当时输入的「1 箱」
    if (plan.consumed > 0) {
      await recordMovement(db, productId, 'out', -plan.consumed, null, note, plan.shortfall > 0 ? null : entry);
    }
    await db.runAsync('UPDATE stock_product SET updated_at = ? WHERE id = ?', [nowIso(), productId]);
    outcome = { consumed: plan.consumed, shortfall: plan.shortfall };
  });
  return outcome;
}

async function getBatch(db: SQLiteDatabase, batchId: number): Promise<StockBatch | null> {
  return db.getFirstAsync<StockBatch>(`SELECT ${BATCH_COLUMNS} FROM stock_batch WHERE id = ?`, [batchId]);
}

/** 手动调整某一批的数量或过期日期，记一条「调整」流水。数量改成 0 等于删除。 */
export async function updateBatch(db: SQLiteDatabase, batchId: number, batch: BatchInput): Promise<void> {
  if (!(batch.quantity > 0)) {
    await deleteBatch(db, batchId);
    return;
  }
  await db.withTransactionAsync(async () => {
    const before = await getBatch(db, batchId);
    if (!before) return;
    const quantity = roundQty(batch.quantity);
    await db.runAsync('UPDATE stock_batch SET quantity = ?, expiry_date = ? WHERE id = ?', [
      quantity,
      batch.expiryDate,
      batchId,
    ]);
    const changes: string[] = [];
    if (quantity !== before.quantity) changes.push(`数量 ${before.quantity} → ${quantity}`);
    if (batch.expiryDate !== before.expiryDate) {
      changes.push(`过期日期 ${before.expiryDate ?? '无'} → ${batch.expiryDate ?? '无'}`);
    }
    if (changes.length) {
      await recordMovement(db, before.productId, 'adjust', quantity - before.quantity, batch.expiryDate, changes.join('，'));
    }
  });
}

export async function deleteBatch(db: SQLiteDatabase, batchId: number): Promise<void> {
  await db.withTransactionAsync(async () => {
    const before = await getBatch(db, batchId);
    if (!before) return;
    await db.runAsync('DELETE FROM stock_batch WHERE id = ?', [batchId]);
    await recordMovement(db, before.productId, 'adjust', -before.quantity, before.expiryDate, '删除这一批');
  });
}

export async function listMovements(db: SQLiteDatabase, productId: number, limit = 50): Promise<StockMovement[]> {
  return db.getAllAsync<StockMovement>(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_movement WHERE product_id = ? ORDER BY happened_at DESC, id DESC LIMIT ?`,
    [productId, limit],
  );
}

export async function listLocations(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ location: string }>(
    `SELECT location FROM stock_product WHERE location IS NOT NULL
      GROUP BY location ORDER BY MAX(updated_at) DESC LIMIT 12`,
  );
  return rows.map((row) => row.location);
}
