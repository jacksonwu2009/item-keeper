/** 底部标签的顺序（路由名和地址一一对应），左右滑动按这个顺序切换。纯函数，有单测。 */

export const TAB_ROUTES = ['index', 'food', 'daily', 'devices', 'settings'] as const;
export const TAB_PATHS = ['/', '/food', '/daily', '/devices', '/settings'] as const;

/** 滑过这么远，或者甩得这么快，才算要切换 */
const SWIPE_DISTANCE = 60;
const SWIPE_VELOCITY = 500;

/** 根据滑动距离和速度决定去哪个标签；不切换时返回当前的。往左滑去下一个，往右滑回上一个。 */
export function nextTabIndex(current: number, translationX: number, velocityX: number, count: number): number {
  let next = current;
  if (translationX < -SWIPE_DISTANCE || velocityX < -SWIPE_VELOCITY) next = current + 1;
  else if (translationX > SWIPE_DISTANCE || velocityX > SWIPE_VELOCITY) next = current - 1;
  return Math.min(count - 1, Math.max(0, next));
}
