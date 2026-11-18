import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseNumberText, sanitizeNumberText, stepNumberText } from '../src/lib/number';

describe('数字输入只留数字', () => {
  it('整数：去掉非数字和前导 0', () => {
    assert.equal(sanitizeNumberText('12a3', 0), '123');
    assert.equal(sanitizeNumberText('-5', 0), '5');
    assert.equal(sanitizeNumberText('1.5', 0), '15');
    assert.equal(sanitizeNumberText('007', 0), '7');
    assert.equal(sanitizeNumberText('0', 0), '0');
    assert.equal(sanitizeNumberText('', 0), '');
  });

  it('小数：只留一个小数点，最多两位', () => {
    assert.equal(sanitizeNumberText('1.2.3', 2), '1.23');
    assert.equal(sanitizeNumberText('1.234', 2), '1.23');
    assert.equal(sanitizeNumberText('.5', 2), '0.5');
    assert.equal(sanitizeNumberText('0.5', 2), '0.5');
    assert.equal(sanitizeNumberText('2kg', 2), '2');
  });

  it('全角数字和中文标点能输进去', () => {
    assert.equal(sanitizeNumberText('１２', 0), '12');
    assert.equal(sanitizeNumberText('1，5', 2), '1.5');
    assert.equal(sanitizeNumberText('1。5', 2), '1.5');
  });

  it('解析', () => {
    assert.equal(parseNumberText(''), null);
    assert.equal(parseNumberText('.'), null);
    assert.equal(parseNumberText('0.5'), 0.5);
  });
});

describe('加减按钮', () => {
  const qty = { min: 0, max: 9999, decimals: 2 };
  it('按步长加减并夹在范围内', () => {
    assert.equal(stepNumberText('3', 1, qty), '4');
    assert.equal(stepNumberText('0', -1, qty), '0');
    assert.equal(stepNumberText('9999', 1, qty), '9999');
    assert.equal(stepNumberText('1.5', 1, qty), '2.5');
  });

  it('空的时候点加得到 1（或下限），点减停在下限', () => {
    assert.equal(stepNumberText('', 1, qty), '1');
    assert.equal(stepNumberText('', -1, qty), '0');
    assert.equal(stepNumberText('', 1, { min: 5, max: 10, decimals: 0 }), '5');
  });

  it('当前值低于下限时，按一下就回到下限以上', () => {
    assert.equal(stepNumberText('0', 1, { min: 1, max: 10, decimals: 0 }), '1');
    assert.equal(stepNumberText('0', -1, { min: 1, max: 10, decimals: 0 }), '1');
  });
});
