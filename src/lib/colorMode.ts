/**
 * 颜色模式（设置 → 通用 →「颜色模式」）：跟随系统 / 浅色 / 深色。整个 App 一份，不分家庭、办公场景，只存在本机。
 * 这里只放算法（存什么、怎么读、最后用哪套颜色），不碰界面和存储，方便单测；存取见 colorModeStorage，界面用 hooks/useTheme。
 */
export type ColorMode = 'system' | 'light' | 'dark';
/** 最后用哪套颜色 */
export type ColorScheme = 'light' | 'dark';

export const DEFAULT_COLOR_MODE: ColorMode = 'system';
/** 设置面板里从上到下的顺序 */
export const COLOR_MODES: readonly ColorMode[] = ['system', 'light', 'dark'];
export const COLOR_MODE_LABELS: Record<ColorMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
/** 本机小存储里的键 */
export const COLOR_MODE_STORAGE_KEY = 'colorMode';

export function isColorMode(value: unknown): value is ColorMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** 存着的值读成模式：没存过、存坏了都按跟随系统 */
export function parseColorMode(raw: string | null | undefined): ColorMode {
  return isColorMode(raw) ? raw : DEFAULT_COLOR_MODE;
}

/** 系统报的深浅色：只认 dark，别的（light、读不到、没指定）都当浅色 */
export function parseSystemScheme(raw: string | null | undefined): ColorScheme {
  return raw === 'dark' ? 'dark' : 'light';
}

/** 模式加上系统当前的深浅色，算出最后用哪套：选了浅色、深色就不看系统 */
export function resolveColorScheme(mode: ColorMode, system: ColorScheme): ColorScheme {
  return mode === 'system' ? system : mode;
}

/** 读写本机小存储的最小接口（手机上是 expo-sqlite 的键值存储，网页是 localStorage） */
export type ColorModeStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

/** 启动时读：存储读不了（出错）也按跟随系统，不能让 App 起不来 */
export function loadColorMode(storage: ColorModeStorage): ColorMode {
  try {
    return parseColorMode(storage.getItem(COLOR_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_COLOR_MODE;
  }
}

/** 存：没存上返回 false（这次照样生效，只是重开 App 不记得） */
export function saveColorMode(storage: ColorModeStorage, mode: ColorMode): boolean {
  try {
    storage.setItem(COLOR_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

/** #RRGGBB 加上透明度，写成 rgba(...)：遮罩、渐隐这类半透明色从色板里的颜色算出来 */
export function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function channelLuminance(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channelLuminance((value >> 16) & 255) +
    0.7152 * channelLuminance((value >> 8) & 255) +
    0.0722 * channelLuminance(value & 255)
  );
}

/** 两个 #RRGGBB 的对比度（WCAG 的算法，1–21）：正文要不低于 4.5 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
