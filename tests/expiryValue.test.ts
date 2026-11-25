import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expiryValueOf, keptProductionDate, keptProductionLabel, type ExpiryDraft } from '../src/lib/expiryValue';
import { planExpiryFill } from '../src/lib/labelScan';

/**
 * 过期日期输入框填出来要保存的值（lib/expiryValue.ts，鸿蒙版 StockFormRules.ets 的 expiryValueOf 跑同样的用例）：
 * 重点是「选到期日」时拍照认出的生产日期也记下，点「不记」就不记。
 */
function draftOf(overrides: Partial<ExpiryDraft>): ExpiryDraft {
  return {
    mode: 'date',
    expiry: null,
    productionDate: null,
    keepProductionDate: false,
    shelfAmountText: '',
    shelfUnit: 'month',
    ...overrides,
  };
}

/** 拍喷码认出两个日期、按先后填的（面包袋那张照片），ExpiryInput 收到以后的样子 */
function scannedBread(): ExpiryDraft {
  const fill = planExpiryFill({
    dates: { production: '2026-09-30', expiry: '2026-12-28', confirmed: false, byOrder: true },
    shelfLife: null,
    shelfLifeRecognized: false,
    dateElsewhere: null,
  });
  assert.ok(fill);
  return draftOf({
    mode: fill.mode,
    expiry: fill.expiry,
    productionDate: fill.productionDate,
    keepProductionDate: !!fill.productionDate,
  });
}

describe('过期日期：要保存的值', () => {
  it('选到期日、拍照认出了生产日期：生产日期记在入库记录上，保质期不猜', () => {
    const draft = scannedBread();
    assert.equal(keptProductionDate(draft), '2026-09-30');
    assert.deepEqual(expiryValueOf(draft), { expiry: '2026-12-28', error: null, shelfLife: null, productionDate: '2026-09-30' });
  });

  it('点了「不记」：这一批不记生产日期，到期日照旧', () => {
    const draft = { ...scannedBread(), keepProductionDate: false };
    assert.equal(keptProductionDate(draft), null);
    assert.deepEqual(expiryValueOf(draft), { expiry: '2026-12-28', error: null, shelfLife: null, productionDate: null });
  });

  it('改到期日不影响生产日期', () => {
    const draft = { ...scannedBread(), expiry: '2027-01-05' };
    assert.deepEqual([expiryValueOf(draft).expiry, expiryValueOf(draft).productionDate], ['2027-01-05', '2026-09-30']);
  });

  it('手动选的到期日不带生产日期（生产日期那一格有值也不算）', () => {
    const draft = draftOf({ expiry: '2027-03-01', productionDate: '2026-11-25' });
    assert.equal(keptProductionDate(draft), null);
    assert.equal(expiryValueOf(draft).productionDate, null);
  });

  it('到期日还没选：报错，不带生产日期', () => {
    const draft = { ...scannedBread(), expiry: null };
    assert.deepEqual(expiryValueOf(draft), { expiry: null, error: '请选择过期日期', shelfLife: null, productionDate: null });
  });

  it('切到「生产日期+保质期」：生产日期那格是同一天；保质期空着要人填，填了才算到期日', () => {
    const shelf = { ...scannedBread(), mode: 'shelf' as const };
    assert.equal(keptProductionDate(shelf), null);
    assert.deepEqual(expiryValueOf(shelf), { expiry: null, error: '保质期请填正整数', shelfLife: null, productionDate: null });
    const filled = { ...shelf, shelfAmountText: '90', shelfUnit: 'day' as const };
    assert.deepEqual(expiryValueOf(filled), {
      expiry: '2026-12-28',
      error: null,
      shelfLife: { amount: 90, unit: 'day' },
      productionDate: '2026-09-30',
    });
  });

  it('不记录：什么都不带', () => {
    assert.deepEqual(expiryValueOf({ ...scannedBread(), mode: 'none' }), { expiry: null, error: null, shelfLife: null, productionDate: null });
  });

  it('到期日下面那一行的字：今年的只写月日，不是今年的带年份', () => {
    assert.equal(keptProductionLabel('2026-09-30', 2026), '生产日期 9月30日');
    assert.equal(keptProductionLabel('2025-12-01', 2026), '生产日期 2025年12月1日');
  });
});
