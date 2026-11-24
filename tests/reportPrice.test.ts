/**
 * 报表估算损失找进价改成按物品分组 + 二分查找以后，结果要和原来每次从头扫（priceBefore）完全一样：随机造数据比对。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { roundTotalPrice } from '../src/lib/price';
import {
  createPriceLookup,
  priceBefore,
  summarizeConsumption,
  type PricedStockIn,
  type ReportMovement,
} from '../src/lib/report';

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

/** 时间故意只取几十个值：同一时刻的多条进价、和出库同一时刻的进价都会出现 */
function randomTime(random: () => number): string {
  return new Date(Date.UTC(2026, Math.floor(random() * 3), 1 + Math.floor(random() * 10), pick(random, [0, 2, 9]))).toISOString();
}

function randomHistory(random: () => number, count: number, productCount: number): PricedStockIn[] {
  return Array.from({ length: count }, () => {
    const delta = pick(random, [1, 2, 6, 0.5]);
    const priced = random();
    return {
      productId: 1 + Math.floor(random() * productCount),
      delta,
      inputQty: pick(random, [null, 1, 2, 0]),
      unitPrice: priced < 0.5 ? pick(random, [3.5, 10, 0.99]) : null,
      totalPrice: priced >= 0.5 ? pick(random, [7, 12.3, 100]) : null,
      happenedAt: randomTime(random),
    };
  });
}

function randomMovements(random: () => number, count: number, productCount: number): ReportMovement[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    productId: 1 + Math.floor(random() * (productCount + 2)),
    officeId: 1,
    kind: pick(random, ['food', 'daily'] as const),
    category: null,
    productName: `物品${index}`,
    unit: '个',
    type: pick(random, ['in', 'out', 'out', 'adjust'] as const),
    delta: pick(random, [-3, -1, -0.5, 2]),
    happenedAt: randomTime(random),
    note: pick(random, [null, '过期丢弃', '坏了', '用掉', ' 坏了 ']),
    inputQty: null,
    inputUnit: null,
    unitPrice: null,
    totalPrice: null,
    // 联网版的 ReportMovement 多几个字段（单据、冲正）；单机版没有，多出来的不影响
    officeName: null,
    orderUid: null,
    orderKind: null,
  }));
}

describe('估算损失找进价：分组 + 二分查找和从头扫一样', () => {
  it('随机 200 组：每个物品、每个时刻查到的进价都一样', () => {
    for (let round = 0; round < 200; round++) {
      const random = seeded(round + 1);
      const productCount = 1 + Math.floor(random() * 8);
      const history = randomHistory(random, Math.floor(random() * 60), productCount);
      const lookup = createPriceLookup(history);
      const times = [...history.map((entry) => entry.happenedAt), ...Array.from({ length: 20 }, () => randomTime(random)), '2025-01-01T00:00:00.000Z'];
      for (let productId = 0; productId <= productCount + 1; productId++) {
        for (const time of times) {
          assert.equal(lookup(productId, time), priceBefore(history, productId, time), `第 ${round + 1} 组 物品 ${productId} ${time}`);
        }
      }
    }
  });

  it('随机 200 组：summarizeConsumption 里每条损耗估的金额和按 priceBefore 算的一样', () => {
    for (let round = 0; round < 200; round++) {
      const random = seeded(1000 + round);
      const productCount = 1 + Math.floor(random() * 8);
      const history = randomHistory(random, Math.floor(random() * 60), productCount);
      const movements = randomMovements(random, 40, productCount) as Parameters<typeof summarizeConsumption>[0];
      const summary = summarizeConsumption(movements, history);
      const byId = new Map(movements.map((movement) => [movement.id, movement]));
      let total = 0;
      let unestimated = 0;
      for (const loss of summary.losses) {
        const movement = byId.get(loss.movementId);
        assert.ok(movement);
        const unitCost = priceBefore(history, movement.productId, movement.happenedAt);
        const expected = unitCost === null ? null : roundTotalPrice(unitCost * -movement.delta);
        assert.equal(loss.estimatedLoss, expected, `第 ${round + 1} 组 损耗 ${loss.movementId}`);
        if (expected === null) unestimated += 1;
        else total += expected;
      }
      assert.equal(summary.estimatedLossTotal, roundTotalPrice(total));
      assert.equal(summary.unestimatedLossCount, unestimated);
    }
  });
});
