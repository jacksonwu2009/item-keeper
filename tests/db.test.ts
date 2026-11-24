/**
 * 数据层端到端测试：用 Node 自带的 SQLite 模拟 expo-sqlite 的异步接口，
 * 跑真实的建表迁移和 src/db 下的读写函数，验证 SQL 本身是对的。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SQLiteDatabase } from 'expo-sqlite';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import {
  createDevice,
  findDeviceBySerial,
  issueDevice,
  listActiveAssignments,
  listDevices,
  listDeviceTemplates,
  returnDevice,
} from '../src/db/devices';
import { migrateDbIfNeeded, splitLegacyDeviceModels } from '../src/db/schema';
import { getDataSince, getLastExportAt, getSettings, setLastExportAt } from '../src/db/settings';
import { createOffice, deleteOffice, listOffices } from '../src/db/offices';
import {
  createProduct,
  findByBarcode,
  getLastPurchasePrice,
  getLastStockIn,
  getProduct,
  productShelfLife,
  updateMovementPrice,
  updateProduct,
  listBatches,
  listMovements,
  listProducts,
  stockIn,
  stockOut,
  type StockProductInput,
} from '../src/db/stock';
import { openDb, openRawDb, plain } from './helpers/memoryDb';


function product(overrides: Partial<StockProductInput>): StockProductInput {
  return {
    officeId: 1,
    kind: 'food',
    barcode: null,
    name: '可乐',
    category: null,
    spec: null,
    unit: '瓶',
    location: null,
    lowStockThreshold: 6,
    expiryLeadDays: null,
    note: null,
    packs: [],
    ...overrides,
  };
}

describe('数据层（真实 SQLite）', () => {
  it('新装时建好默认办公点', async () => {
    const db = await openDb();
    assert.deepEqual(
      (await listOffices(db)).map((office) => office.name),
      ['默认办公点'],
    );
  });

  it('同一条码可以在不同办公点各录一份，同一办公点里不行；扫箱码能认出物品', async () => {
    const db = await openDb();
    const shanghai = await createOffice(db, '上海');
    const packs = [{ unit: '箱', size: 24, barcode: '16901234567899' }];
    await createProduct(db, product({ barcode: '6901234567892', packs }), null);
    await createProduct(db, product({ officeId: shanghai, barcode: '6901234567892', packs }), null);
    await assert.rejects(createProduct(db, product({ name: '雪碧', barcode: '16901234567899' }), null), /已经给「可乐」的箱用了/);
    const match = await findByBarcode(db, '16901234567899', shanghai);
    assert.equal(match?.product.officeId, shanghai);
    assert.equal(match?.pack?.unit, '箱');
    assert.equal((await listProducts(db, 'food', shanghai)).length, 1);
    assert.equal((await listProducts(db, 'food', null)).length, 2);
  });

  it('条码只能是 8–14 位数字：新建、修改都拦下（包装条码也一样），可以不填；老数据清空或改成数字就能存', async () => {
    const db = await openDb();
    await assert.rejects(createProduct(db, product({ barcode: '测试' }), null), /条码只能是 8–14 位数字/);
    await assert.rejects(createProduct(db, product({ barcode: '690' }), null), /条码只能是 8–14 位数字/);
    await assert.rejects(
      createProduct(db, product({ barcode: '6901234567892', packs: [{ unit: '箱', size: 24, barcode: 'BOX-1' }] }), null),
      /条码只能是 8–14 位数字/,
    );
    assert.equal((await listProducts(db, 'food', null)).length, 0);

    const id = await createProduct(db, product({ barcode: null }), null);
    // 改规则以前存进来的不合规条码：照常能读、能按它找到
    await db.runAsync("UPDATE stock_product SET barcode = '测试' WHERE id = ?", [id]);
    assert.equal((await getProduct(db, id))?.barcode, '测试');
    assert.equal((await findByBarcode(db, '测试', 1))?.product.id, id);
    await assert.rejects(updateProduct(db, id, product({ barcode: '测试' })), /条码只能是 8–14 位数字/);
    await updateProduct(db, id, product({ barcode: null }));
    assert.equal((await getProduct(db, id))?.barcode, null);
    await updateProduct(db, id, product({ barcode: '96385074', packs: [{ unit: '箱', size: 24, barcode: '16901234567899' }] }));
    assert.equal((await getProduct(db, id))?.barcode, '96385074');
  });

  it('整箱入库、按瓶出库：先扣先到期的，流水记下按什么单位', async () => {
    const db = await openDb();
    const id = await createProduct(db, product({ packs: [{ unit: '箱', size: 24, barcode: null }] }), {
      quantity: 24,
      expiryDate: '2027-01-31',
      entry: { qty: 1, unit: '箱' },
    });
    await stockIn(db, id, { quantity: 6, expiryDate: '2026-12-31', entry: { qty: 6, unit: '瓶' } });
    const result = await stockOut(db, id, 8, '用掉', { qty: 8, unit: '瓶' });
    assert.deepEqual(result, { consumed: 8, shortfall: 0 });
    assert.deepEqual(
      (await listBatches(db, id)).map((batch) => [batch.expiryDate, batch.quantity]),
      [['2027-01-31', 22]],
    );
    const movements = await listMovements(db, id);
    assert.deepEqual(
      movements.map((movement) => [movement.type, movement.delta, movement.inputQty, movement.inputUnit]),
      [
        ['out', -8, 8, '瓶'],
        ['in', 6, 6, '瓶'],
        ['in', 24, 1, '箱'],
      ],
    );
  });

  it('设备：配件、部分退还、按办公点列出', async () => {
    const db = await openDb();
    const deviceId = await createDevice(db, {
      officeId: 1,
      category: '笔记本',
      name: 'MacBook',
      model: null,
      serialNo: null,
      quantity: 2,
      note: null,
      purchaseDate: '2026-10-01',
      warrantyUntil: '2027-09-30',
      invoiceNo: ' 044031900111 ',
      accessories: [{ name: '充电器', quantity: 1 }],
    });
    await issueDevice(db, deviceId, { person: '张三', quantity: 2, issuedOn: '2026-10-02', returnedOn: null, note: null });
    const [active] = await listActiveAssignments(db, 1);
    await returnDevice(db, active.id, '2026-11-01', 1);
    const [device] = await listDevices(db, 1);
    assert.equal(device.outQty, 1);
    assert.equal(device.warrantyUntil, '2027-09-30');
    assert.equal(device.invoiceNo, '044031900111');
    assert.equal((await listDevices(db, 99)).length, 0);
  });

  it('电脑配置分开存；按序列号找（不管大小写）；登记过的组合按次数排', async () => {
    const db = await openDb();
    const macbook = {
      officeId: 1,
      category: '笔记本',
      name: 'MacBook Pro 14 英寸',
      model: null,
      serialNo: 'C02ABC',
      quantity: 1,
      note: null,
      purchaseDate: null,
      warrantyUntil: null,
      invoiceNo: null,
      chip: 'M3 Pro',
      memory: '18G',
      storage: '512G',
      accessories: [{ name: '电源适配器', quantity: 1 }],
    };
    await createDevice(db, macbook);
    await createDevice(db, { ...macbook, serialNo: 'C02DEF' });
    await createDevice(db, { ...macbook, category: '显示器', name: 'Studio Display', serialNo: null, chip: null, memory: null, storage: null });

    const found = await findDeviceBySerial(db, ' c02def ');
    assert.deepEqual(found && [found.serialNo, found.chip, found.memory, found.storage], ['C02DEF', 'M3 Pro', '18G', '512G']);
    assert.equal(await findDeviceBySerial(db, 'C02DEF', 99), null);
    assert.equal(await findDeviceBySerial(db, ''), null);

    const templates = await listDeviceTemplates(db);
    assert.deepEqual(
      templates.map((template) => [template.name, template.uses, template.chip]),
      [
        ['MacBook Pro 14 英寸', 2, 'M3 Pro'],
        ['Studio Display', 1, null],
      ],
    );
    assert.deepEqual(templates[0].accessories, [{ name: '电源适配器', quantity: 1 }]);
  });

  it('升级时把型号里的芯片、内存、硬盘拆出来，只拆电脑、认不出的不动', async () => {
    const db = await openDb();
    const insert = (category: string, model: string) =>
      db.runAsync(
        `INSERT INTO device (office_id, category, name, model, quantity, created_at, updated_at)
         VALUES (1, ?, 'x', ?, 1, '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')`,
        [category, model],
      );
    await insert('笔记本', 'M3 Pro 18G/512G');
    await insert('台式机', 'MRX33CH/A M2 16G/1T');
    await insert('笔记本', 'ThinkPad X1');
    await insert('显示器', 'M1 8G/256G');
    assert.equal(await splitLegacyDeviceModels(db), 2);
    const rows = await db.getAllAsync<{ model: string | null; chip: string | null; memory: string | null; storage: string | null }>(
      'SELECT model, chip, memory, storage FROM device ORDER BY id',
    );
    assert.deepEqual(rows, [
      { model: null, chip: 'M3 Pro', memory: '18G', storage: '512G' },
      { model: 'MRX33CH/A', chip: 'M2', memory: '16G', storage: '1T' },
      { model: 'ThinkPad X1', chip: null, memory: null, storage: null },
      { model: 'M1 8G/256G', chip: null, memory: null, storage: null },
    ]);
  });

  it('入库价格记在每条入库记录上，下次默认用上一次的价', async () => {
    const db = await openDb();
    const id = await createProduct(db, product({ packs: [{ unit: '箱', size: 24, barcode: null }] }), {
      quantity: 48,
      expiryDate: '2027-01-31',
      entry: { qty: 2, unit: '箱' },
      price: { unitPrice: 48, totalPrice: 96 },
    });
    let last = await getLastPurchasePrice(db, id);
    assert.deepEqual(last && [last.perBaseUnit, last.unitPrice, last.unit], [2, 48, '箱']);

    // 这次涨价，按瓶进；同一过期日期合并到原批次，但价格各记各的
    await stockIn(db, id, {
      quantity: 6,
      expiryDate: '2027-01-31',
      entry: { qty: 6, unit: '瓶' },
      price: { unitPrice: 2.5, totalPrice: 15 },
    });
    // 没填价格的入库、出库不影响「上次进价」
    await stockIn(db, id, { quantity: 1, expiryDate: null, entry: { qty: 1, unit: '瓶' } });
    await stockOut(db, id, 3, '用掉', { qty: 3, unit: '瓶' });
    last = await getLastPurchasePrice(db, id);
    assert.deepEqual(last && [last.perBaseUnit, last.unitPrice, last.unit], [2.5, 2.5, '瓶']);

    const movements = await listMovements(db, id);
    assert.deepEqual(
      movements.map((movement) => [movement.type, movement.delta, movement.unitPrice, movement.totalPrice]),
      [
        ['out', -3, null, null],
        ['in', 1, null, null],
        ['in', 6, 2.5, 15],
        ['in', 48, 48, 96],
      ],
    );
    assert.equal(await getLastPurchasePrice(db, 999), null);
  });

  it('最近一次入库带出过期日期；入库记录能改价格（单价、总价、清掉），出库记录不能', async () => {
    const db = await openDb();
    const id = await createProduct(db, product({ packs: [{ unit: '箱', size: 24, barcode: null }] }), {
      quantity: 24,
      expiryDate: '2027-01-31',
      entry: { qty: 1, unit: '箱' },
      price: { unitPrice: 48, totalPrice: 48 },
    });
    assert.equal((await getLastStockIn(db, 999)), null);
    let last = await getLastStockIn(db, id);
    assert.deepEqual(last && [last.expiryDate, last.inputQty, last.inputUnit, last.unitPrice], ['2027-01-31', 1, '箱', 48]);
    // 出库不算入库；再入一次没记过期日期的，最近一次就是它
    await stockOut(db, id, 2, '用掉');
    await stockIn(db, id, { quantity: 6, expiryDate: null, entry: { qty: 6, unit: '瓶' } });
    last = await getLastStockIn(db, id);
    assert.deepEqual(last && [last.delta, last.expiryDate, last.unitPrice], [6, null, null]);

    // 补上价格：单价按 4 位、总价按 2 位存
    await updateMovementPrice(db, last!.id, { unitPrice: 2.33333, totalPrice: 13.999 });
    last = await getLastStockIn(db, id);
    assert.deepEqual(last && [last.unitPrice, last.totalPrice], [2.33, 14]);
    assert.deepEqual((await getLastPurchasePrice(db, id))?.unitPrice, 2.33);
    // 清掉价格
    await updateMovementPrice(db, last!.id, null);
    last = await getLastStockIn(db, id);
    assert.deepEqual(last && [last.unitPrice, last.totalPrice], [null, null]);

    const out = (await listMovements(db, id)).find((movement) => movement.type === 'out');
    await assert.rejects(updateMovementPrice(db, out!.id, { unitPrice: 1, totalPrice: 2 }), /只有入库记录能改价格/);
    await assert.rejects(updateMovementPrice(db, 999, null), /不存在/);
  });

  it('入库按「生产日期+保质期」填：商品资料里没有保质期就记进去，有了不改', async () => {
    const db = await openDb();
    const id = await createProduct(db, product({}), null);
    await stockIn(db, id, { quantity: 1, expiryDate: '2027-06-30', shelfLife: { amount: 180, unit: 'day' } });
    assert.deepEqual(productShelfLife((await getProduct(db, id))!), { amount: 180, unit: 'day' });
    // 这一批的保质期不一样：商品资料里的不跟着改
    await stockIn(db, id, { quantity: 1, expiryDate: '2027-07-30', shelfLife: { amount: 12, unit: 'month' } });
    assert.deepEqual(productShelfLife((await getProduct(db, id))!), { amount: 180, unit: 'day' });
    // 不合理的保质期不记
    const other = await createProduct(db, product({ name: '雪碧' }), null);
    await stockIn(db, other, { quantity: 1, expiryDate: '2027-06-30', shelfLife: { amount: 0, unit: 'day' } });
    assert.equal(productShelfLife((await getProduct(db, other))!), null);
  });

  it('备份提醒：上次导出时间只在本机，导入别人的设置不会改它；最早录入时间', async () => {
    const db = await openDb();
    assert.equal(await getDataSince(db), null);
    assert.equal(await getLastExportAt(db), null);
    assert.equal((await getSettings(db)).backupReminderDays, 60);
    await createProduct(db, product({}), null);
    assert.match((await getDataSince(db)) ?? '', /^\d{4}-\d{2}-\d{2}T/);
    await setLastExportAt(db, '2026-11-18T07:00:00.000Z');
    const file = await collectBackup(db);
    assert.equal(JSON.stringify(file).includes('lastExportAt'), false);
    await replaceData(db, { ...file, settings: { ...file.settings, backupReminderDays: 30 } }, {
      scope: ['settings'],
      offices: [],
    });
    assert.equal((await getSettings(db)).backupReminderDays, 30);
    assert.equal(await getLastExportAt(db), '2026-11-18T07:00:00.000Z');
  });

  it('只能删空的办公点', async () => {
    const db = await openDb();
    const shanghai = await createOffice(db, '上海');
    await createProduct(db, product({ officeId: shanghai }), null);
    await assert.rejects(deleteOffice(db, shanghai), /里还有 1 样物品/);
    await assert.rejects(createOffice(db, '上海'), /已经有叫「上海」/);
  });
});

describe('手机之间按办公点传数据（真实 SQLite）', () => {
  /** 一台记北京的手机：北京有食品和设备 */
  async function beijingPhone() {
    const db = await openDb();
    await db.runAsync("UPDATE office SET name = '北京' WHERE id = 1");
    await createProduct(db, product({ barcode: '6901234567892' }), {
      quantity: 12,
      expiryDate: '2027-01-31',
      entry: { qty: 12, unit: '瓶' },
      price: { unitPrice: 3, totalPrice: 36 },
    });
    await createProduct(db, product({ kind: 'daily', name: '抽纸', unit: '包', barcode: '6907777777770' }), {
      quantity: 10,
      expiryDate: null,
    });
    await createDevice(db, {
      officeId: 1,
      category: '显示器',
      name: 'U2723QE',
      model: null,
      serialNo: null,
      quantity: 3,
      note: null,
      purchaseDate: null,
      warrantyUntil: null,
      invoiceNo: 'FP-2026-001',
      accessories: [{ name: '电源线', quantity: 1 }],
    });
    return db;
  }

  it('汇总手机导入北京的食品：新建北京办公点，自己的办公点不受影响', async () => {
    const source = await beijingPhone();
    const file = await collectBackup(source, ['food'], [1]);
    assert.deepEqual(file.offices, ['北京']);

    const hq = await openDb();
    await renameFirstOffice(hq, '总部');
    await createProduct(hq, product({ name: '总部的咖啡', barcode: '6901234567892' }), { quantity: 2, expiryDate: null });
    await replaceData(hq, file, { scope: ['food'], offices: ['北京'] });

    const offices = await listOffices(hq);
    assert.deepEqual(
      offices.map((office) => [office.name, office.productCount]),
      [
        ['总部', 1],
        ['北京', 1],
      ],
    );
    const beijing = offices.find((office) => office.name === '北京')!;
    const [cola] = await listProducts(hq, 'food', beijing.id);
    assert.equal(cola.name, '可乐');
    assert.equal(cola.totalQty, 12);
    assert.deepEqual(
      (await listMovements(hq, cola.id)).map((movement) => [movement.unitPrice, movement.totalPrice]),
      [[3, 36]],
    );
    assert.equal((await getLastPurchasePrice(hq, cola.id))?.perBaseUnit, 3);
    assert.equal((await listProducts(hq, 'food', 1))[0].name, '总部的咖啡');
  });

  it('再导入一次只替换北京那一类，不会重复', async () => {
    const source = await beijingPhone();
    const hq = await openDb();
    const everything = await collectBackup(source);
    await replaceData(hq, everything, { scope: ['food', 'daily', 'devices'], offices: ['北京'] });
    await stockOut(source, 1, 2, '用掉');
    const foodOnly = await collectBackup(source, ['food'], [1]);
    await replaceData(hq, foodOnly, { scope: ['food'], offices: ['北京'] });

    const beijing = (await listOffices(hq)).find((office) => office.name === '北京')!;
    const food = await listProducts(hq, 'food', beijing.id);
    assert.equal(food.length, 1);
    assert.equal(food[0].totalQty, 10);
    assert.equal((await listProducts(hq, 'daily', beijing.id)).length, 1);
    assert.equal((await listDevices(hq, beijing.id)).length, 1);
  });

  it('导入的条码和同一办公点里保留的物品撞了就整份不导，数据不动', async () => {
    const source = await beijingPhone();
    const file = await collectBackup(source, ['food'], [1]);
    const hq = await openDb();
    await renameFirstOffice(hq, '北京');
    await createProduct(hq, product({ kind: 'daily', name: '洗衣液', barcode: '6901234567892' }), { quantity: 1, expiryDate: null });
    await assert.rejects(
      replaceData(hq, file, { scope: ['food'], offices: ['北京'] }),
      /「北京」：条码 6901234567892 在备份的「可乐」和手机上日用品里的「洗衣液」重复/,
    );
    assert.equal((await listProducts(hq, 'food', 1)).length, 0);
  });

  it('商品的保质期：新建时记下，改资料不给就不动、给 null 清空，随备份往返', async () => {
    const db = await openDb();
    const id = await createProduct(db, product({ shelfLife: { amount: 12, unit: 'month' } }), null);
    assert.deepEqual(productShelfLife((await getProduct(db, id))!), { amount: 12, unit: 'month' });

    await updateProduct(db, id, product({ name: '可乐（大瓶）' }));
    assert.deepEqual(productShelfLife((await getProduct(db, id))!), { amount: 12, unit: 'month' });

    const file = JSON.parse(JSON.stringify(await collectBackup(db)));
    assert.equal(file.products[0].shelfLifeAmount, 12);
    assert.equal(file.products[0].shelfLifeUnit, 'month');
    const restored = await openDb();
    await replaceData(restored, file, { scope: ['food'], offices: file.offices });
    const [copy] = await listProducts(restored, 'food', null);
    assert.deepEqual(productShelfLife(copy), { amount: 12, unit: 'month' });

    await updateProduct(db, id, product({ shelfLife: null }));
    const cleared = (await getProduct(db, id))!;
    assert.equal(productShelfLife(cleared), null);
    assert.equal(cleared.shelfLifeAmount, null);
    // 不合理的当没填
    const odd = await createProduct(db, product({ name: '雪碧', shelfLife: { amount: 0, unit: 'month' } }), null);
    assert.equal(productShelfLife((await getProduct(db, odd))!), null);
  });

  it('分类：新建、修改、清空都存得上，随备份往返', async () => {
    const db = await openDb();
    const id = await createProduct(db, product({ category: '饮料冲调' }), null);
    assert.equal((await getProduct(db, id))?.category, '饮料冲调');
    await updateProduct(db, id, product({ category: '零食' }));
    assert.equal((await listProducts(db, 'food', null))[0].category, '零食');

    const file = JSON.parse(JSON.stringify(await collectBackup(db)));
    assert.equal(file.products[0].category, '零食');
    const restored = await openDb();
    await replaceData(restored, file, { scope: ['food'], offices: file.offices });
    assert.equal((await listProducts(restored, 'food', null))[0].category, '零食');

    await updateProduct(db, id, product({ category: null }));
    assert.equal((await getProduct(db, id))?.category, null);
  });

  it('升级到 v13：加上分类、删掉品牌列，别的列和数据都在', async () => {
    const db = openRawDb();
    await migrateDbIfNeeded(db);
    // 退回 v12 的样子：有 brand、没有 category
    await db.execAsync(`
      ALTER TABLE stock_product DROP COLUMN category;
      ALTER TABLE stock_product ADD COLUMN brand TEXT;
      PRAGMA user_version = 12;
    `);
    await db.runAsync(
      `INSERT INTO stock_product
         (office_id, kind, barcode, name, brand, spec, unit, location, low_stock_threshold, expiry_lead_days, note,
          created_at, updated_at, shelf_life_amount, shelf_life_unit)
       VALUES (1, 'food', '690', '矿泉水', '某牌', '550ml', '瓶', '储物柜', 6, 3, '备注', '2026-11-01', '2026-11-02', 12, 'month')`,
    );
    const productId = (await db.getFirstAsync<{ id: number }>('SELECT id FROM stock_product'))!.id;
    await db.runAsync("INSERT INTO stock_pack (product_id, unit, size, barcode, sort) VALUES (?, '箱', 12, '1690', 0)", [productId]);
    await db.runAsync("INSERT INTO stock_batch (product_id, quantity, expiry_date, added_on) VALUES (?, 12, '2027-01-01', '2026-11-02')", [
      productId,
    ]);

    await migrateDbIfNeeded(db);

    assert.deepEqual(await db.getFirstAsync('PRAGMA user_version'), { user_version: 13 });
    const columns = (await db.getAllAsync<{ name: string }>('PRAGMA table_info(stock_product)')).map((column) => column.name);
    assert.equal(columns.includes('brand'), false);
    assert.equal(columns.includes('category'), true);
    const migrated = (await getProduct(db, productId))!;
    assert.deepEqual(
      [migrated.name, migrated.barcode, migrated.spec, migrated.unit, migrated.location, migrated.lowStockThreshold, migrated.expiryLeadDays],
      ['矿泉水', '690', '550ml', '瓶', '储物柜', 6, 3],
    );
    assert.deepEqual([migrated.note, migrated.category, migrated.createdAt, migrated.updatedAt], ['备注', null, '2026-11-01', '2026-11-02']);
    assert.deepEqual(productShelfLife(migrated), { amount: 12, unit: 'month' });
    assert.equal((await findByBarcode(db, '1690', 1))?.product.id, productId);
    assert.equal((await listBatches(db, productId))[0].quantity, 12);
    // 再跑一次不出错
    await migrateDbIfNeeded(db);
  });

  it('设备的发票号随备份导入', async () => {
    const source = await beijingPhone();
    const hq = await openDb();
    await replaceData(hq, await collectBackup(source, ['devices'], [1]), { scope: ['devices'], offices: ['北京'] });
    const beijing = (await listOffices(hq)).find((office) => office.name === '北京')!;
    const [monitor] = await listDevices(hq, beijing.id);
    assert.equal(monitor.invoiceNo, 'FP-2026-001');
  });

  it('撤销：换回导入前的全部数据（含办公点）', async () => {
    const hq = await beijingPhone();
    const before = plain(await collectBackup(hq));
    const other = await openDb();
    await createProduct(other, product({ name: '别处的东西' }), null);
    await replaceData(hq, await collectBackup(other), {
      scope: ['food', 'daily', 'devices', 'settings'],
      offices: ['默认办公点'],
    });
    assert.equal((await listOffices(hq)).length, 2);

    await restoreAll(hq, before);
    const after = plain(await collectBackup(hq));
    assert.deepEqual({ ...after, exportedAt: '' }, { ...before, exportedAt: '' });
  });
});

async function renameFirstOffice(db: SQLiteDatabase, name: string) {
  await db.runAsync('UPDATE office SET name = ? WHERE id = 1', [name]);
}
