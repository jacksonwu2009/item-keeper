import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  convertPriceUnit,
  defaultPriceDraft,
  derivePrice,
  EMPTY_PRICE,
  formatPrice,
  perBaseUnitPrice,
  roundUnitPrice,
  storedPriceDraft,
} from '../src/lib/price';

describe('入库单价、总价互算', () => {
  it('填单价：总价 = 单价 × 数量，数量变了跟着变', () => {
    const draft = { source: 'unit' as const, text: '2.5' };
    assert.deepEqual(derivePrice(draft, 12), {
      unitText: '2.5',
      totalText: '30',
      price: { unitPrice: 2.5, totalPrice: 30 },
    });
    assert.equal(derivePrice(draft, 3).totalText, '7.5');
  });

  it('填总价：单价 = 总价 ÷ 数量，1 以上留 2 位、不到 1 留 4 位', () => {
    assert.deepEqual(derivePrice({ source: 'total', text: '100' }, 3), {
      unitText: '33.33',
      totalText: '100',
      price: { unitPrice: 33.33, totalPrice: 100 },
    });
    assert.equal(derivePrice({ source: 'total', text: '2' }, 24).unitText, '0.0833');
  });

  it('没填价格或数量不对时不算，也不保存价格', () => {
    assert.deepEqual(derivePrice(EMPTY_PRICE, 5), { unitText: '', totalText: '', price: null });
    assert.deepEqual(derivePrice({ source: 'unit', text: '3' }, null), { unitText: '3', totalText: '', price: null });
    assert.deepEqual(derivePrice({ source: 'total', text: '30' }, 0), { unitText: '', totalText: '30', price: null });
    assert.equal(derivePrice({ source: 'unit', text: '.' }, 2).price, null);
  });

  it('单价 0 也算填了（赠品）', () => {
    assert.deepEqual(derivePrice({ source: 'unit', text: '0' }, 4).price, { unitPrice: 0, totalPrice: 0 });
  });

  it('换入库单位：填的是单价就按包装换算，填的是总价不动', () => {
    assert.deepEqual(convertPriceUnit({ source: 'unit', text: '2' }, 1, 24), { source: 'unit', text: '48' });
    assert.deepEqual(convertPriceUnit({ source: 'unit', text: '48' }, 24, 1), { source: 'unit', text: '2' });
    const total = { source: 'total' as const, text: '96' };
    assert.equal(convertPriceUnit(total, 1, 24), total);
    assert.equal(convertPriceUnit(EMPTY_PRICE, 1, 24), EMPTY_PRICE);
  });

  it('上次进价折成最小单位，再按这次的单位预填', () => {
    // 上次按箱进：2 箱 = 48 瓶，总价 96 → 每瓶 2
    const perBottle = perBaseUnitPrice({ delta: 48, unitPrice: 48, totalPrice: 96, inputQty: 2 });
    assert.equal(perBottle, 2);
    assert.deepEqual(defaultPriceDraft(perBottle, 1), { source: 'unit', text: '2' });
    assert.deepEqual(defaultPriceDraft(perBottle, 24), { source: 'unit', text: '48' });
    // 只有单价（按箱）时也能折
    assert.equal(perBaseUnitPrice({ delta: 48, unitPrice: 48, totalPrice: null, inputQty: 2 }), 2);
    assert.equal(perBaseUnitPrice({ delta: 5, unitPrice: null, totalPrice: null, inputQty: 5 }), null);
    assert.deepEqual(defaultPriceDraft(null, 1), EMPTY_PRICE);
  });

  it('显示：至少 2 位小数', () => {
    assert.equal(formatPrice(2.5), '2.50');
    assert.equal(formatPrice(48), '48.00');
    assert.equal(formatPrice(0.0833), '0.0833');
    assert.equal(roundUnitPrice(33.333333), 33.33);
  });
});

describe('改入库记录的价格：输入框一开始显示的', () => {
  it('有总价就从总价算单价，算出来和记的单价一样', () => {
    // 当时填的总价 29.99（12 瓶），单价存成 2.5；从单价反算会变成 30
    const draft = storedPriceDraft({ unitPrice: 2.5, totalPrice: 29.99 });
    assert.deepEqual(draft, { source: 'total', text: '29.99' });
    assert.deepEqual(derivePrice(draft, 12).price, { unitPrice: 2.5, totalPrice: 29.99 });
  });

  it('只有单价从单价算；都没记就空着', () => {
    assert.deepEqual(storedPriceDraft({ unitPrice: 0.0833, totalPrice: null }), { source: 'unit', text: '0.0833' });
    assert.deepEqual(storedPriceDraft({ unitPrice: null, totalPrice: null }), EMPTY_PRICE);
  });
});
