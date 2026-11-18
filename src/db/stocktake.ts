import type { SQLiteDatabase } from 'expo-sqlite';

import { todayStr } from '../lib/dates';
import { roundQty } from '../lib/stock';
import {
  adjustmentNote,
  countState,
  parseKinds,
  planAdjustment,
  serializeKinds,
  summarizeCounts,
  type CountSummary,
  type StocktakeKind,
  type StocktakeStatus,
} from '../lib/stocktake';
import { findByBarcode } from './stock';

/**
 * 盘点：按办公点和分类建一张盘点单，逐项记实盘数，完成时按差异调整库存。
 * 盘点单只存在本机，不进备份文件；完成时对库存的调整记成「调整」类的出入库记录，会随备份走。
 */

export type Stocktake = {
  id: number;
  officeId: number;
  kinds: StocktakeKind[];
  status: StocktakeStatus;
  startedAt: string;
  finishedAt: string | null;
  note: string | null;
};

export type StocktakeListEntry = Stocktake & { officeName: string | null; summary: CountSummary };

export type StocktakeItemType = 'product' | 'device';

export type StocktakeItem = {
  id: number;
  stocktakeId: number;
  itemType: StocktakeItemType;
  itemId: number;
  kind: StocktakeKind;
  name: string;
  unit: string;
  /** 清点那一刻的账面数；还没盘时为 null */
  expectedQty: number | null;
  /** 实盘数（最小单位）；还没盘时为 null */
  countedQty: number | null;
  countedAt: string | null;
  /** 完成时对库存实际调整了多少；设备、未盘为 null */
  adjustedQty: number | null;
  /** 现在的账面数：物品是批次合计，设备是在库数量（总数 − 借出） */
  bookQty: number;
  /** 物品条码或设备序列号，搜索用 */
  code: string | null;
  /** 物品、设备还在不在（盘点期间被删了就是 false） */
  present: boolean;
};

type StocktakeRow = Omit<Stocktake, 'kinds'> & { kinds: string };

const STOCKTAKE_COLUMNS = `
  s.id, s.office_id AS officeId, s.kinds, s.status, s.started_at AS startedAt, s.finished_at AS finishedAt, s.note`;

/** 一项现在的账面数 */
const BOOK_QTY_SQL = `
  CASE i.item_type
    WHEN 'product' THEN (
      SELECT COALESCE(SUM(b.quantity), 0) FROM stock_batch b WHERE b.product_id = i.item_id AND b.quantity > 0)
    ELSE COALESCE((
      SELECT d.quantity - COALESCE((
        SELECT SUM(a.quantity) FROM device_assignment a WHERE a.device_id = d.id AND a.returned_on IS NULL), 0)
        FROM device d WHERE d.id = i.item_id), 0)
  END`;

const ITEM_COLUMNS = `
  i.id, i.stocktake_id AS stocktakeId, i.item_type AS itemType, i.item_id AS itemId, i.kind, i.name, i.unit,
  i.expected_qty AS expectedQty, i.counted_qty AS countedQty, i.counted_at AS countedAt, i.adjusted_qty AS adjustedQty,
  ${BOOK_QTY_SQL} AS bookQty,
  CASE i.item_type
    WHEN 'product' THEN (SELECT p.barcode FROM stock_product p WHERE p.id = i.item_id)
    ELSE (SELECT d.serial_no FROM device d WHERE d.id = i.item_id)
  END AS code,
  CASE i.item_type
    WHEN 'product' THEN EXISTS (SELECT 1 FROM stock_product p WHERE p.id = i.item_id)
    ELSE EXISTS (SELECT 1 FROM device d WHERE d.id = i.item_id)
  END AS present`;

function nowIso(): string {
  return new Date().toISOString();
}

function toStocktake(row: StocktakeRow): Stocktake {
  return { ...row, kinds: parseKinds(row.kinds) };
}

function toItem(row: Omit<StocktakeItem, 'present'> & { present: number | boolean }): StocktakeItem {
  return { ...row, bookQty: roundQty(row.bookQty), present: !!row.present };
}

export async function getStocktake(db: SQLiteDatabase, id: number): Promise<Stocktake | null> {
  const row = await db.getFirstAsync<StocktakeRow>(`SELECT ${STOCKTAKE_COLUMNS} FROM stocktake s WHERE s.id = ?`, [id]);
  return row ? toStocktake(row) : null;
}

export async function getOpenStocktake(db: SQLiteDatabase, officeId: number): Promise<Stocktake | null> {
  const row = await db.getFirstAsync<StocktakeRow>(
    `SELECT ${STOCKTAKE_COLUMNS} FROM stocktake s WHERE s.office_id = ? AND s.status = 'open'`,
    [officeId],
  );
  return row ? toStocktake(row) : null;
}

/** 盘点列表：进行中的在前，其余按开始时间倒序。officeId 为 null 时列出所有办公点的。 */
export async function listStocktakes(db: SQLiteDatabase, officeId: number | null): Promise<StocktakeListEntry[]> {
  const rows = await db.getAllAsync<StocktakeRow & { officeName: string | null }>(
    `SELECT ${STOCKTAKE_COLUMNS}, o.name AS officeName
       FROM stocktake s LEFT JOIN office o ON o.id = s.office_id
      WHERE (? IS NULL OR s.office_id = ?)
      ORDER BY s.status = 'open' DESC, s.started_at DESC, s.id DESC`,
    [officeId, officeId],
  );
  const counts = await db.getAllAsync<{ stocktakeId: number; expectedQty: number | null; countedQty: number | null }>(
    `SELECT i.stocktake_id AS stocktakeId, i.expected_qty AS expectedQty, i.counted_qty AS countedQty
       FROM stocktake_item i JOIN stocktake s ON s.id = i.stocktake_id
      WHERE (? IS NULL OR s.office_id = ?)`,
    [officeId, officeId],
  );
  const byStocktake = new Map<number, { expectedQty: number | null; countedQty: number | null }[]>();
  for (const count of counts) {
    const list = byStocktake.get(count.stocktakeId) ?? [];
    list.push(count);
    byStocktake.set(count.stocktakeId, list);
  }
  return rows.map(({ officeName, ...row }) => ({
    ...toStocktake(row),
    officeName,
    summary: summarizeCounts(byStocktake.get(row.id) ?? []),
  }));
}

export async function listStocktakeItems(db: SQLiteDatabase, stocktakeId: number): Promise<StocktakeItem[]> {
  const rows = await db.getAllAsync<Omit<StocktakeItem, 'present'> & { present: number }>(
    `SELECT ${ITEM_COLUMNS}
       FROM stocktake_item i
      WHERE i.stocktake_id = ?
      ORDER BY CASE i.kind WHEN 'food' THEN 0 WHEN 'daily' THEN 1 ELSE 2 END, i.name COLLATE NOCASE, i.id`,
    [stocktakeId],
  );
  return rows.map(toItem);
}

async function getItem(db: SQLiteDatabase, itemId: number): Promise<StocktakeItem | null> {
  const row = await db.getFirstAsync<Omit<StocktakeItem, 'present'> & { present: number }>(
    `SELECT ${ITEM_COLUMNS} FROM stocktake_item i WHERE i.id = ?`,
    [itemId],
  );
  return row ? toItem(row) : null;
}

/**
 * 开始盘点：把办公点里所选分类的物品、设备都列进盘点单（名称、单位留快照）。
 * 同一个办公点已经有进行中的盘点时报错。返回盘点单 id。
 */
export async function startStocktake(
  db: SQLiteDatabase,
  officeId: number,
  kinds: readonly StocktakeKind[],
): Promise<number> {
  const selected = parseKinds(serializeKinds(kinds));
  if (!selected.length) throw new Error('请至少选一个分类');
  if (await getOpenStocktake(db, officeId)) throw new Error('这个办公点有一次盘点还没完成，先完成或放弃它');

  const productKinds = selected.filter((kind): kind is 'food' | 'daily' => kind !== 'devices');
  const products = productKinds.length
    ? await db.getAllAsync<{ id: number; kind: 'food' | 'daily'; name: string; unit: string }>(
        `SELECT id, kind, name, unit FROM stock_product
          WHERE office_id = ? AND kind IN (${productKinds.map(() => '?').join(', ')})
          ORDER BY id`,
        [officeId, ...productKinds],
      )
    : [];
  const devices = selected.includes('devices')
    ? await db.getAllAsync<{ id: number; name: string; model: string | null }>(
        'SELECT id, name, model FROM device WHERE office_id = ? ORDER BY id',
        [officeId],
      )
    : [];
  if (!products.length && !devices.length) throw new Error('所选分类里还没有东西，不用盘');

  let stocktakeId = 0;
  await db.withTransactionAsync(async () => {
    const result = await db.runAsync(
      "INSERT INTO stocktake (office_id, kinds, status, started_at) VALUES (?, ?, 'open', ?)",
      [officeId, serializeKinds(selected), nowIso()],
    );
    stocktakeId = result.lastInsertRowId;
    for (const product of products) {
      await db.runAsync(
        "INSERT INTO stocktake_item (stocktake_id, item_type, item_id, kind, name, unit) VALUES (?, 'product', ?, ?, ?, ?)",
        [stocktakeId, product.id, product.kind, product.name, product.unit],
      );
    }
    for (const device of devices) {
      await db.runAsync(
        "INSERT INTO stocktake_item (stocktake_id, item_type, item_id, kind, name, unit) VALUES (?, 'device', ?, 'devices', ?, '件')",
        [stocktakeId, device.id, device.model ? `${device.name}（${device.model}）` : device.name],
      );
    }
  });
  return stocktakeId;
}

async function assertOpen(db: SQLiteDatabase, stocktakeId: number): Promise<void> {
  const stocktake = await getStocktake(db, stocktakeId);
  if (!stocktake) throw new Error('找不到这次盘点');
  if (stocktake.status !== 'open') throw new Error('这次盘点已经结束了');
}

/**
 * 记一项的实盘数（最小单位）。同时记下此刻的账面数：完成时按「实盘 − 清点时的账面」调整，
 * 清点之后又入库、出库的数量不受影响。
 */
export async function recordCount(db: SQLiteDatabase, itemId: number, countedQty: number): Promise<void> {
  const item = await getItem(db, itemId);
  if (!item) throw new Error('找不到这一项');
  await assertOpen(db, item.stocktakeId);
  if (!(countedQty >= 0)) throw new Error('实盘数量不能小于 0');
  if (item.itemType === 'device' && !Number.isInteger(countedQty)) throw new Error('设备数量要是整数');
  await db.runAsync('UPDATE stocktake_item SET counted_qty = ?, expected_qty = ?, counted_at = ? WHERE id = ?', [
    roundQty(countedQty),
    item.bookQty,
    nowIso(),
    itemId,
  ]);
}

/** 把一项改回「未盘」 */
export async function clearCount(db: SQLiteDatabase, itemId: number): Promise<void> {
  const item = await getItem(db, itemId);
  if (!item) return;
  await assertOpen(db, item.stocktakeId);
  await db.runAsync(
    'UPDATE stocktake_item SET counted_qty = NULL, expected_qty = NULL, counted_at = NULL WHERE id = ?',
    [itemId],
  );
}

/**
 * 扫码找盘点单里的一项：物品条码、包装条码（带上包装单位）、设备序列号。
 * 不在这次盘点里返回 null。
 */
export async function findStocktakeItemByCode(
  db: SQLiteDatabase,
  stocktakeId: number,
  code: string,
): Promise<{ itemId: number; packUnit: string | null } | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const stocktake = await getStocktake(db, stocktakeId);
  if (!stocktake) return null;
  const match = await findByBarcode(db, trimmed, stocktake.officeId);
  if (match) {
    const row = await db.getFirstAsync<{ id: number }>(
      "SELECT id FROM stocktake_item WHERE stocktake_id = ? AND item_type = 'product' AND item_id = ?",
      [stocktakeId, match.product.id],
    );
    if (row) return { itemId: row.id, packUnit: match.pack?.unit ?? null };
  }
  const device = await db.getFirstAsync<{ id: number }>(
    `SELECT i.id FROM stocktake_item i JOIN device d ON d.id = i.item_id
      WHERE i.stocktake_id = ? AND i.item_type = 'device' AND d.serial_no = ?`,
    [stocktakeId, trimmed],
  );
  return device ? { itemId: device.id, packUnit: null } : null;
}

export type FinishResult = CountSummary & {
  /** 实际改了库存的物品数 */
  adjustedProducts: number;
  /** 有差异的设备数（不自动改，要手动处理） */
  deviceDifferences: number;
};

/**
 * 完成盘点：已盘的物品按「实盘 − 清点时的账面」调整库存（盘亏先扣最早到期的批次，
 * 盘盈加到最早到期的那一批，没有批次就新建一批），每项记一条「调整」出入库记录。
 * 设备只记差异，不改数量；未盘的不调整；盘点期间被删掉的物品跳过。
 */
export async function finishStocktake(db: SQLiteDatabase, stocktakeId: number): Promise<FinishResult> {
  await assertOpen(db, stocktakeId);
  const items = await listStocktakeItems(db, stocktakeId);
  const summary = summarizeCounts(items);
  let adjustedProducts = 0;
  let deviceDifferences = 0;

  await db.withTransactionAsync(async () => {
    const now = nowIso();
    for (const item of items) {
      const state = countState(item);
      if (state === 'uncounted') continue;
      if (item.itemType === 'device') {
        if (state !== 'match') deviceDifferences += 1;
        continue;
      }
      if (!item.present || item.countedQty === null) continue;
      const expected = item.expectedQty ?? 0;
      if (state === 'match') {
        await db.runAsync('UPDATE stocktake_item SET adjusted_qty = 0 WHERE id = ?', [item.id]);
        continue;
      }
      const batches = await db.getAllAsync<{ id: number; quantity: number; expiryDate: string | null }>(
        'SELECT id, quantity, expiry_date AS expiryDate FROM stock_batch WHERE product_id = ? AND quantity > 0',
        [item.itemId],
      );
      const plan = planAdjustment(batches, item.countedQty - expected);
      for (const update of plan.updates) {
        if (update.quantity <= 0) {
          await db.runAsync('DELETE FROM stock_batch WHERE id = ?', [update.id]);
        } else {
          await db.runAsync('UPDATE stock_batch SET quantity = ? WHERE id = ?', [update.quantity, update.id]);
        }
      }
      if (plan.newBatchQty > 0) {
        await db.runAsync(
          'INSERT INTO stock_batch (product_id, quantity, expiry_date, added_on, note) VALUES (?, ?, NULL, ?, ?)',
          [item.itemId, plan.newBatchQty, todayStr(), '盘点多出'],
        );
      }
      if (plan.applied !== 0) {
        await db.runAsync(
          `INSERT INTO stock_movement
             (product_id, type, delta, expiry_date, happened_at, note, input_qty, input_unit, unit_price, total_price)
           VALUES (?, 'adjust', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
          [item.itemId, plan.applied, plan.targetExpiry, now, adjustmentNote(expected, item.countedQty, plan.applied)],
        );
        await db.runAsync('UPDATE stock_product SET updated_at = ? WHERE id = ?', [now, item.itemId]);
        adjustedProducts += 1;
      }
      await db.runAsync('UPDATE stocktake_item SET adjusted_qty = ? WHERE id = ?', [plan.applied, item.id]);
    }
    await db.runAsync("UPDATE stocktake SET status = 'done', finished_at = ? WHERE id = ?", [now, stocktakeId]);
  });
  return { ...summary, adjustedProducts, deviceDifferences };
}

/** 放弃盘点：不改库存，盘点单留作记录 */
export async function cancelStocktake(db: SQLiteDatabase, stocktakeId: number): Promise<void> {
  await assertOpen(db, stocktakeId);
  await db.runAsync("UPDATE stocktake SET status = 'cancelled', finished_at = ? WHERE id = ?", [nowIso(), stocktakeId]);
}

/** 删掉一个办公点的全部盘点（删办公点时用） */
export async function deleteStocktakesOfOffice(db: SQLiteDatabase, officeId: number): Promise<void> {
  await db.runAsync('DELETE FROM stocktake_item WHERE stocktake_id IN (SELECT id FROM stocktake WHERE office_id = ?)', [
    officeId,
  ]);
  await db.runAsync('DELETE FROM stocktake WHERE office_id = ?', [officeId]);
}

/**
 * 导入替换了某办公点的这些分类后，删掉涉及这些分类的「进行中」盘点：
 * 导入会重建物品和设备，id 变了，旧盘点单对不上。已完成、已放弃的是快照，保留。
 */
export async function dropOpenStocktakesFor(
  db: SQLiteDatabase,
  officeId: number,
  replacedKinds: readonly StocktakeKind[],
): Promise<void> {
  const open = await db.getAllAsync<{ id: number; kinds: string }>(
    "SELECT id, kinds FROM stocktake WHERE office_id = ? AND status = 'open'",
    [officeId],
  );
  for (const stocktake of open) {
    if (!parseKinds(stocktake.kinds).some((kind) => replacedKinds.includes(kind))) continue;
    await db.runAsync('DELETE FROM stocktake_item WHERE stocktake_id = ?', [stocktake.id]);
    await db.runAsync('DELETE FROM stocktake WHERE id = ?', [stocktake.id]);
  }
}
