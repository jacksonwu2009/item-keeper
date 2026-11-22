/**
 * 出库指定从哪一批出（从联网版搬过来的同一套规则）、出库记录的说明（原因 + 备注）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SQLiteDatabase } from 'expo-sqlite';

import { createProduct, listBatches, listMovements, stockIn, stockOut, type StockProductInput } from '../src/db/stock';
import {
  allocationError,
  defaultAllocation,
  earliestBatch,
  isDefaultAllocation,
  outNote,
  planAllocatedConsumption,
  skipsEarliestBatch,
} from '../src/lib/stock';
import { openDb } from './helpers/memoryDb';

const A = { id: 1, quantity: 5, expiryDate: '2027-01-31' };
const B = { id: 2, quantity: 5, expiryDate: '2027-03-31' };
const C = { id: 3, quantity: 5, expiryDate: null };

const cola: StockProductInput = {
  officeId: 1,
  kind: 'food',
  barcode: null,
  name: '可乐',
  brand: null,
  spec: null,
  unit: '瓶',
  location: null,
  lowStockThreshold: null,
  expiryLeadDays: null,
  note: null,
  packs: [],
};

/** 可乐三批 2027-01-31 ×5、2027-03-31 ×5、不记过期日期 ×5 */
async function threeBatches(db: SQLiteDatabase): Promise<number> {
  const id = await createProduct(db, cola, { quantity: 5, expiryDate: '2027-01-31' });
  await stockIn(db, id, { quantity: 5, expiryDate: '2027-03-31' });
  await stockIn(db, id, { quantity: 5, expiryDate: null });
  return id;
}

async function batchesOf(db: SQLiteDatabase, productId: number) {
  return (await listBatches(db, productId)).map((batch) => [batch.expiryDate, batch.quantity]);
}

async function batchIdByExpiry(db: SQLiteDatabase, productId: number, expiryDate: string | null): Promise<number> {
  const found = (await listBatches(db, productId)).find((batch) => batch.expiryDate === expiryDate);
  assert.ok(found, `没有 ${expiryDate} 那一批`);
  return found.id;
}

describe('指定批次：纯函数', () => {
  it('默认分配按先到期先出；和默认一样的分配视为没指定', () => {
    assert.deepEqual(defaultAllocation([C, B, A], 7), [
      { batchId: 1, quantity: 5 },
      { batchId: 2, quantity: 2 },
    ]);
    assert.equal(isDefaultAllocation([A, B, C], 7, [{ batchId: 2, quantity: 2 }, { batchId: 1, quantity: 5 }, { batchId: 3, quantity: 0 }]), true);
    assert.equal(isDefaultAllocation([A, B, C], 7, [{ batchId: 2, quantity: 5 }, { batchId: 1, quantity: 2 }]), false);
  });

  it('先扣指定的批次，指定的不够时差的按先到期补', () => {
    const plan = planAllocatedConsumption([A, { ...B, quantity: 2 }, C], 6, [
      { batchId: 2, quantity: 4 },
      { batchId: 3, quantity: 2 },
    ]);
    assert.deepEqual([plan.allocated, plan.fallback, plan.consumed, plan.shortfall], [4, 2, 6, 0]);
    assert.deepEqual(plan.updates, [
      { id: 1, quantity: 3 },
      { id: 2, quantity: 0 },
      { id: 3, quantity: 3 },
    ]);
  });

  it('核对：每批不超过现有、合计等于要出的', () => {
    assert.equal(allocationError([A, B], 6, [{ batchId: 2, quantity: 6 }]), '2027-03-31 到期的那一批只有 5');
    assert.equal(allocationError([A, B], 6, [{ batchId: 2, quantity: 4 }]), '还差 2 没分到批次');
    assert.equal(allocationError([A, B], 6, [{ batchId: 2, quantity: 5 }, { batchId: 1, quantity: 2 }]), '多分了 1');
    assert.equal(allocationError([A, B], 6, [{ batchId: 2, quantity: 5 }, { batchId: 1, quantity: 1 }]), null);
  });

  it('「最早一批」提示；最早一批还有剩却用了后面的批次时提醒', () => {
    assert.equal(earliestBatch([C, B, A])?.id, 1);
    assert.equal(earliestBatch([C]), null);
    assert.equal(skipsEarliestBatch([A, B], [{ batchId: 2, quantity: 3 }]), true);
    assert.equal(skipsEarliestBatch([A, B], [{ batchId: 1, quantity: 5 }, { batchId: 2, quantity: 1 }]), false);
  });
});

describe('指定批次：出库', () => {
  it('先扣指定的批次；超过那一批现有的不让出', async () => {
    const db = await openDb();
    const id = await threeBatches(db);
    const march = await batchIdByExpiry(db, id, '2027-03-31');
    const none = await batchIdByExpiry(db, id, null);
    await stockOut(db, id, 6, '用掉', null, [
      { batchId: march, quantity: 4 },
      { batchId: none, quantity: 2 },
    ]);
    assert.deepEqual(await batchesOf(db, id), [
      ['2027-01-31', 5],
      ['2027-03-31', 1],
      [null, 3],
    ]);
    assert.equal((await listMovements(db, id))[0].delta, -6);
    await assert.rejects(stockOut(db, id, 2, '用掉', null, [{ batchId: march, quantity: 2 }]), /只有 1/);
  });

  it('不指定照旧先到期先出', async () => {
    const db = await openDb();
    const id = await threeBatches(db);
    await stockOut(db, id, 7, '用掉');
    assert.deepEqual(await batchesOf(db, id), [
      ['2027-03-31', 3],
      [null, 5],
    ]);
  });
});

describe('出库记录的说明', () => {
  it('原因后面跟上备注；备注空着就只有原因', () => {
    assert.equal(outNote('用掉', ' 年会用 '), '用掉，年会用');
    assert.equal(outNote('送人', '   '), '送人');
  });

  it('备注跟着出库记录存下来', async () => {
    const db = await openDb();
    const id = await threeBatches(db);
    await stockOut(db, id, 1, outNote('送人', '给邻居'));
    assert.equal((await listMovements(db, id))[0].note, '送人，给邻居');
  });
});
