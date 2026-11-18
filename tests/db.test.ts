/**
 * 数据层端到端测试：用 Node 自带的 SQLite 模拟 expo-sqlite 的异步接口，
 * 跑真实的建表迁移和 src/db 下的读写函数，验证 SQL 本身是对的。
 */
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';

import type { SQLiteDatabase } from 'expo-sqlite';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import { createDevice, issueDevice, listActiveAssignments, listDevices, returnDevice } from '../src/db/devices';
import { createOffice, deleteOffice, listOffices } from '../src/db/offices';
import { migrateDbIfNeeded } from '../src/db/schema';
import {
  createProduct,
  findByBarcode,
  listBatches,
  listMovements,
  listProducts,
  stockIn,
  stockOut,
  type StockProductInput,
} from '../src/db/stock';

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function openDb(): Promise<SQLiteDatabase> {
  const raw = new DatabaseSync(':memory:');
  const params = (values: unknown[] = []) => values as SQLInputValue[];
  const db = {
    async execAsync(sql: string) {
      raw.exec(sql);
    },
    async runAsync(sql: string, values?: unknown[]) {
      const result = raw.prepare(sql).run(...params(values));
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async getAllAsync(sql: string, values?: unknown[]) {
      return plain(raw.prepare(sql).all(...params(values)));
    },
    async getFirstAsync(sql: string, values?: unknown[]) {
      const row = raw.prepare(sql).get(...params(values));
      return row ? plain(row) : null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as SQLiteDatabase;
  await migrateDbIfNeeded(db);
  return db;
}

function product(overrides: Partial<StockProductInput>): StockProductInput {
  return {
    officeId: 1,
    kind: 'food',
    barcode: null,
    name: '可乐',
    brand: null,
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
    const packs = [{ unit: '箱', size: 24, barcode: '1690' }];
    await createProduct(db, product({ barcode: '690', packs }), null);
    await createProduct(db, product({ officeId: shanghai, barcode: '690', packs }), null);
    await assert.rejects(createProduct(db, product({ name: '雪碧', barcode: '1690' }), null), /已经给「可乐」的箱用了/);
    const match = await findByBarcode(db, '1690', shanghai);
    assert.equal(match?.product.officeId, shanghai);
    assert.equal(match?.pack?.unit, '箱');
    assert.equal((await listProducts(db, 'food', shanghai)).length, 1);
    assert.equal((await listProducts(db, 'food', null)).length, 2);
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
      accessories: [{ name: '充电器', quantity: 1 }],
    });
    await issueDevice(db, deviceId, { person: '张三', quantity: 2, issuedOn: '2026-10-02', returnedOn: null, note: null });
    const [active] = await listActiveAssignments(db, 1);
    await returnDevice(db, active.id, '2026-11-01', 1);
    const [device] = await listDevices(db, 1);
    assert.equal(device.outQty, 1);
    assert.equal(device.warrantyUntil, '2027-09-30');
    assert.equal((await listDevices(db, 99)).length, 0);
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
    await createProduct(db, product({ barcode: '690' }), { quantity: 12, expiryDate: '2027-01-31' });
    await createProduct(db, product({ kind: 'daily', name: '抽纸', unit: '包', barcode: '777' }), {
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
    await createProduct(hq, product({ name: '总部的咖啡', barcode: '690' }), { quantity: 2, expiryDate: null });
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
    await createProduct(hq, product({ kind: 'daily', name: '洗衣液', barcode: '690' }), { quantity: 1, expiryDate: null });
    await assert.rejects(
      replaceData(hq, file, { scope: ['food'], offices: ['北京'] }),
      /「北京」：条码 690 在备份的「可乐」和手机上日用品里的「洗衣液」重复/,
    );
    assert.equal((await listProducts(hq, 'food', 1)).length, 0);
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
