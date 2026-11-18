import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeAccessories, validateAccessories, warrantyEnd, warrantyStatus } from '../src/lib/warranty';

describe('保修', () => {
  it('按年限算到期日', () => {
    assert.equal(warrantyEnd('2026-11-18', 1, 'year'), '2027-11-17');
    assert.equal(warrantyEnd('2026-01-31', 1, 'month'), '2026-02-27');
    assert.equal(warrantyEnd('2024-02-29', 3, 'year'), '2027-02-27');
  });

  it('状态：在保、快过保、今天到期、已过保、没填', () => {
    assert.deepEqual(warrantyStatus('2027-11-17', '2026-11-18'), {
      level: 'ok',
      text: '保修到 2027年11月17日',
      daysLeft: 364,
    });
    assert.equal(warrantyStatus('2026-12-01', '2026-11-18')?.text, '保修还剩 13 天');
    assert.equal(warrantyStatus('2026-11-18', '2026-11-18')?.text, '保修今天到期');
    assert.equal(warrantyStatus('2026-11-10', '2026-11-18')?.text, '已过保 8 天');
    assert.equal(warrantyStatus(null, '2026-11-18'), null);
  });
});

describe('配件', () => {
  it('说明文字', () => {
    assert.equal(
      describeAccessories([
        { name: '充电器', quantity: 1 },
        { name: '扩展坞', quantity: 2 },
      ]),
      '充电器 ×1、扩展坞 ×2',
    );
  });

  it('校验', () => {
    assert.equal(validateAccessories([{ name: '充电器', quantity: 1 }]), null);
    assert.match(validateAccessories([{ name: ' ', quantity: 1 }]) ?? '', /不能为空/);
    assert.match(
      validateAccessories([
        { name: '鼠标', quantity: 1 },
        { name: '鼠标', quantity: 2 },
      ]) ?? '',
      /重复/,
    );
    assert.match(validateAccessories([{ name: '鼠标', quantity: 0 }]) ?? '', /1 到 9999/);
  });
});
