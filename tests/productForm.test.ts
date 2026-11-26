import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DISCARD_EDIT_MESSAGE, DISCARD_EDIT_TITLE, leaveEditPage, type DiscardButton } from '../src/lib/discardEdit';
import {
  draftShelfLife,
  firstBatchExpiryFill,
  newProductShelfLife,
  productFormChanged,
  scannedShelfDraft,
  SHELF_LIFE_ERROR,
  shelfDraftOf,
  shelfLifeError,
  shelfScanTag,
  type ProductFormValues,
} from '../src/lib/productForm';
import type { ExpiryFill } from '../src/lib/labelScan';

const TWELVE_MONTHS = { amount: 12, unit: 'month' as const };
const NINETY_DAYS = { amount: 90, unit: 'day' as const };

describe('物品资料的「保质期」那一格', () => {
  it('空着是没填、不报错；1–9999 的整数才算填对', () => {
    assert.equal(draftShelfLife({ shelfText: '', shelfUnit: 'month' }), null);
    assert.equal(shelfLifeError({ shelfText: ' ', shelfUnit: 'month' }), null);
    assert.deepEqual(draftShelfLife({ shelfText: '12', shelfUnit: 'month' }), TWELVE_MONTHS);
    assert.equal(shelfLifeError({ shelfText: '0', shelfUnit: 'day' }), SHELF_LIFE_ERROR);
    assert.equal(shelfLifeError({ shelfText: '1.5', shelfUnit: 'year' }), SHELF_LIFE_ERROR);
    assert.equal(shelfLifeError({ shelfText: '10000', shelfUnit: 'day' }), SHELF_LIFE_ERROR);
  });

  it('打开表单时：资料里有就带出来，没有就空着、单位默认「个月」', () => {
    assert.deepEqual(shelfDraftOf(NINETY_DAYS), { shelfText: '90', shelfUnit: 'day' });
    assert.deepEqual(shelfDraftOf(null), { shelfText: '', shelfUnit: 'month' });
    assert.deepEqual(shelfDraftOf(undefined), { shelfText: '', shelfUnit: 'month' });
  });
});

describe('新建物品：填了保质期，「这次入库」按资料带出', () => {
  it('保质期填好了：按「生产日期+保质期」填，保质期标「按资料」，生产日期空着等人选', () => {
    const fill = firstBatchExpiryFill(null, { shelfText: '12', shelfUnit: 'month', kind: 'food' }, true);
    assert.deepEqual(fill, {
      mode: 'shelf',
      expiry: null,
      productionDate: null,
      shelfLife: TWELVE_MONTHS,
      tags: { shelfLife: 'saved' },
      note: '生产日期请照包装选，或点「拍日期」拍喷码',
    });
  });

  it('日用品也一样；不能拍照时提示只说照包装选', () => {
    const fill = firstBatchExpiryFill(null, { shelfText: '90', shelfUnit: 'day', kind: 'daily' }, false);
    assert.equal(fill?.mode, 'shelf');
    assert.deepEqual(fill?.shelfLife, NINETY_DAYS);
    assert.equal(fill?.note, '生产日期请照包装选');
  });

  it('保质期没填或填错：不带出（按大类的默认填法）', () => {
    assert.equal(firstBatchExpiryFill(null, { shelfText: '', shelfUnit: 'month', kind: 'food' }, true), null);
    assert.equal(firstBatchExpiryFill(null, { shelfText: 'abc', shelfUnit: 'month', kind: 'food' }, true), null);
  });

  it('拍包装认出了日期：按照片填，不按保质期那一格重新带出', () => {
    const scanFill: ExpiryFill = {
      mode: 'date',
      expiry: '2027-03-01',
      productionDate: null,
      shelfLife: null,
      tags: { expiry: 'recognized' },
      note: null,
    };
    assert.equal(firstBatchExpiryFill(scanFill, { shelfText: '12', shelfUnit: 'month', kind: 'food' }, true), scanFill);
  });
});

describe('新建物品：保存时记进资料的保质期', () => {
  it('那一格填了用那一格的', () => {
    assert.deepEqual(newProductShelfLife(TWELVE_MONTHS, NINETY_DAYS), TWELVE_MONTHS);
  });

  it('那一格没填、这一批按「生产日期+保质期」填了：记这一批的', () => {
    assert.deepEqual(newProductShelfLife(null, NINETY_DAYS), NINETY_DAYS);
  });

  it('都没有就不记；这一批的保质期不对也不记', () => {
    assert.equal(newProductShelfLife(null, null), null);
    assert.equal(newProductShelfLife(null, { amount: 0, unit: 'day' }), null);
  });
});

describe('拍包装认出的保质期填进那一格', () => {
  it('认出了、格子空着：填上，标「识别」', () => {
    const next = scannedShelfDraft({ shelfText: '', shelfUnit: 'month' }, null, NINETY_DAYS);
    assert.deepEqual(next, { shelfText: '90', shelfUnit: 'day' });
    assert.equal(shelfScanTag(true, NINETY_DAYS, next), 'recognized');
  });

  it('手动填过的不动，也不标「识别」', () => {
    const next = scannedShelfDraft({ shelfText: '6', shelfUnit: 'month' }, null, NINETY_DAYS);
    assert.deepEqual(next, { shelfText: '6', shelfUnit: 'month' });
    assert.equal(shelfScanTag(true, NINETY_DAYS, next), null);
  });

  it('重拍：上一次照片填的、没改过的换成这次的；这次没认出就清空，标「没认出来」', () => {
    assert.deepEqual(scannedShelfDraft({ shelfText: '90', shelfUnit: 'day' }, NINETY_DAYS, TWELVE_MONTHS), {
      shelfText: '12',
      shelfUnit: 'month',
    });
    const cleared = scannedShelfDraft({ shelfText: '90', shelfUnit: 'day' }, NINETY_DAYS, null);
    assert.deepEqual(cleared, { shelfText: '', shelfUnit: 'day' });
    assert.equal(shelfScanTag(true, null, cleared), 'missing');
  });

  it('人改了认出的值就不再标「识别」；没拍过不标', () => {
    assert.equal(shelfScanTag(true, NINETY_DAYS, { shelfText: '91', shelfUnit: 'day' }), null);
    assert.equal(shelfScanTag(false, null, { shelfText: '', shelfUnit: 'month' }), null);
  });
});

function openedValues(): ProductFormValues {
  return {
    officeId: 1,
    kind: 'food',
    barcode: '6901234567892',
    name: '纯牛奶',
    category: '乳品',
    spec: '250ml',
    unit: '盒',
    location: '冰箱',
    lowStockText: '2',
    leadText: '',
    note: '',
    packs: [{ unit: '箱', sizeText: '24', barcode: '' }],
    shelfText: '6',
    shelfUnit: 'month',
    lastInPrice: { source: 'unit', text: '3.5' },
  };
}

describe('编辑物品页：改过没有（返回前要不要问「放弃修改？」）', () => {
  it('什么都没改：不算改过', () => {
    assert.equal(productFormChanged(openedValues(), openedValues()), false);
  });

  it('改了任何一格都算改过', () => {
    const changes: Partial<ProductFormValues>[] = [
      { officeId: 2 },
      { kind: 'daily' },
      { barcode: '' },
      { name: '酸奶' },
      { category: null },
      { spec: '200ml' },
      { unit: '瓶' },
      { location: '' },
      { lowStockText: '' },
      { leadText: '3' },
      { note: '早餐' },
      { shelfText: '' },
      { shelfUnit: 'day' },
      { lastInPrice: { source: 'total', text: '3.5' } },
      { lastInPrice: { source: 'unit', text: '4' } },
    ];
    for (const change of changes) {
      assert.equal(productFormChanged(openedValues(), { ...openedValues(), ...change }), true, JSON.stringify(change));
    }
  });

  it('包装规格加了、删了、改了都算改过', () => {
    const opened = openedValues();
    assert.equal(productFormChanged(opened, { ...opened, packs: [] }), true);
    assert.equal(productFormChanged(opened, { ...opened, packs: [...opened.packs, { unit: '提', sizeText: '', barcode: '' }] }), true);
    assert.equal(productFormChanged(opened, { ...opened, packs: [{ unit: '箱', sizeText: '12', barcode: '' }] }), true);
    assert.equal(
      productFormChanged(opened, { ...opened, packs: [{ unit: '箱', sizeText: '24', barcode: '6901234567892' }] }),
      true,
    );
  });

  it('改了又改回原样：不算改过（包装规格删了再按原样加回来也一样）', () => {
    const opened = openedValues();
    const current = { ...opened, name: '纯牛奶', packs: [{ unit: '箱', sizeText: '24', barcode: '' }] };
    assert.equal(productFormChanged(opened, current), false);
  });
});

describe('编辑物品页：返回时问不问「放弃修改？」', () => {
  function run(saving: boolean) {
    let left = 0;
    const asked: { title: string; message: string; buttons: DiscardButton[] }[] = [];
    leaveEditPage(
      saving,
      () => {
        left += 1;
      },
      (title, message, buttons) => asked.push({ title, message, buttons }),
    );
    return { left: () => left, asked };
  }

  it('改过、没保存：先问，两个按钮「继续编辑」「放弃」', () => {
    const { left, asked } = run(false);
    assert.equal(left(), 0);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, DISCARD_EDIT_TITLE);
    assert.equal(asked[0].title, '放弃修改？');
    assert.equal(asked[0].message, DISCARD_EDIT_MESSAGE);
    assert.equal(asked[0].message, '改过的内容不会保存');
    assert.deepEqual(
      asked[0].buttons.map((button) => [button.text, button.style]),
      [
        ['继续编辑', 'cancel'],
        ['放弃', 'destructive'],
      ],
    );
  });

  it('点「继续编辑」留在页面；点「放弃」才离开', () => {
    const { left, asked } = run(false);
    asked[0].buttons[0].onPress?.();
    assert.equal(left(), 0);
    asked[0].buttons[1].onPress?.();
    assert.equal(left(), 1);
  });

  it('点了「保存」以后离开：不问，直接离开', () => {
    const { left, asked } = run(true);
    assert.equal(asked.length, 0);
    assert.equal(left(), 1);
  });
});
