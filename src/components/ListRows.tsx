import Ionicons from '@expo/vector-icons/Ionicons';
import { Children, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';

import { makeStyles, useColors } from '../hooks/useTheme';
import { font, radius } from '../theme';
import { SwitchRow, toneColors, type Tone } from './ui';

/**
 * 鸿蒙版设置页那种「一项一行」的列表（照鸿蒙版 ui/components 的 SectionCard、ListRow、ToggleRow）：
 * ListCard 是白底圆角的分组卡片，行间画分隔线；行自己留边距，整行可点、按下整行变色。
 * 和 ui.tsx 的 GroupCard 的差别：GroupCard 给每一行留边距，放的是普通内容；ListCard 不留，放 ListRow、ToggleRow。
 */

/** 分组卡片：每个子元素是一行，行与行之间画分隔线（左边留空、右边到头）；null、false 不算一行 */
export function ListCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const rowStyles = useRowStyles();
  const rows = Children.toArray(children);
  return (
    <View style={[rowStyles.card, style]}>
      {rows.map((row, index) => (
        <View key={isValidElement(row) && row.key !== null ? row.key : index}>
          {index > 0 ? <View style={rowStyles.divider} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

/**
 * 列表的一行（设置项、进下一页的入口）：左边标题、下面一行小字说明，右边当前值和右箭头。
 * 给了 onPress 整行可点、按下变色；tone 给操作行的标题上色。
 */
export function ListRow({
  title,
  subtitle,
  value,
  chevron,
  tone,
  right,
  disabled,
  onPress,
}: {
  title: string;
  subtitle?: string | null;
  /** 右边的当前值（「到期前 7 天」「09:00」「3 个」） */
  value?: string | null;
  /** 右边画箭头：点了进下一页或打开面板 */
  chevron?: boolean;
  tone?: Tone;
  /** 右边的其他东西（比如转圈） */
  right?: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const colors = useColors();
  const rowStyles = useRowStyles();
  const content = (
    <>
      <View style={rowStyles.text}>
        <Text style={[rowStyles.title, tone ? { color: toneColors(colors, tone).fg } : null]}>{title}</Text>
        {subtitle ? <Text style={rowStyles.subtitle}>{subtitle}</Text> : null}
      </View>
      {right}
      {value ? (
        <Text style={rowStyles.value} numberOfLines={1} selectable={!onPress}>
          {value}
        </Text>
      ) : null}
      {chevron ? <Ionicons name="chevron-forward" size={16} color={colors.faint} /> : null}
    </>
  );
  if (!onPress) return <View style={rowStyles.row}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed, disabled && rowStyles.disabled]}
    >
      {content}
    </Pressable>
  );
}

/** 带开关的一行：左边标题和说明，右边开关（就是 ui.tsx 的 SwitchRow，留出和 ListRow 一样的边距、高度） */
export function ToggleRow(props: { title: string; description?: string; value: boolean; onChange: (value: boolean) => void }) {
  const rowStyles = useRowStyles();
  return (
    <View style={rowStyles.row}>
      <View style={rowStyles.text}>
        <SwitchRow {...props} />
      </View>
    </View>
  );
}

/** 分组卡片下面的小字说明（鸿蒙版设置页把说明放在卡片下面） */
export function Footnote({ children, tone }: { children: ReactNode; tone?: Tone }) {
  const colors = useColors();
  const rowStyles = useRowStyles();
  return <Text style={[rowStyles.footnote, tone ? { color: toneColors(colors, tone).fg } : null]}>{children}</Text>;
}

// 尺寸照鸿蒙版 ListRow：行至少 56 高，左边 16、右边 12（右边是箭头），分隔线从左边 16 开始
const useRowStyles = makeStyles((colors) => ({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 56,
    paddingVertical: 10,
    paddingLeft: 16,
    paddingRight: 12,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.surfaceSunken },
  disabled: { opacity: 0.5 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: font.body, color: colors.ink },
  subtitle: { fontSize: font.small, color: colors.muted, lineHeight: 18 },
  value: { fontSize: font.body, color: colors.muted, flexShrink: 1, maxWidth: '60%', textAlign: 'right' },
  footnote: { fontSize: font.small, color: colors.muted, lineHeight: 18, paddingHorizontal: 4 },
}));
