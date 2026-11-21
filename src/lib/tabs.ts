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

/** 根据滑动距离和速度决定去哪个标签；不切换时返回当前的。往左滑去下一个，往右滑回上一个。手势回调在界面线程上调用（worklet）。 */
export function nextTabIndex(current: number, translationX: number, velocityX: number, count: number): number {
  'worklet';
  let next = current;
  if (translationX < -SWIPE_DISTANCE || velocityX < -SWIPE_VELOCITY) next = current + 1;
  else if (translationX > SWIPE_DISTANCE || velocityX > SWIPE_VELOCITY) next = current - 1;
  return Math.min(count - 1, Math.max(0, next));
}

/** 左右滑动切标签时，新页面整页滑进来用多久（毫秒）；点标签栏切换不要动画 */
export const TAB_SLIDE_MS = 250;

/**
 * 切标签时整页平移：每个标签页按它在当前标签的哪一边放——右边的（progress = 1）在右边一整屏外，左边的（-1）在左边一整屏外。
 * 往左滑去下一个标签：新页面 progress 从 1 变到 0，从右边滑进来，旧页面从 0 变到 -1 往左滑出去；往右滑反过来。
 * 只平移、不改透明度，新旧两页不会半透明地叠在一起。
 */
export function tabSlideRange(width: number): { inputRange: number[]; outputRange: number[] } {
  return { inputRange: [-1, 0, 1], outputRange: [-width, 0, width] };
}

/**
 * 标签页里列表行上的横滑归谁：列表行的左滑删除，还是外层的左右滑动切标签。
 * 行的手势在手指往左横移 12 后开始；开始后的前 ROW_DECIDE_MS 毫秒删除按钮不露出来，之后手指第一次移动时看横向速度：
 * - 不到 FLICK_SPEED（点/秒）：按住慢慢拖 → 行跟着手指露出删除按钮（这次松手不切标签）；
 * - 达到了：快速一划 → 行不动，交给外层切标签（外层再按 nextTabIndex 的距离、速度决定切不切）。
 * 只判断一次；还没判断出来就松手的也算快速一划。
 */
export const ROW_DECIDE_MS = 100;
/** 和切标签的「甩得快」用同一个门槛：判成快速一划的，松手时只要还这么快就会切过去 */
export const FLICK_SPEED = SWIPE_VELOCITY;

export type RowSwipeIntent = 'pending' | 'drag' | 'flick';

/** elapsedMs：行的手势开始了多久；velocityX：手指现在的横向速度（点/秒，往左为负） */
export function rowSwipeIntent(elapsedMs: number, velocityX: number): RowSwipeIntent {
  'worklet';
  if (elapsedMs < ROW_DECIDE_MS) return 'pending';
  return Math.abs(velocityX) < FLICK_SPEED ? 'drag' : 'flick';
}
