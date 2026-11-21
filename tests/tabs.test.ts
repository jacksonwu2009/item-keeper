import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLICK_SPEED, nextTabIndex, ROW_DECIDE_MS, rowSwipeIntent, TAB_PATHS, TAB_ROUTES, tabSlideRange } from '../src/lib/tabs';

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

/** 照 Animated 的 interpolate（线性、两端不外推）算出某个 progress 时页面平移多少 */
function offsetAt(progress: number, range: { inputRange: number[]; outputRange: number[] }): number {
  const { inputRange, outputRange } = range;
  for (let segment = 0; segment < inputRange.length - 1; segment++) {
    const from = inputRange[segment];
    const to = inputRange[segment + 1];
    if (progress >= from && progress <= to) {
      return outputRange[segment] + ((progress - from) / (to - from)) * (outputRange[segment + 1] - outputRange[segment]);
    }
  }
  throw new Error('progress 超出 -1～1');
}

describe('切标签整页平移的方向', () => {
  const width = 400;
  const range = tabSlideRange(width);

  it('往左滑去下一个标签：新页面从右边一整屏外滑到 0，旧页面往左滑出一整屏', () => {
    const next = nextTabIndex(1, -80, 0, 5);
    assert.equal(next, 2);
    // 新页面在当前标签右边：progress 从 1 变到 0
    assert.equal(offsetAt(1, range), width);
    assert.equal(offsetAt(0.5, range), width / 2);
    assert.equal(offsetAt(0, range), 0);
    // 旧页面：progress 从 0 变到 -1
    assert.equal(offsetAt(-1, range), -width);
  });

  it('往右滑回上一个标签：新页面从左边滑进来，旧页面往右滑出去', () => {
    assert.equal(nextTabIndex(2, 80, 0, 5), 1);
    assert.equal(offsetAt(-1, range), -width);
    assert.equal(offsetAt(-0.5, range), -width / 2);
    assert.equal(offsetAt(1, range), width);
  });

  it('新旧两页始终挨着、不重叠：两页的平移差正好一整屏', () => {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      // 往左滑：新页面 progress = p，旧页面 progress = p - 1
      assert.equal(offsetAt(progress, range) - offsetAt(progress - 1, range), width);
    }
  });
});

describe('标签页列表行上的横滑：快速一划切标签，按住慢慢拖是左滑删除', () => {
  it(`行的手势开始后 ${ROW_DECIDE_MS} 毫秒内还不判断（删除按钮不露出来）`, () => {
    assert.equal(rowSwipeIntent(0, -50), 'pending');
    assert.equal(rowSwipeIntent(ROW_DECIDE_MS - 1, -2000), 'pending');
  });

  it(`之后横向速度不到 ${FLICK_SPEED} 点/秒是慢慢拖，露出删除`, () => {
    assert.equal(rowSwipeIntent(ROW_DECIDE_MS, -200), 'drag');
    assert.equal(rowSwipeIntent(400, -(FLICK_SPEED - 1)), 'drag');
    assert.equal(rowSwipeIntent(400, 0), 'drag');
  });

  it(`达到 ${FLICK_SPEED} 点/秒是快速一划，交给切标签`, () => {
    assert.equal(rowSwipeIntent(ROW_DECIDE_MS, -FLICK_SPEED), 'flick');
    assert.equal(rowSwipeIntent(150, -1500), 'flick');
  });

  it('快速一划的速度门槛和切标签的速度门槛一致：判成快速一划的，松手时只要还这么快就会切过去', () => {
    assert.equal(rowSwipeIntent(ROW_DECIDE_MS, -FLICK_SPEED - 1), 'flick');
    assert.equal(nextTabIndex(1, -30, -FLICK_SPEED - 1, 5), 2);
  });
});
