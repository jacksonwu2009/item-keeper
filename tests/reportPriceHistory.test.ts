/**
 * 报表读进价记录只读「时间段里的 + 每样东西开始前最近的一条」以后，估算出来的损失要和原来把时间段结束前的进价全读出来时完全一样。
 * 在内存库里随机造出入库（故意让很多记录同一时刻），按几个时间段、办公点比对。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { restoreAll } from '../src/db/backup';
import { loadReportSource } from '../src/db/report';
import { BACKUP_APP, BACKUP_FORMAT, type BackupData } from '../src/lib/backup';
import { summarizeConsumption, type PricedStockIn } from '../src/lib/report';
import { openDb } from './helpers/memoryDb';

/** 固定种子的伪随机数，失败时能复现 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

/** 原来的读法：时间段结束前所有填了价格的入库 */
const ALL_BEFORE_END = `SELECT m.product_id AS productId, m.delta, m.input_qty AS inputQty, m.unit_price AS unitPrice,
        m.total_price AS totalPrice, m.happened_at AS happenedAt
   FROM stock_movement m JOIN stock_product p ON p.id = m.product_id
  WHERE m.type = 'in' AND m.delta > 0 AND (m.unit_price IS NOT NULL OR m.total_price IS NOT NULL)
    AND (? IS NULL OR p.office_id = ?) AND m.happened_at < ?
  ORDER BY m.happened_at, m.id`;

function randomData(random: () => number): BackupData {
  // 时间只取几十个值：同一时刻的多条进价、出库和进价同一时刻都会出现
  const time = () => new Date(Date.UTC(2026, Math.floor(random() * 6), 1 + Math.floor(random() * 6) * 5, pick(random, [1, 8]))).toISOString();
  const products = Array.from({ length: 30 }, (_, index) => ({
    office: pick(random, ['北京', '上海']),
    kind: pick(random, ['food', 'daily'] as const),
    barcode: null,
    name: `物品${index}`,
    category: null,
    spec: null,
    unit: '个',
    location: null,
    lowStockThreshold: null,
    expiryLeadDays: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    packs: [],
    batches: [{ quantity: 5, expiryDate: null, addedOn: '2026-01-01', note: null }],
    movements: Array.from({ length: Math.floor(random() * 12) }, () => {
      const stockIn = random() < 0.55;
      const priced = random();
      return {
        type: stockIn ? ('in' as const) : ('out' as const),
        delta: stockIn ? pick(random, [1, 2, 6]) : -pick(random, [1, 2]),
        expiryDate: null,
        happenedAt: time(),
        note: stockIn ? null : pick(random, ['过期丢弃', '坏了', '用掉']),
        inputQty: stockIn ? pick(random, [null, 1, 2]) : null,
        inputUnit: null,
        unitPrice: stockIn && priced < 0.4 ? pick(random, [3, 10.5]) : null,
        totalPrice: stockIn && priced >= 0.4 && priced < 0.8 ? pick(random, [7, 20]) : null,
      };
    }),
  }));
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: '2026-07-01T00:00:00.000Z',
    scope: ['food', 'daily'],
    settings: null,
    offices: ['北京', '上海'],
    products,
    devices: [],
  } as BackupData;
}

describe('报表只读需要的进价记录', () => {
  it('随机 15 个库 × 几个时间段 × 各办公点：损失估算和全读出来时一样，读的记录不多于原来', async () => {
    for (let round = 0; round < 15; round++) {
      const random = seeded(round + 1);
      const db = await openDb();
      await restoreAll(db, randomData(random));
      const offices = (await db.getAllAsync<{ id: number }>('SELECT id FROM office')).map((office) => office.id);
      const periods = [
        { startIso: '2026-01-01T00:00:00.000Z', endIso: '2026-02-01T00:00:00.000Z' },
        { startIso: '2026-03-01T00:00:00.000Z', endIso: '2026-04-01T00:00:00.000Z' },
        { startIso: '2026-03-06T08:00:00.000Z', endIso: '2026-05-16T01:00:00.000Z' },
        { startIso: '2026-06-01T00:00:00.000Z', endIso: '2027-01-01T00:00:00.000Z' },
      ];
      for (const officeId of [null, ...offices]) {
        for (const period of periods) {
          const source = await loadReportSource(db, officeId, period);
          const everything = await db.getAllAsync<PricedStockIn>(ALL_BEFORE_END, [officeId, officeId, period.endIso]);
          assert.ok(source.priceHistory.length <= everything.length);
          assert.deepEqual(
            summarizeConsumption(source.movements, source.priceHistory),
            summarizeConsumption(source.movements, everything),
            `第 ${round + 1} 个库，办公点 ${officeId}，${period.startIso}`,
          );
        }
      }
    }
  });
});
