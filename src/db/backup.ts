import type { SQLiteDatabase } from 'expo-sqlite';

import {
  ALL_SCOPES,
  buildBackup,
  findBarcodeConflict,
  normalizeScope,
  type BackupData,
  type BackupDevice,
  type BackupProduct,
  type BackupScope,
  type KeptProduct,
} from '../lib/backup';
import { currentScene, DEFAULT_PLACE_NAMES } from '../lib/terms';
import { ensureOfficeByName } from './offices';
import { DEFAULT_SETTINGS, getScene, getSettings } from './settings';
import type { MovementType } from './stock';
import { dropOpenStocktakesFor } from './stocktake';

/**
 * 把手机上的数据读出来，按所选分类和办公点组装成备份。
 * officeIds 为 null 时是所有办公点。
 */
export async function collectBackup(
  db: SQLiteDatabase,
  scope: readonly BackupScope[] = ALL_SCOPES,
  officeIds: readonly number[] | null = null,
): Promise<BackupData> {
  const [settings, scene, offices, products, packs, batches, movements, devices, accessories, assignments] = await Promise.all([
    getSettings(db),
    getScene(db),
    db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM office ORDER BY sort, id'),
    db.getAllAsync<{
      id: number;
      officeId: number;
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
      `SELECT id, office_id AS officeId, kind, barcode, name, brand, spec, unit, location,
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
      unitPrice: number | null;
      totalPrice: number | null;
    }>(
      `SELECT product_id AS productId, type, delta, expiry_date AS expiryDate, happened_at AS happenedAt, note,
              input_qty AS inputQty, input_unit AS inputUnit, unit_price AS unitPrice, total_price AS totalPrice
         FROM stock_movement ORDER BY id`,
    ),
    db.getAllAsync<{
      id: number;
      officeId: number;
      category: string;
      name: string;
      model: string | null;
      serialNo: string | null;
      quantity: number;
      note: string | null;
      purchaseDate: string | null;
      warrantyUntil: string | null;
      invoiceNo: string | null;
      chip: string | null;
      memory: string | null;
      storage: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      `SELECT id, office_id AS officeId, category, name, model, serial_no AS serialNo, quantity, note,
              purchase_date AS purchaseDate, warranty_until AS warrantyUntil, invoice_no AS invoiceNo,
              chip, memory, storage,
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
    // 场景：库里记着自己是哪个场景的（打开时记上），没记过按当前场景
    { settings, scene: scene ?? currentScene(), offices, products, packs, batches, movements, devices, accessories, assignments },
    new Date(),
    scope,
    officeIds,
  );
}

/** 某个办公点里这次不替换的物品（别的分类的）及其全部条码，用来查条码冲突。 */
async function keptProducts(db: SQLiteDatabase, officeId: number, replacedKinds: string[]): Promise<KeptProduct[]> {
  const rows = await db.getAllAsync<{ id: number; name: string; kind: 'food' | 'daily'; barcode: string | null }>(
    'SELECT id, name, kind, barcode FROM stock_product WHERE office_id = ?',
    [officeId],
  );
  const packs = await db.getAllAsync<{ productId: number; barcode: string }>(
    `SELECT k.product_id AS productId, k.barcode FROM stock_pack k
       JOIN stock_product p ON p.id = k.product_id
      WHERE p.office_id = ? AND k.barcode IS NOT NULL`,
    [officeId],
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

async function insertProduct(db: SQLiteDatabase, officeId: number, product: BackupProduct): Promise<void> {
  const result = await db.runAsync(
    `INSERT INTO stock_product
       (office_id, kind, barcode, name, brand, spec, unit, location, low_stock_threshold, expiry_lead_days, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      officeId,
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
    await db.runAsync('INSERT INTO stock_batch (product_id, quantity, expiry_date, added_on, note) VALUES (?, ?, ?, ?, ?)', [
      productId,
      batch.quantity,
      batch.expiryDate,
      batch.addedOn,
      batch.note,
    ]);
  }
  for (const movement of product.movements) {
    await db.runAsync(
      `INSERT INTO stock_movement
         (product_id, type, delta, expiry_date, happened_at, note, input_qty, input_unit, unit_price, total_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productId,
        movement.type,
        movement.delta,
        movement.expiryDate,
        movement.happenedAt,
        movement.note,
        movement.inputQty,
        movement.inputUnit,
        movement.type === 'in' ? movement.unitPrice : null,
        movement.type === 'in' ? movement.totalPrice : null,
      ],
    );
  }
}

async function insertDevice(db: SQLiteDatabase, officeId: number, device: BackupDevice): Promise<void> {
  const result = await db.runAsync(
    `INSERT INTO device
       (office_id, category, name, model, serial_no, quantity, note, purchase_date, warranty_until, invoice_no,
        chip, memory, storage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      officeId,
      device.category,
      device.name,
      device.model,
      device.serialNo,
      device.quantity,
      device.note,
      device.purchaseDate,
      device.warrantyUntil,
      device.invoiceNo,
      device.chip,
      device.memory,
      device.storage,
      device.createdAt,
      device.updatedAt,
    ],
  );
  const deviceId = result.lastInsertRowId;
  let sort = 0;
  for (const accessory of device.accessories) {
    await db.runAsync('INSERT INTO device_accessory (device_id, name, quantity, sort) VALUES (?, ?, ?, ?)', [
      deviceId,
      accessory.name,
      accessory.quantity,
      sort++,
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

async function deleteProductsOf(db: SQLiteDatabase, officeId: number, kind: string): Promise<void> {
  const owned = 'SELECT id FROM stock_product WHERE office_id = ? AND kind = ?';
  await db.runAsync(`DELETE FROM stock_movement WHERE product_id IN (${owned})`, [officeId, kind]);
  await db.runAsync(`DELETE FROM stock_pack WHERE product_id IN (${owned})`, [officeId, kind]);
  await db.runAsync(`DELETE FROM stock_batch WHERE product_id IN (${owned})`, [officeId, kind]);
  await db.runAsync('DELETE FROM stock_product WHERE office_id = ? AND kind = ?', [officeId, kind]);
}

async function deleteDevicesOf(db: SQLiteDatabase, officeId: number): Promise<void> {
  const owned = 'SELECT id FROM device WHERE office_id = ?';
  await db.runAsync(`DELETE FROM device_assignment WHERE device_id IN (${owned})`, [officeId]);
  await db.runAsync(`DELETE FROM device_accessory WHERE device_id IN (${owned})`, [officeId]);
  await db.runAsync('DELETE FROM device WHERE office_id = ?', [officeId]);
}

/**
 * 新手机导入：本机只有一个地点、名字还是系统起的（「默认办公点」或新装选家庭时的「家」）、里面什么都没有，
 * 文件里又没有这个名字时，把它直接改成文件里的第一个地点，不另建一个，免得留下一个空地点和右上角的切换。
 */
async function adoptUntouchedPlace(db: SQLiteDatabase, incoming: readonly string[]): Promise<void> {
  const offices = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM office');
  if (offices.length !== 1 || !incoming.length) return;
  const [only] = offices;
  if (!DEFAULT_PLACE_NAMES.includes(only.name) || incoming.includes(only.name)) return;
  const used = await db.getFirstAsync<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM stock_product WHERE office_id = ?) + (SELECT COUNT(*) FROM device WHERE office_id = ?) AS n`,
    [only.id, only.id],
  );
  if ((used?.n ?? 0) > 0) return;
  await db.runAsync('UPDATE office SET name = ? WHERE id = ?', [incoming[0], only.id]);
}

async function writeSettings(db: SQLiteDatabase, settings: BackupData['settings']): Promise<void> {
  if (!settings) return;
  // 只换提醒设置；本机的界面状态（比如当前办公点）不动
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    await db.runAsync('DELETE FROM setting WHERE key = ?', [key]);
  }
  for (const [key, value] of Object.entries(settings)) {
    await db.runAsync('INSERT INTO setting (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }
}

export type ImportChoice = {
  /** 要导入的分类（只能是文件里有的） */
  scope: readonly BackupScope[];
  /** 要导入的办公点名称（只能是文件里有的） */
  offices: readonly string[];
};

/**
 * 用备份替换本机「所选办公点 × 所选分类」的数据，其余原样保留；本机没有的办公点按名称新建。
 * 先查条码冲突，再在一个事务里完成，失败就整体回滚。
 */
export async function replaceData(db: SQLiteDatabase, data: BackupData, choice: ImportChoice): Promise<void> {
  const selected = normalizeScope(choice.scope).filter((item) => data.scope.includes(item));
  const kinds = selected.filter((item): item is 'food' | 'daily' => item === 'food' || item === 'daily');
  const withDevices = selected.includes('devices');
  const officeNames = data.offices.filter((name) => choice.offices.includes(name));
  const hasData = kinds.length > 0 || withDevices;
  if (!selected.length || (hasData && !officeNames.length)) throw new Error('没有选要导入的内容');

  // 事务前先查冲突：只涉及本机已有的办公点（新建的办公点里没有东西，不会冲突）
  if (kinds.length) {
    for (const name of officeNames) {
      const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM office WHERE name = ?', [name]);
      if (!existing) continue;
      const incoming = data.products.filter((product) => product.office === name && kinds.includes(product.kind));
      const conflict = findBarcodeConflict(incoming, await keptProducts(db, existing.id, kinds));
      if (conflict) throw new Error(`「${name}」：${conflict}`);
    }
  }

  await db.withTransactionAsync(async () => {
    if (hasData) {
      await adoptUntouchedPlace(db, officeNames);
      for (const name of officeNames) {
        const officeId = await ensureOfficeByName(db, name);
        // 物品、设备要重建（id 会变），这个办公点进行中的盘点对不上了，删掉；已结束的盘点是快照，保留
        await dropOpenStocktakesFor(db, officeId, withDevices ? [...kinds, 'devices'] : kinds);
        for (const kind of kinds) await deleteProductsOf(db, officeId, kind);
        if (withDevices) await deleteDevicesOf(db, officeId);
        for (const product of data.products) {
          if (product.office === name && kinds.includes(product.kind)) await insertProduct(db, officeId, product);
        }
        if (withDevices) {
          for (const device of data.devices) {
            if (device.office === name) await insertDevice(db, officeId, device);
          }
        }
      }
    }
    // 只导到当前场景：文件里的 scene 只用来在导入前提示，不改场景
    if (selected.includes('settings')) await writeSettings(db, data.settings);
  });
}

/**
 * 撤销导入用：把当前场景的库里全部数据（含办公点）换成留底的那一份；场景不变，另一个场景的库不动。
 * 办公点会重建，id 会变，所以把「当前办公点」重置为全部。
 * 盘点记录不在备份里：进行中的全部删掉（物品 id 都变了），已结束的按办公点名称挂到重建的办公点上，
 * 名称对不上的删掉。
 */
export async function restoreAll(db: SQLiteDatabase, data: BackupData): Promise<void> {
  await db.withTransactionAsync(async () => {
    const previousOffices = new Map(
      (await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM office')).map((office) => [
        office.id,
        office.name,
      ]),
    );
    const finishedStocktakes = await db.getAllAsync<{ id: number; officeId: number }>(
      "SELECT id, office_id AS officeId FROM stocktake WHERE status != 'open'",
    );
    await db.execAsync(`
      DELETE FROM stocktake_item WHERE stocktake_id IN (SELECT id FROM stocktake WHERE status = 'open');
      DELETE FROM stocktake WHERE status = 'open';
      DELETE FROM stock_movement;
      DELETE FROM stock_pack;
      DELETE FROM stock_batch;
      DELETE FROM stock_product;
      DELETE FROM device_assignment;
      DELETE FROM device_accessory;
      DELETE FROM device;
      DELETE FROM office;
      DELETE FROM setting WHERE key = 'ui.currentOfficeId';
    `);
    const names = data.offices.length ? data.offices : ['默认办公点'];
    const ids = new Map<string, number>();
    let sort = 0;
    for (const name of names) {
      const result = await db.runAsync('INSERT INTO office (name, sort, created_at) VALUES (?, ?, ?)', [
        name,
        sort++,
        new Date().toISOString(),
      ]);
      ids.set(name, result.lastInsertRowId);
    }
    const fallback = ids.get(names[0]) ?? 1;
    for (const product of data.products) await insertProduct(db, ids.get(product.office) ?? fallback, product);
    for (const device of data.devices) await insertDevice(db, ids.get(device.office) ?? fallback, device);
    for (const stocktake of finishedStocktakes) {
      const officeName = previousOffices.get(stocktake.officeId);
      const newOfficeId = officeName === undefined ? undefined : ids.get(officeName);
      if (newOfficeId === undefined) {
        await db.runAsync('DELETE FROM stocktake_item WHERE stocktake_id = ?', [stocktake.id]);
        await db.runAsync('DELETE FROM stocktake WHERE id = ?', [stocktake.id]);
      } else {
        await db.runAsync('UPDATE stocktake SET office_id = ? WHERE id = ?', [newOfficeId, stocktake.id]);
      }
    }
    await writeSettings(db, data.settings);
  });
}
