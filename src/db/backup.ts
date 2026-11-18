import type { SQLiteDatabase } from 'expo-sqlite';

import { buildBackup, type BackupData } from '../lib/backup';
import { getSettings } from './settings';
import type { MovementType } from './stock';

/** 把手机上的全部数据读出来，组装成备份。 */
export async function collectBackup(db: SQLiteDatabase): Promise<BackupData> {
  const [settings, products, packs, batches, movements, devices, assignments] = await Promise.all([
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
      createdAt: string;
      updatedAt: string;
    }>(
      `SELECT id, category, name, model, serial_no AS serialNo, quantity, note,
              created_at AS createdAt, updated_at AS updatedAt
         FROM device ORDER BY id`,
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
  return buildBackup({ settings, products, packs, batches, movements, devices, assignments });
}

/** 用备份里的数据替换手机上的全部数据（一个事务里完成，失败就整体回滚）。 */
export async function replaceAllData(db: SQLiteDatabase, data: BackupData): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      DELETE FROM stock_movement;
      DELETE FROM stock_pack;
      DELETE FROM stock_batch;
      DELETE FROM stock_product;
      DELETE FROM device_assignment;
      DELETE FROM device;
      DELETE FROM setting;
    `);

    for (const product of data.products) {
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

    for (const device of data.devices) {
      const result = await db.runAsync(
        `INSERT INTO device (category, name, model, serial_no, quantity, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [device.category, device.name, device.model, device.serialNo, device.quantity, device.note, device.createdAt, device.updatedAt],
      );
      const deviceId = result.lastInsertRowId;
      for (const assignment of device.assignments) {
        await db.runAsync(
          `INSERT INTO device_assignment (device_id, person, quantity, issued_on, returned_on, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [deviceId, assignment.person, assignment.quantity, assignment.issuedOn, assignment.returnedOn, assignment.note],
        );
      }
    }

    for (const [key, value] of Object.entries(data.settings)) {
      await db.runAsync('INSERT INTO setting (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
    }
  });
}
