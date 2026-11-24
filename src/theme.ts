import { withAlpha, type ColorScheme } from './lib/colorMode';

/**
 * 配色：偏绿的灰底 + 深青主色，像仓库货架标签。
 * 状态色（过期 / 快到期 / 正常）独立于主色，一眼能分出轻重。
 *
 * 浅色、深色各一套，名字一样。前 18 个和鸿蒙版 color.json 的 ik_xxx 一一对应（深色值照鸿蒙版 dark/element/color.json），
 * 后面几个是这边自己画的控件要用的（遮罩、开关、滚轮、撤销条、左滑删除）。
 *
 * 页面里不要直接引用这两个对象：颜色跟着「颜色模式」变，用 hooks/useTheme 的 useColors() 和 makeStyles()，写法见那个文件开头。
 */
export const lightColors = {
  bg: '#F2F4F1',
  surface: '#FFFFFF',
  surfaceSunken: '#E8ECE7',
  ink: '#18211C',
  muted: '#58665E',
  faint: '#8B978F',
  line: '#D9E0DA',
  accent: '#0D6B5E',
  accentInk: '#FFFFFF',
  accentSoft: '#D5EBE5',
  danger: '#B3261E',
  dangerSoft: '#FBE3E0',
  warn: '#8F5600',
  warnSoft: '#FBEFD5',
  ok: '#2C7A4B',
  okSoft: '#E0F1E6',
  info: '#2E5C99',
  infoSoft: '#E2EBF7',
  /** 底部面板、弹窗后面的半透明遮罩 */
  scrim: 'rgba(16, 24, 20, 0.35)',
  /** 阴影 */
  shadow: '#000000',
  /** 开关关着时的底、圆钮 */
  switchOff: 'rgba(24, 33, 28, 0.16)',
  switchKnob: '#FFFFFF',
  /** iOS 系统开关关着时的底色（系统默认的灰） */
  iosSwitchOff: '#E9E9EA',
  /** 滚轮里离中间两行的字、不能选的字 */
  wheelFar: '#C3CCC6',
  wheelDisabled: '#D3DAD5',
  /** 左滑出来的「删除」：实心红底、上面的字 */
  dangerFill: '#B3261E',
  dangerFillInk: '#FFFFFF',
  /** 底部的「已删除 · 撤销」条：和页面反着来（浅色模式是深色条） */
  toast: '#18211C',
  toastInk: '#FFFFFF',
  toastAction: '#7FD3C3',
};

export type Colors = typeof lightColors;

export const darkColors: Colors = {
  bg: '#101512',
  surface: '#1A201D',
  surfaceSunken: '#232A26',
  ink: '#E6ECE8',
  muted: '#A3B0A8',
  faint: '#75817A',
  line: '#2E3732',
  accent: '#5CC2AE',
  accentInk: '#08201B',
  accentSoft: '#173A33',
  danger: '#F2B8B5',
  dangerSoft: '#4A1C19',
  warn: '#F0C068',
  warnSoft: '#3D2E10',
  ok: '#8FD3A8',
  okSoft: '#173523',
  info: '#A8C7F0',
  infoSoft: '#1A2A40',
  scrim: 'rgba(0, 0, 0, 0.55)',
  shadow: '#000000',
  switchOff: 'rgba(230, 236, 232, 0.2)',
  switchKnob: '#FFFFFF',
  iosSwitchOff: '#39393D',
  wheelFar: '#56615A',
  wheelDisabled: '#3A443F',
  dangerFill: '#B3261E',
  dangerFillInk: '#FFFFFF',
  toast: '#E6ECE8',
  toastInk: '#18211C',
  toastAction: '#0D6B5E',
};

export function colorsFor(scheme: ColorScheme): Colors {
  return scheme === 'dark' ? darkColors : lightColors;
}

/** 从某个底色渐变到透明（滚轮上下两头的渐隐，只有网页画得出来） */
export function fadeFrom(color: string, direction: 'down' | 'up'): string {
  const solid = withAlpha(color, 1);
  const clear = withAlpha(color, 0);
  return direction === 'down' ? `linear-gradient(${solid}, ${clear})` : `linear-gradient(${clear}, ${solid})`;
}

/**
 * 相机取景页（扫码、拍包装）：画面本身是黑的，上面的字、取景框、按钮一直用这一套，不跟颜色模式变。
 */
export const cameraColors = {
  bg: '#0B0F0D',
  ink: '#FFFFFF',
  inkSoft: 'rgba(255,255,255,0.8)',
  /** 白色小块（当前步骤）上的字 */
  inkOnWhite: '#18211C',
};

/**
 * 圆角，和鸿蒙版 Theme.ets 的 CornerRadius 一致：sm 输入框，md 列表行、小方块，lg 卡片。
 * pill 是胶囊形（按钮、搜索框、分段筛选），sheet 是底部面板顶上的两个角。
 */
export const radius = { sm: 8, md: 12, lg: 18, pill: 999, sheet: 28 };

export const font = {
  title: 22,
  heading: 17,
  body: 15,
  small: 13,
  tiny: 11,
};

/** 内容区（卡片、列表、底部面板）最宽多少：平板、电脑上不拉满，和鸿蒙版 CONTENT_MAX_WIDTH 一致 */
export const CONTENT_MAX_WIDTH = 720;
