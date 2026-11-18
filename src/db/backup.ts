import type { SQLiteDatabase } from 'expo-sqlite';

import {
  ALL_SCOPES,
  buildBackup,
  findBarcodeConflict,
  normalizeScope,
  type BackupData,
  type BackupScope,
  type KeptProduct,
} from '../lib/backup';
import { getSettings } from './settings';
import type { MovementType } from './stock';

/** 把手机上的数据读出来，按所选分类组装成备份（默认全部）。 */
export async function collectBackup(
  db: SQLiteDatabase,
  scope: readonly BackupScope[] = ALL_SCOPES,
): Promise<BackupData> {
  const [settings, products, packs, batches, movements, devices, accessories, assignments] = await Promise.all([
    getSettings(db),
    db.getAllAsync<{
      id: number;
      kind: 'food' | 'daily';
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
    }>(
      `SELECT id, kind, barcode, name, brand, spec, unit, location,
              low_stock_threshold AS lowStockThreshold, expiry_lead_days AS expiryLeadDays,
              note, created_at AS createdAt, updated_at AS updatedAt
         FROM stock_product ORDER BY id`,
    ),
    db.getAllAsync<{ productId: number; unit: string; size: number; barcode: string | null }>(
      'SELECT product_id AS productId, unit, size, barcode FROM stock_pack ORDER BY product_id, sort, id',
    ),
    db.getAllAsync<{ productId: number; quantity: number; expiryDate: string | null; addedOn: string; note: string | null }>(
      `SELECT product_id AS productId, quantity, expiry_date AS expiryDate, added_on AS addedOn, note
         FROM stock_batch ORDER BY id`,
    ),
    db.getAllAsync<{
      productId: number;
      type: MovementType;
      delta: number;
      expiryDate: string | null;
      happenedAt: string;
      note: string | null;
      inputQty: number | null;
      inputUnit: string | null;
    }>(
      `SELECT product_id AS productId, type, delta, expiry_date AS expiryDate, happened_at AS happenedAt, note,
              input_qty AS inputQty, input_unit AS inputUnit
         FROM stock_movement ORDER BY id`,
    ),
    db.getAllAsync<{
      id: number;
      category: string;
      name: string;
      model: string | null;
      serialNo: string | null;
      quantity: number;
      note: string | null;
      purchaseDate: string | null;
      warrantyUntil: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      `SELECT id, category, name, model, serial_no AS serialNo, quantity, note,
              purchase_date AS purchaseDate, warranty_until AS warrantyUntil,
              created_at AS createdAt, updated_at AS updatedAt
         FROM device ORDER BY id`,
    ),
    db.getAllAsync<{ deviceId: number; name: string; quantity: number }>(
      'SELECT device_id AS deviceId, name, quantity FROM device_accessory ORDER BY device_id, sort, id',
    ),
    db.getAllAsync<{
      deviceId: number;
      person: string;
      quantity: number;
      issuedOn: string;
      returnedOn: string | null;
      note: string | null;
    }>(
      `SELECT device_id AS deviceId, person, quantity, issued_on AS issuedOn, returned_on AS returnedOn, note
         FROM device_assignment ORDER BY id`,
    ),
  ]);
  return buildBackup(
    { settings, products, packs, batches, movements, devices, accessories, assignments },
    new Date(),
    scope,
  );
}

/** 手机上保留下来（这次不替换）的物品及其全部条码，用来查条码冲突。 */
async function keptProducts(db: SQLiteDatabase, replacedKinds: string[]): Promise<KeptProduct[]> {
  const rows = await db.getAllAsync<{ id: number; name: string; kind: 'food' | 'daily'; barcode: string | null }>(
    'SELECT id, name, kind, barcode FROM stock_product',
  );
  const packs = await db.getAllAsync<{ productId: number; barcode: string }>(
    'SELECT product_id AS productId, barcode FROM stock_pack WHERE barcode IS NOT NULL',
  );
  return rows
    .filter((row) => !replacedKinds.includes(row.kind))
    .map((row) => ({
      name: row.name,
      kind: row.kind,
      barcodes: [row.barcode, ...packs.filter((pack) => pack.productId === row.id).map((pack) => pack.barcode)].filter(
        (code): code is string => !!code,
      ),
    }));
}

/**
 * 用备份里的数据替换手机上所选分类的数据，没选的分类原样保留。
 * 一个事务里完成，失败就整体回滚。scope 只能是备份里有的分类。
 */
export async function replaceData(db: SQLiteDatabase, data: BackupData, scope: readonly BackupScope[]): Promise<void> {
  const selected = normalizeScope(scope).filter((item) => data.scope.includes(item));
  if (!selected.length) throw new Error('没有选要导入的分类');
  const kinds = selected.filter((item): item is 'food' | 'daily' => item === 'food' || item === 'daily');
  const incoming = data.products.filter((product) => kinds.includes(product.kind));

  const conflict = findBarcodeConflict(incoming, await keptProducts(db, kinds));
  if (conflict) throw new Error(conflict);

  await db.withTransactionAsync(async () => {
    for (const kind of kinds) {
      const owned = 'SELECT id FROM stock_product WHERE kind = ?';
      await db.runAsync(`DELETE FROM stock_movement WHERE product_id IN (${owned})`, [kind]);
      await db.runAsync(`DELETE FROM stock_pack WHERE product_id IN (${owned})`, [kind]);
      await db.runAsync(`DELETE FROM stock_batch WHERE product_id IN (${owned})`, [kind]);
      await db.runAsync('DELETE FROM stock_product WHERE kind = ?', [kind]);
    }
    if (selected.includes('devices')) {
      await db.execAsync('DELETE FROM device_assignment; DELETE FROM device_accessory; DELETE FROM device;');
    }
    if (selected.includes('settings')) {
      await db.execAsync('DELETE FROM setting;');
    }

    for (const product of incoming) {
      const result = await db.runAsync(
        `INSERT INTO stock_product
           (kind, barcode, name, brand, spec, unit, location, low_stock_threshold, expiry_lead_days, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          product.kind,
          product.barcode,
          product.name,
          product.brand,
          product.spec,
          product.unit,
          product.location,
          product.lowStockThreshold,
          product.expiryLeadDays,
          product.note,
          product.createdAt,
          product.updatedAt,
        ],
      );
      const productId = result.lastInsertRowId;
      let sort = 0;
      for (const pack of product.packs) {
        await db.runAsync('INSERT INTO stock_pack (product_id, unit, size, barcode, sort) VALUES (?, ?, ?, ?, ?)', [
          productId,
          pack.unit,
          pack.size,
          pack.barcode,
          sort++,
        ]);
      }
      for (const batch of product.batches) {
        await db.runAsync(
          'INSERT INTO stock_batch (product_id, quantity, expiry_date, added_on, note) VALUES (?, ?, ?, ?, ?)',
          [productId, batch.quantity, batch.expiryDate, batch.addedOn, batch.note],
        );
      }
      for (const movement of product.movements) {
        await db.runAsync(
          `INSERT INTO stock_movement (product_id, type, delta, expiry_date, happened_at, note, input_qty, input_unit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            productId,
            movement.type,
            movement.delta,
            movement.expiryDate,
            movement.happenedAt,
            movement.note,
            movement.inputQty,
            movement.inputUnit,
          ],
        );
      }
    }

    for (const device of selected.includes('devices') ? data.devices : []) {
      const result = await db.runAsync(
        `INSERT INTO device (category, name, model, serial_no, quantity, note, purchase_date, warranty_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          device.category,
          device.name,
          device.model,
          device.serialNo,
          device.quantity,
          device.note,
          device.purchaseDate,
          device.warrantyUntil,
          device.createdAt,
          device.updatedAt,
        ],
      );
      const deviceId = result.lastInsertRowId;
      let accessorySort = 0;
      for (const accessory of device.accessories) {
        await db.runAsync('INSERT INTO device_accessory (device_id, name, quantity, sort) VALUES (?, ?, ?, ?)', [
          deviceId,
          accessory.name,
          accessory.quantity,
          accessorySort++,
        ]);
      }
      for (const assignment of device.assignments) {
        await db.runAsync(
          `INSERT INTO device_assignment (device_id, person, quantity, issued_on, returned_on, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [deviceId, assignment.person, assignment.quantity, assignment.issuedOn, assignment.returnedOn, assignment.note],
        );
      }
    }

    if (selected.includes('settings') && data.settings) {
      for (const [key, value] of Object.entries(data.settings)) {
        await db.runAsync('INSERT INTO setting (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
      }
    }
  });
}
