/**
 * 盘点页、盘点列表少读数据以后结果不变：
 * - 记完一项只重读这一项（getStocktakeItem），读到的和整张单里的那一项一样；
 * - 盘点列表的计数在数据库里按单汇总，和把所有项读出来用 summarizeCounts 算的一样（随机造数据，含 .005 这种临界的差异）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOffice } from '../src/db/offices';
import { createProduct, type StockProductInput } from '../src/db/stock';
import {
  clearCount,
  getStocktakeItem,
  listStocktakeItems,
  listStocktakes,
  recordCount,
  startStocktake,
} from '../src/db/stocktake';
import { summarizeCounts } from '../src/lib/stocktake';
import { openDb } from './helpers/memoryDb';

function product(officeId: number, index: number): StockProductInput {
  return {
    officeId,
    kind: index % 3 === 0 ? 'daily' : 'food',
    barcode: null,
    name: `物品${index}`,
    category: null,
    spec: null,
    unit: '个',
    location: null,
    lowStockThreshold: null,
    expiryLeadDays: null,
    note: null,
    packs: [],
  };
}

/** 固定种子的伪随机数，失败时能复现 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('盘点只重读一项、列表按单汇总', () => {
  it('记数、改回未盘以后，单读的这一项和整张单里的那一项一样', async () => {
    const db = await openDb();
    for (let index = 0; index < 12; index++) {
      await createProduct(db, product(1, index), index % 4 === 0 ? null : { quantity: index + 0.5, expiryDate: '2027-01-01' });
    }
    const stocktakeId = await startStocktake(db, 1, ['food', 'daily']);
    const items = await listStocktakeItems(db, stocktakeId);
    await recordCount(db, items[0].id, 3);
    await recordCount(db, items[1].id, items[1].bookQty);
    await recordCount(db, items[2].id, 0);
    await clearCount(db, items[2].id);
    const after = await listStocktakeItems(db, stocktakeId);
    for (const item of after) assert.deepEqual(await getStocktakeItem(db, item.id), item);
    assert.equal(await getStocktakeItem(db, 999999), null);
  });

  it('随机造的盘点单：列表上的计数和逐项算的一样', async () => {
    const db = await openDb();
    const random = seeded(42);
    const officeIds = [1, await createOffice(db, '仓库二')];
    for (let index = 0; index < 60; index++) {
      await createProduct(db, product(officeIds[index % 2], index), { quantity: 1 + Math.floor(random() * 20), expiryDate: null });
    }
    const stocktakeIds: number[] = [];
    for (const officeId of officeIds) stocktakeIds.push(await startStocktake(db, officeId, ['food', 'daily']));
    // 直接写实盘数、清点时账面：包括差 0.005、0.0049、-0.005、-0.0051 这种四舍五入的临界值，以及没有账面（NULL）的
    const deltas = [0, 0.005, 0.0049, -0.005, -0.0051, 0.01, -0.01, 0.3, -2, 1.005, -1.005, 0.015, -0.015];
    for (const stocktakeId of stocktakeIds) {
      for (const item of await listStocktakeItems(db, stocktakeId)) {
        const roll = random();
        if (roll < 0.2) continue;
        const expected = roll < 0.3 ? null : Math.round(random() * 2000) / 100;
        const counted = (expected ?? 0) + deltas[Math.floor(random() * deltas.length)];
        await db.runAsync('UPDATE stocktake_item SET counted_qty = ?, expected_qty = ? WHERE id = ?', [counted, expected, item.id]);
      }
    }
    for (const officeId of [null, ...officeIds]) {
      const listed = await listStocktakes(db, officeId);
      assert.ok(listed.length > 0);
      for (const entry of listed) {
        assert.deepEqual(entry.summary, summarizeCounts(await listStocktakeItems(db, entry.id)), `盘点单 ${entry.id}`);
      }
    }
  });
});
