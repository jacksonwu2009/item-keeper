import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nextTabIndex, TAB_PATHS, TAB_ROUTES } from '../src/lib/tabs';

describe('标签页滑动切换', () => {
  it('往左滑去下一个，往右滑回上一个', () => {
    assert.equal(nextTabIndex(1, -80, 0, 5), 2);
    assert.equal(nextTabIndex(1, 80, 0, 5), 0);
  });

  it('滑得不够远但甩得快也算', () => {
    assert.equal(nextTabIndex(2, -30, -900, 5), 3);
    assert.equal(nextTabIndex(2, 30, 900, 5), 1);
  });

  it('滑得太少不切换', () => {
    assert.equal(nextTabIndex(2, -40, -100, 5), 2);
  });

  it('第一个往右、最后一个往左都不动', () => {
    assert.equal(nextTabIndex(0, 100, 0, 5), 0);
    assert.equal(nextTabIndex(4, -100, 0, 5), 4);
  });

  it('路由名和地址一一对应', () => {
    assert.equal(TAB_ROUTES.length, TAB_PATHS.length);
  });
});
