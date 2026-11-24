import { useSyncExternalStore } from 'react';
import { Appearance, StyleSheet } from 'react-native';

import { rememberNightMode } from '../../modules/night-mode';
import {
  loadColorMode,
  parseSystemScheme,
  resolveColorScheme,
  saveColorMode,
  type ColorMode,
  type ColorScheme,
} from '../lib/colorMode';
import { colorModeStorage } from '../lib/colorModeStorage';
import { colorsFor, type Colors } from '../theme';

/**
 * 颜色跟着「颜色模式」（设置 → 通用）变：跟随系统 / 浅色 / 深色。两套颜色在 theme.ts。
 *
 * 新页面、新组件这样写：
 *
 *   const useStyles = makeStyles((colors) => ({
 *     title: { fontSize: font.heading, color: colors.ink },
 *     card: { backgroundColor: colors.surface },
 *   }));
 *
 *   export function Example() {
 *     const styles = useStyles();          // 样式：和原来的 StyleSheet.create 一样用
 *     const colors = useColors();          // 样式表之外要颜色的地方：图标、占位文字、传给别的库的参数
 *     return <Ionicons name="add" color={colors.accent} />;
 *   }
 *
 * - 用不到颜色的样式照旧写 StyleSheet.create，不用换。
 * - 不要在模块顶层用颜色（顶层只算一次，切了模式不会变）。按状态挑颜色的表写成函数，接一个 colors 参数，
 *   比如 components/ui.tsx 的 toneColors(colors, tone)。
 * - 不要写死色值。色板里没有的先加到 theme.ts 的两套里，浅色、深色都要给。
 * - 相机取景页上的字、取景框是例外：画面一直是黑的，用 theme.ts 的 cameraColors。
 *
 * 切换不用重新挂页面：模式存在下面这个模块级的小仓库里，useColors / useStyles 订阅它，模式一变（或「跟随系统」时系统一变），
 * 用到它们的组件全部重画，已经打开的页面、底部面板、弹窗都跟着变。每套颜色的样式表只建一次，之后直接取。
 */

let mode: ColorMode = loadColorMode(colorModeStorage);
const listeners = new Set<() => void>();

/**
 * 选了浅色 / 深色时告诉系统一声：系统画的东西（对话框、键盘、iOS 的标题栏和滚轮、安卓导航栏的图标）跟着走；跟随系统时撤掉。
 */
function applyNativeOverride(next: ColorMode) {
  try {
    Appearance.setColorScheme?.(next === 'system' ? 'unspecified' : next);
  } catch {
    // 网页等没有这个接口的平台：不影响 App 自己画的部分
  }
}

function readScheme(): ColorScheme {
  return resolveColorScheme(mode, parseSystemScheme(Appearance.getColorScheme()));
}

// 启动时：存的是浅色 / 深色才要告诉系统；跟随系统本来就是默认的
if (mode !== 'system') applyNativeOverride(mode);
let scheme: ColorScheme = readScheme();

function refresh() {
  const next = readScheme();
  if (next === scheme) return;
  scheme = next;
  listeners.forEach((listener) => listener());
}

// 系统切深浅色（「跟随系统」时用得上；选了浅色、深色时算出来不变，不会通知）
Appearance.addChangeListener(refresh);

const modeListeners = new Set<() => void>();

function subscribeScheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function subscribeMode(listener: () => void) {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

/** 设置里选了一项：马上生效并存到本机。返回存上了没有（没存上这次也生效，重开 App 不记得） */
export function setColorMode(next: ColorMode): boolean {
  if (next === mode) return true;
  mode = next;
  applyNativeOverride(next);
  // 安卓上另外让系统记住（modules/night-mode）：下次启动时系统画的开屏就是对应的底色
  rememberNightMode(next);
  modeListeners.forEach((listener) => listener());
  refresh();
  return saveColorMode(colorModeStorage, next);
}

/** 当前选的模式（跟随系统 / 浅色 / 深色） */
export function useColorMode(): ColorMode {
  return useSyncExternalStore(subscribeMode, () => mode, () => mode);
}

/** 现在实际用的是浅色还是深色 */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeScheme, () => scheme, () => scheme);
}

/** 当前这套颜色 */
export function useColors(): Colors {
  return colorsFor(useColorScheme());
}

/** 不在组件里时取当前实际用的深浅色（比如启动时设窗口底色） */
export function currentColorScheme(): ColorScheme {
  return scheme;
}

/** StyleSheet.create 接受的那种对象 */
type StyleInput = Parameters<typeof StyleSheet.create>[0];

/**
 * 按颜色生成样式表，返回一个 hook。写法和 StyleSheet.create 一样，只是外面包一层 (colors) => (...)。
 * 浅色、深色各建一次存着，重画时不重新建。
 */
export function makeStyles<T extends StyleInput>(build: (colors: Colors) => T & StyleInput): () => Readonly<T> {
  const cache: Partial<Record<ColorScheme, Readonly<T>>> = {};
  return function useStyles(): Readonly<T> {
    const current = useColorScheme();
    let sheet = cache[current];
    if (!sheet) {
      sheet = StyleSheet.create(build(colorsFor(current)));
      cache[current] = sheet;
    }
    return sheet;
  };
}
