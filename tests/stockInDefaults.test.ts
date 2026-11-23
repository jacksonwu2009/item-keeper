import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeStockIn, enteredQtyOf, LAST_EXPIRY_NOTE, stockInExpiryDefaults } from '../src/lib/stockInDefaults';

const TWELVE_MONTHS = { amount: 12, unit: 'month' as const };

describe('入库面板按上次入库带出过期日期', () => {
  it('上次选了到期日、没有保质期：默认选到期日，填上次那批的到期日，标「按上次」并提示照包装改', () => {
    const plan = stockInExpiryDefaults({ last: { expiryDate: '2027-01-31' }, shelfLife: null, isFood: true, canScan: true });
    assert.equal(plan.mode, 'date');
    assert.deepEqual(plan.fill, {
      mode: 'date',
      expiry: '2027-01-31',
      productionDate: null,
      shelfLife: null,
      tags: { expiry: 'last' },
      note: LAST_EXPIRY_NOTE,
    });
  });

  it('有保质期：按「生产日期+保质期」，保质期标「按资料」，生产日期空着（不默认今天）', () => {
    for (const last of [{ expiryDate: '2027-01-31' }, null]) {
      const plan = stockInExpiryDefaults({ last, shelfLife: TWELVE_MONTHS, isFood: true, canScan: true });
      assert.equal(plan.mode, 'shelf');
      assert.equal(plan.fill?.productionDate, null);
      assert.deepEqual(plan.fill?.shelfLife, TWELVE_MONTHS);
      assert.deepEqual(plan.fill?.tags, { shelfLife: 'saved' });
      assert.match(plan.fill?.note ?? '', /拍日期/);
    }
    // 没有识别模块时不提「拍日期」
    const plain = stockInExpiryDefaults({ last: null, shelfLife: TWELVE_MONTHS, isFood: true, canScan: false });
    assert.doesNotMatch(plain.fill?.note ?? '', /拍日期/);
  });

  it('上次没记过期日期：这次也默认不记录（食品也一样）', () => {
    assert.deepEqual(stockInExpiryDefaults({ last: { expiryDate: null }, shelfLife: TWELVE_MONTHS, isFood: true, canScan: true }), {
      mode: 'none',
      fill: null,
    });
  });

  it('没入过库、没有保质期：食品选到期日、日用品不记录，什么都不带', () => {
    assert.deepEqual(stockInExpiryDefaults({ last: null, shelfLife: null, isFood: true, canScan: true }), { mode: 'date', fill: null });
    assert.deepEqual(stockInExpiryDefaults({ last: null, shelfLife: null, isFood: false, canScan: true }), { mode: 'none', fill: null });
  });
});

describe('改入库价格时写的那条记录', () => {
  const record = { happenedAt: '2026-11-20T04:00:00.000Z', delta: 48, inputQty: 2, inputUnit: '箱', expiryDate: '2027-01-31' };

  it('按箱入库：写箱数和折成的瓶数，单价按箱算', () => {
    assert.deepEqual(enteredQtyOf(record, '瓶'), { qty: 2, unit: '箱' });
    assert.equal(describeStockIn(record, '瓶'), '11月20日入库 2 箱（48 瓶），2027年1月31日到期');
  });

  it('没记单位、没记过期日期：按最小单位', () => {
    const plain = { ...record, inputQty: null, inputUnit: null, expiryDate: null, delta: 6 };
    assert.deepEqual(enteredQtyOf(plain, '瓶'), { qty: 6, unit: '瓶' });
    assert.equal(describeStockIn(plain, '瓶'), '11月20日入库 6 瓶');
  });
});
