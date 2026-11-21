/** 底部标签的顺序（路由名和地址一一对应），左右滑动按这个顺序切换。纯函数，有单测。 */

// 每个标签是 app/(tabs) 下的一个文件夹（自己有 _layout，iOS 上包一层系统导航栏），路由名就是文件夹名；
// 首页那个用分组文件夹 (home)，地址还是 /
export const TAB_ROUTES = ['(home)', 'food', 'daily', 'devices', 'settings'] as const;
export const TAB_PATHS = ['/', '/food', '/daily', '/devices', '/settings'] as const;

export type TabRoute = (typeof TAB_ROUTES)[number];

/** 标签的标题：底部标签栏的字、页面标题栏（iOS 上是系统大标题）都用这个 */
export const TAB_TITLES: Record<TabRoute, string> = {
  '(home)': '提醒',
  food: '食品',
  daily: '日用品',
  devices: '设备',
  settings: '设置',
};

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
