/**
 * 配色：偏绿的灰底 + 深青主色，像仓库货架标签。
 * 状态色（过期 / 快到期 / 正常）独立于主色，一眼能分出轻重。
 */
export const colors = {
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
