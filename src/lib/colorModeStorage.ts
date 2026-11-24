import { Storage } from 'expo-sqlite/kv-store';

import type { ColorModeStorage } from './colorMode';

/**
 * 颜色模式存在哪：expo-sqlite 自带的键值存储（单独一个小库文件，不在两个场景的库里，也不进导出的备份）。
 * 用它是因为能同步读：App 一启动、第一屏画出来之前就要知道用哪套颜色，等异步读完再换会先闪一下浅色。
 */
export const colorModeStorage: ColorModeStorage = {
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
};
