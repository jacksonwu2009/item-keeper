import type { SQLiteDatabase } from 'expo-sqlite';

import { isProductBarcode, PRODUCT_BARCODE_ERROR } from '../lib/barcode';
import { todayStr, type ShelfLife, type ShelfLifeUnit } from '../lib/dates';
import type { PackUnit } from '../lib/packs';
import { perBaseUnitPrice, roundTotalPrice, roundUnitPrice, type EntryPrice } from '../lib/price';
import { allocationError, planAllocatedConsumption, roundQty, type BatchAllocation, type StockKind } from '../lib/stock';

export type StockProduct = {
  id: number;
  officeId: number;
  kind: StockKind;
  barcode: string | null;
  name: string;
  /** 分类（固定选项见 lib/categories.ts），没选是 null */
  category: string | null;
  spec: string | null;
  unit: string;
  location: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  /** 保质期（如 12 个月），没填是 null；数量和单位要么都有要么都没有 */
  shelfLifeAmount: number | null;
  shelfLifeUnit: ShelfLifeUnit | null;
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
  /** 入库时填的生产日期：按「生产日期+保质期」填才有，别的填法、出库、调整、老记录是 null */
  productionDate: string | null;
  happenedAt: string;
  note: string | null;
  /** 当时输入的数量和单位，如 2 箱；按最小单位输入时与 delta 相同 */
  inputQty: number | null;
  inputUnit: string | null;
  /** 入库时填的单价（按 inputUnit 计，没有 inputUnit 时按最小单位）和总价；没填为 null */
  unitPrice: number | null;
  totalPrice: number | null;
};

/** 用户输入时用的数量和单位，记进流水里方便以后看「当时是按箱进的」。 */
export type EntryQty = { qty: number; unit: string };

export type StockProductInput = {
  officeId: number;
  kind: StockKind;
  barcode: string | null;
  name: string;
  /** 分类，没选是 null */
  category: string | null;
  spec: string | null;
  unit: string;
  location: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  note: string | null;
  /** 包装规格（如 1 箱 = 24 瓶）。库存按 unit（最小单位）记。 */
  packs: PackUnit[];
  /** 保质期；不给（undefined）时改资料不动原来的，给 null 是清空 */
  shelfLife?: ShelfLife | null;
};

export type BatchInput = {
  /** 最小单位的数量 */
  quantity: number;
  expiryDate: string | null;
  note?: string | null;
  entry?: EntryQty | null;
  /** 入库价格，可不填 */
  price?: EntryPrice | null;
  /** 入库：按「生产日期+保质期」填时的保质期。商品资料里还没记保质期就记进去，下次入库默认用这种填法 */
  shelfLife?: ShelfLife | null;
  /** 入库：按「生产日期+保质期」填时的生产日期，记在入库记录上，下次入库能点「同上次」 */
  productionDate?: string | null;
};

export type BarcodeMatch = { product: StockProduct; pack: PackUnit | null };

const PRODUCT_COLUMNS = `
  p.id, p.office_id AS officeId, p.kind, p.barcode, p.name, p.category, p.spec, p.unit, p.location,
  p.low_stock_threshold AS lowStockThreshold,
  p.expiry_lead_days AS expiryLeadDays,
  p.shelf_life_amount AS shelfLifeAmount, p.shelf_life_unit AS shelfLifeUnit,
  p.note, p.created_at AS createdAt, p.updated_at AS updatedAt`;

const BATCH_COLUMNS = `
  id, product_id AS productId, quantity, expiry_date AS expiryDate, added_on AS addedOn, note`;

const MOVEMENT_COLUMNS = `
  id, product_id AS productId, type, delta, expiry_date AS expiryDate, production_date AS productionDate,
  happened_at AS happenedAt, note,
  input_qty AS inputQty, input_unit AS inputUnit, unit_price AS unitPrice, total_price AS totalPrice`;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** officeId 为 null 时列出所有办公点的。 */
export async function listProducts(
  db: SQLiteDatabase,
  kind?: StockKind,
  officeId: number | null = null,
): Promise<StockProductSummary[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (kind) {
    conditions.push('p.kind = ?');
    params.push(kind);
  }
  if (officeId !== null) {
    conditions.push('p.office_id = ?');
    params.push(officeId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
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

/** officeId 为 null 时在所有办公点里找（取最早录入的一个）。 */
export async function findProductByBarcode(
  db: SQLiteDatabase,
  barcode: string,
  officeId: number | null = null,
): Promise<StockProduct | null> {
  return officeId === null
    ? db.getFirstAsync<StockProduct>(`SELECT ${PRODUCT_COLUMNS} FROM stock_product p WHERE p.barcode = ? ORDER BY p.id`, [
        barcode.trim(),
      ])
    : db.getFirstAsync<StockProduct>(
        `SELECT ${PRODUCT_COLUMNS} FROM stock_product p WHERE p.barcode = ? AND p.office_id = ?`,
        [barcode.trim(), officeId],
      );
}

/**
 * 按条码找物品：先找物品本身的条码，再找包装（整箱、整包）的条码。
 * 条码只在同一办公点内唯一，所以要说明在哪个办公点找；null 表示所有办公点。
 */
export async function findByBarcode(
  db: SQLiteDatabase,
  barcode: string,
  officeId: number | null = null,
): Promise<BarcodeMatch | null> {
  const code = barcode.trim();
  if (!code) return null;
  const product = await findProductByBarcode(db, code, officeId);
  if (product) return { product, pack: null };
  const pack = await db.getFirstAsync<PackUnit & { productId: number }>(
    `SELECT k.product_id AS productId, k.unit, k.size, k.barcode
       FROM stock_pack k JOIN stock_product p ON p.id = k.product_id
      WHERE k.barcode = ? AND (? IS NULL OR p.office_id = ?)
      ORDER BY k.product_id`,
    [code, officeId, officeId],
  );
  if (!pack) return null;
  const owner = await getProduct(db, pack.productId);
  return owner ? { product: owner, pack: { unit: pack.unit, size: pack.size, barcode: pack.barcode } } : null;
}

/** 物品条码、包装条码要是商品条码（8–14 位数字），不是就抛出给用户看的错误；空着可以。备份导入不走这里（照旧宽松）。 */
function assertProductBarcodes(input: StockProductInput): void {
  for (const code of [input.barcode, ...input.packs.map((pack) => pack.barcode)]) {
    const value = code?.trim();
    if (value && !isProductBarcode(value)) throw new Error(PRODUCT_BARCODE_ERROR);
  }
}

/** 物品条码和包装条码不能和同一办公点里别的物品撞；撞了抛出给用户看的错误。 */
async function assertBarcodesFree(db: SQLiteDatabase, input: StockProductInput, selfId: number | null): Promise<void> {
  const own = [input.barcode, ...input.packs.map((pack) => pack.barcode)]
    .map((code) => code?.trim())
    .filter((code): code is string => !!code);
  if (new Set(own).size !== own.length) throw new Error('物品条码和包装条码不能相同');
  for (const code of own) {
    const match = await findByBarcode(db, code, input.officeId);
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

const SHELF_LIFE_UNITS: ShelfLifeUnit[] = ['day', 'month', 'year'];

/** 保质期合不合理：正整数、单位是 天 / 个月 / 年；不合理的当没填 */
export function validShelfLife(value: ShelfLife | null | undefined): ShelfLife | null {
  if (!value || !SHELF_LIFE_UNITS.includes(value.unit)) return null;
  if (!Number.isInteger(value.amount) || value.amount <= 0 || value.amount > 9999) return null;
  return { amount: value.amount, unit: value.unit };
}

/** 商品资料里的保质期，没填是 null */
export function productShelfLife(product: Pick<StockProduct, 'shelfLifeAmount' | 'shelfLifeUnit'>): ShelfLife | null {
  if (product.shelfLifeAmount === null || product.shelfLifeUnit === null) return null;
  return validShelfLife({ amount: product.shelfLifeAmount, unit: product.shelfLifeUnit });
}

function productParams(input: StockProductInput) {
  return [
    input.officeId,
    input.kind,
    emptyToNull(input.barcode),
    input.name.trim(),
    emptyToNull(input.category),
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
  assertProductBarcodes(input);
  await assertBarcodesFree(db, input, null);
  let productId = 0;
  await db.withTransactionAsync(async () => {
    const now = nowIso();
    const shelfLife = validShelfLife(input.shelfLife);
    const result = await db.runAsync(
      `INSERT INTO stock_product
         (office_id, kind, barcode, name, category, spec, unit, location, low_stock_threshold, expiry_lead_days, note, created_at, updated_at,
          shelf_life_amount, shelf_life_unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...productParams(input), now, now, shelfLife?.amount ?? null, shelfLife?.unit ?? null],
    );
    productId = result.lastInsertRowId;
    await savePacks(db, productId, input.packs);
    if (firstBatch && firstBatch.quantity > 0) {
      await insertBatch(db, productId, firstBatch);
      await recordMovement(
        db,
        productId,
        'in',
        firstBatch.quantity,
        firstBatch.expiryDate,
        firstBatch.note ?? null,
        firstBatch.entry,
        firstBatch.price,
        firstBatch.productionDate ?? null,
      );
    }
  });
  return productId;
}

export async function updateProduct(db: SQLiteDatabase, id: number, input: StockProductInput): Promise<void> {
  assertProductBarcodes(input);
  await assertBarcodesFree(db, input, id);
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE stock_product
          SET office_id = ?, kind = ?, barcode = ?, name = ?, category = ?, spec = ?, unit = ?, location = ?,
              low_stock_threshold = ?, expiry_lead_days = ?, note = ?, updated_at = ?
        WHERE id = ?`,
      [...productParams(input), nowIso(), id],
    );
    if (input.shelfLife !== undefined) {
      const shelfLife = validShelfLife(input.shelfLife);
      await db.runAsync('UPDATE stock_product SET shelf_life_amount = ?, shelf_life_unit = ? WHERE id = ?', [
        shelfLife?.amount ?? null,
        shelfLife?.unit ?? null,
        id,
      ]);
    }
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
  price: EntryPrice | null = null,
  productionDate: string | null = null,
): Promise<void> {
  if (roundQty(delta) === 0 && type !== 'adjust') return;
  // 只有入库记价格、生产日期（没记过期日期就没有生产日期）
  const recordedPrice = type === 'in' ? price : null;
  const recordedProductionDate = type === 'in' && expiryDate ? productionDate : null;
  await db.runAsync(
    `INSERT INTO stock_movement
       (product_id, type, delta, expiry_date, happened_at, note, input_qty, input_unit, unit_price, total_price, production_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productId,
      type,
      roundQty(delta),
      expiryDate,
      nowIso(),
      emptyToNull(note),
      entry ? roundQty(entry.qty) : null,
      entry?.unit ?? null,
      recordedPrice ? roundUnitPrice(recordedPrice.unitPrice) : null,
      recordedPrice ? roundTotalPrice(recordedPrice.totalPrice) : null,
      recordedProductionDate,
    ],
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
    await recordMovement(
      db,
      productId,
      'in',
      batch.quantity,
      batch.expiryDate,
      batch.note ?? null,
      batch.entry,
      batch.price,
      batch.productionDate ?? null,
    );
    await db.runAsync('UPDATE stock_product SET updated_at = ? WHERE id = ?', [nowIso(), productId]);
    const shelfLife = validShelfLife(batch.shelfLife);
    if (shelfLife) {
      await db.runAsync(
        'UPDATE stock_product SET shelf_life_amount = ?, shelf_life_unit = ? WHERE id = ? AND shelf_life_amount IS NULL',
        [shelfLife.amount, shelfLife.unit, productId],
      );
    }
  });
}

/** 出库：先到期的批次先扣。返回实际扣掉的数量和不够扣的部分。note 是出库原因（用掉、过期丢弃……）。 */
export async function stockOut(
  db: SQLiteDatabase,
  productId: number,
  amount: number,
  note: string | null = null,
  entry: EntryQty | null = null,
  allocations: readonly BatchAllocation[] | null = null,
): Promise<{ consumed: number; shortfall: number }> {
  let outcome = { consumed: 0, shortfall: amount };
  await db.withTransactionAsync(async () => {
    const batches = await listBatches(db, productId);
    // 指定了从哪几批出：先核对（每批不超过现有、合计等于要出的），再先扣指定的批次；没指定就先到期先出
    if (allocations?.length) {
      const error = allocationError(batches, amount, allocations);
      if (error) throw new Error(error);
    }
    const plan = planAllocatedConsumption(batches, amount, allocations);
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

/** 最近一次入库（入库记录、数量为正）；没入过库是 null。入库面板按它带出过期日期、「同上次」的生产日期，编辑页改它的价格 */
export async function getLastStockIn(db: SQLiteDatabase, productId: number): Promise<StockMovement | null> {
  return db.getFirstAsync<StockMovement>(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_movement
      WHERE product_id = ? AND type = 'in' AND delta > 0
      ORDER BY happened_at DESC, id DESC LIMIT 1`,
    [productId],
  );
}

/** 改一条入库记录的单价、总价（price 为 null 是清掉价格）。出库、调整的记录没有价格，不能改 */
export async function updateMovementPrice(db: SQLiteDatabase, movementId: number, price: EntryPrice | null): Promise<void> {
  const movement = await db.getFirstAsync<{ type: MovementType; delta: number }>(
    'SELECT type, delta FROM stock_movement WHERE id = ?',
    [movementId],
  );
  if (!movement) throw new Error('这条记录不存在了');
  if (movement.type !== 'in' || !(movement.delta > 0)) throw new Error('只有入库记录能改价格');
  await db.runAsync('UPDATE stock_movement SET unit_price = ?, total_price = ? WHERE id = ?', [
    price ? roundUnitPrice(price.unitPrice) : null,
    price ? roundTotalPrice(price.totalPrice) : null,
    movementId,
  ]);
}

export type LastPurchasePrice = {
  /** 折成最小单位的进价（每瓶多少钱） */
  perBaseUnit: number;
  /** 当时填的单价和单位，用来显示「每箱 48.00」 */
  unitPrice: number;
  unit: string;
  happenedAt: string;
};

/** 最近一次填了价格的入库；下次入库默认用这个价。 */
export async function getLastPurchasePrice(db: SQLiteDatabase, productId: number): Promise<LastPurchasePrice | null> {
  const row = await db.getFirstAsync<{
    delta: number;
    inputQty: number | null;
    inputUnit: string | null;
    unitPrice: number | null;
    totalPrice: number | null;
    happenedAt: string;
    baseUnit: string;
  }>(
    `SELECT m.delta, m.input_qty AS inputQty, m.input_unit AS inputUnit, m.unit_price AS unitPrice,
            m.total_price AS totalPrice, m.happened_at AS happenedAt, p.unit AS baseUnit
       FROM stock_movement m JOIN stock_product p ON p.id = m.product_id
      WHERE m.product_id = ? AND m.type = 'in' AND m.delta > 0
        AND (m.unit_price IS NOT NULL OR m.total_price IS NOT NULL)
      ORDER BY m.happened_at DESC, m.id DESC
      LIMIT 1`,
    [productId],
  );
  if (!row) return null;
  const perBaseUnit = perBaseUnitPrice(row);
  if (perBaseUnit === null) return null;
  const enteredQty = row.inputQty !== null && row.inputQty > 0 ? row.inputQty : row.delta;
  const unitPrice = row.unitPrice ?? roundUnitPrice((row.totalPrice ?? 0) / enteredQty);
  return { perBaseUnit, unitPrice, unit: row.inputUnit ?? row.baseUnit, happenedAt: row.happenedAt };
}

export async function listLocations(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ location: string }>(
    `SELECT location FROM stock_product WHERE location IS NOT NULL
      GROUP BY location ORDER BY MAX(updated_at) DESC LIMIT 12`,
  );
  return rows.map((row) => row.location);
}
