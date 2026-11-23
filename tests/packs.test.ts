import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describePacks, formatBreakdown, packExample, toBaseQty, unitOptions, validatePacks, type PackUnit } from '../src/lib/packs';

const packs: PackUnit[] = [
  { unit: '提', size: 6, barcode: null },
  { unit: '箱', size: 24, barcode: '16901234567899' },
];

describe('包装单位换算', () => {
  it('按箱、按提、按瓶换算成瓶', () => {
    assert.equal(toBaseQty(2, '箱', '瓶', packs), 48);
    assert.equal(toBaseQty(1, '提', '瓶', packs), 6);
    assert.equal(toBaseQty(3, '瓶', '瓶', packs), 3);
    assert.equal(toBaseQty(0.5, '箱', '瓶', packs), 12);
    assert.equal(toBaseQty(1, '袋', '瓶', packs), null);
  });

  it('单位选项：最小单位在前，包装从大到小', () => {
    assert.deepEqual(
      unitOptions('瓶', packs).map((option) => option.label),
      ['瓶', '箱（24 瓶）', '提（6 瓶）'],
    );
  });

  it('库存拆成 箱 提 瓶', () => {
    assert.equal(formatBreakdown(50, '瓶', packs), '2 箱 2 瓶');
    assert.equal(formatBreakdown(57, '瓶', packs), '2 箱 1 提 3 瓶');
    assert.equal(formatBreakdown(24, '瓶', packs), '1 箱');
    assert.equal(formatBreakdown(5, '瓶', packs), null);
    assert.equal(formatBreakdown(50, '瓶', []), null);
    assert.equal(formatBreakdown(2.5, 'kg', [{ unit: '袋', size: 0.5, barcode: null }]), null);
  });

  it('规格说明', () => {
    assert.equal(describePacks('瓶', packs), '1 箱 = 24 瓶，1 提 = 6 瓶');
  });

  it('校验包装规格', () => {
    assert.equal(validatePacks('瓶', packs), null);
    assert.match(validatePacks('瓶', [{ unit: '瓶', size: 6, barcode: null }]) ?? '', /不能和最小单位/);
    assert.match(validatePacks('瓶', [...packs, { unit: '箱', size: 12, barcode: null }]) ?? '', /重复/);
    assert.match(validatePacks('瓶', [{ unit: '箱', size: 0, barcode: null }]) ?? '', /大于 0/);
    assert.match(validatePacks('瓶', [{ unit: '箱', size: 1, barcode: null }]) ?? '', /没有意义/);
    assert.match(validatePacks('瓶', [{ unit: ' ', size: 6, barcode: null }]) ?? '', /不能为空/);
    assert.match(
      validatePacks('瓶', [
        { unit: '箱', size: 24, barcode: '1' },
        { unit: '提', size: 6, barcode: '1' },
      ]) ?? '',
      /同一个条码/,
    );
  });
});

describe('没设包装规格时举的例子', () => {
  it('按最小单位举「1 箱 = 12 瓶」', () => {
    assert.equal(packExample('瓶'), '1 箱 = 12 瓶');
  });

  it('最小单位就是箱时换成提', () => {
    assert.equal(packExample('箱'), '1 提 = 12 箱');
  });
});
