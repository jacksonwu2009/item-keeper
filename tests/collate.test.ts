/**
 * 排序改用模块里建好的比较器：compareZh 要和原来的 localeCompare(…, 'zh') 完全一样，compareDefault 要和不带语言的 localeCompare 一样。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareDefault, compareZh } from '../src/lib/collate';

/** 固定种子的伪随机数，失败时能复现 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const PIECES = ['苹果', '香蕉', '牛奶', '面包', '抽纸', '洗衣液', '可乐', '电池', 'A4纸', 'abc', 'Apple', 'iPhone', '12', '2', '①', ' ', '·', '（大）', '重庆', '长城', '银行', '行李'];

describe('中文名称排序', () => {
  it('随机 2000 组名称：两两比较的正负、排好的顺序都和 localeCompare(…, \'zh\') 一样', () => {
    const random = seeded(3);
    const names = Array.from({ length: 2000 }, () =>
      Array.from({ length: 1 + Math.floor(random() * 3) }, () => PIECES[Math.floor(random() * PIECES.length)]).join(''),
    );
    for (let index = 0; index + 1 < names.length; index++) {
      const [left, right] = [names[index], names[index + 1]];
      assert.equal(Math.sign(compareZh(left, right)), Math.sign(left.localeCompare(right, 'zh')), `${left} / ${right}`);
    }
    assert.deepEqual([...names].sort(compareZh), [...names].sort((left, right) => left.localeCompare(right, 'zh')));
  });

  it('不带语言的比较（名称、ISO 时间、日期、空串）：两两比较的正负、排好的顺序都和 localeCompare 一样', () => {
    const random = seeded(5);
    const values = Array.from({ length: 2000 }, (_, index) => {
      const roll = random();
      if (roll < 0.3) return new Date(Date.UTC(2026, Math.floor(random() * 12), 1 + Math.floor(random() * 28), Math.floor(random() * 24))).toISOString();
      if (roll < 0.5) return `2026-${String(1 + Math.floor(random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`;
      if (roll < 0.55) return '';
      return PIECES[index % PIECES.length] + PIECES[Math.floor(random() * PIECES.length)];
    });
    for (let index = 0; index + 1 < values.length; index++) {
      const [left, right] = [values[index], values[index + 1]];
      assert.equal(Math.sign(compareDefault(left, right)), Math.sign(left.localeCompare(right)), `${left} / ${right}`);
    }
    assert.deepEqual([...values].sort(compareDefault), [...values].sort((left, right) => left.localeCompare(right)));
  });
});
