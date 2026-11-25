import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLabel } from '../src/lib/labelParse';
import { dateScanProblem, describeShelfCheck, frameToCrop, labelScanProblem, planExpiryFill } from '../src/lib/labelScan';

const TODAY = '2026-11-22';

describe('拍照识别：取景框对应照片里哪一块', () => {
  it('预览铺满屏幕时按同样的比例倒推，四周多留一点', () => {
    // 屏幕 400×800，照片 3000×4000（3:4），预览按高铺满：照片显示成 600×800，左右各裁掉 100
    const crop = frameToCrop({ width: 400, height: 800 }, { x: 50, y: 300, width: 300, height: 100 }, { width: 3000, height: 4000 }, 0);
    assert.ok(Math.abs(crop.x - 150 / 600) < 1e-9);
    assert.ok(Math.abs(crop.width - 300 / 600) < 1e-9);
    assert.ok(Math.abs(crop.y - 300 / 800) < 1e-9);
    assert.ok(Math.abs(crop.height - 100 / 800) < 1e-9);
  });

  it('照片宽高没按方向转（横着的数）也按竖的算；留边不超出照片', () => {
    const upright = frameToCrop({ width: 400, height: 800 }, { x: 0, y: 0, width: 400, height: 800 }, { width: 3000, height: 4000 });
    const sideways = frameToCrop({ width: 400, height: 800 }, { x: 0, y: 0, width: 400, height: 800 }, { width: 4000, height: 3000 });
    assert.deepEqual(upright, sideways);
    assert.ok(upright.x >= 0 && upright.y === 0 && upright.x + upright.width <= 1 && upright.height === 1);
  });
});

describe('拍照识别：拍得不好时提示重拍', () => {
  it('糊：没有像样的行', () => {
    const result = parseLabel([{ text: '缆', score: 0.2 }], TODAY);
    assert.match(labelScanProblem(result)?.title ?? '', /糊/);
    assert.match(dateScanProblem(result)?.title ?? '', /糊/);
  });

  it('字清楚但没有要的字段：标签提示没认出名称，拍日期提示没认出日期', () => {
    const result = parseLabel([{ text: '超韧 湿水不易破', score: 0.95 }], TODAY);
    assert.match(labelScanProblem(result)?.title ?? '', /没认出名称/);
    assert.match(dateScanProblem(result)?.title ?? '', /没认出日期/);
  });

  it('认出了就不提示', () => {
    const label = parseLabel([{ text: '保质期：12个月 生产日期：见瓶盖', score: 0.95 }], TODAY);
    assert.equal(labelScanProblem(label), null);
    const inkjet = parseLabel([{ text: '20261012', score: 0.9 }], TODAY);
    assert.equal(dateScanProblem(inkjet), null);
  });
});

describe('拍照识别：认出的日期、保质期怎么填', () => {
  const year = { amount: 12, unit: 'month' as const };

  it('生产日期 + 保质期和到期日对上：按生产日期+保质期填，提示对上了', () => {
    const fill = planExpiryFill({
      dates: { production: '2026-10-12', expiry: '2027-10-11', confirmed: true },
      shelfLife: year,
      shelfLifeRecognized: true,
      dateElsewhere: null,
    });
    assert.equal(fill?.mode, 'shelf');
    assert.equal(fill?.productionDate, '2026-10-12');
    assert.deepEqual(fill?.tags, { productionDate: 'recognized', shelfLife: 'recognized' });
    assert.match(fill?.note ?? '', /^✓/);
  });

  it('只有到期日：直接填到期日', () => {
    const fill = planExpiryFill({
      dates: { production: null, expiry: '2027-03-01', confirmed: false },
      shelfLife: null,
      shelfLifeRecognized: false,
      dateElsewhere: null,
    });
    assert.deepEqual([fill?.mode, fill?.expiry, fill?.tags], ['date', '2027-03-01', { expiry: 'recognized' }]);
    assert.equal(fill?.note, null);
  });

  it('两个日期按先后填的：填到期日，日期下面提示「按先后填的，请核对」', () => {
    const fill = planExpiryFill({
      dates: { production: '2026-09-30', expiry: '2026-12-28', confirmed: false, byOrder: true },
      shelfLife: null,
      shelfLifeRecognized: false,
      dateElsewhere: null,
    });
    assert.deepEqual(
      [fill?.mode, fill?.expiry, fill?.tags, fill?.note],
      ['date', '2026-12-28', { expiry: 'recognized' }, '按先后填的，请核对'],
    );
  });

  it('只有生产日期、不知道保质期：保质期标「没认出来」让人填', () => {
    const fill = planExpiryFill({
      dates: { production: '2026-09-24', expiry: null, confirmed: false },
      shelfLife: null,
      shelfLifeRecognized: false,
      dateElsewhere: null,
    });
    assert.deepEqual(fill?.tags, { productionDate: 'recognized', shelfLife: 'missing' });
    assert.equal(fill?.shelfLife, null);
  });

  it('标签写「见瓶盖」、没拍喷码：生产日期标「没认出来」，提示单独拍', () => {
    const fill = planExpiryFill({
      dates: { production: null, expiry: null, confirmed: false },
      shelfLife: year,
      shelfLifeRecognized: true,
      dateElsewhere: '见瓶盖',
    });
    assert.deepEqual([fill?.mode, fill?.productionDate, fill?.tags], ['shelf', null, { productionDate: 'missing', shelfLife: 'recognized' }]);
    assert.match(fill?.note ?? '', /见瓶盖.*拍日期/);
  });

  it('和日期有关的什么都没认出来：不动', () => {
    assert.equal(
      planExpiryFill({ dates: { production: null, expiry: null, confirmed: false }, shelfLife: null, shelfLifeRecognized: false, dateElsewhere: null }),
      null,
    );
  });

  it('选日期时按保质期算出到期日，和另一个日期对得上打勾', () => {
    assert.equal(describeShelfCheck('2026-10-12', year, ['2027-10-11']), '按保质期 12 个月算：2027年10月11日 到期，✓ 和喷码上的另一个日期一致');
    assert.equal(describeShelfCheck('2026-10-12', year, ['2027-04-01']), '按保质期 12 个月算：2027年10月11日 到期');
    assert.equal(describeShelfCheck('2026-10-12', null, ['2027-10-11']), null);
  });
});
