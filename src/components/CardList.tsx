import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '../theme';
import { Chip, LIST_PRESS_DELAY, type IconName, type Tone } from './ui';

/**
 * 列表卡片（盘点列表、清点页、盘点结果用）：白底圆角、自己不留内边距，里面一行一行放 CardListRow。
 * 照鸿蒙版的列表：行与行之间的分隔线左边留 16、右边到头，按下时整行（到卡片边缘）变灰。
 */
export function CardList({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[cardListStyles.card, style]}>{children}</View>;
}

/**
 * 列表卡片里的一行：左右排，最矮 60。first 为 false 时上面画分隔线。
 * 给了 onPress 就能点（按下变灰，chevron 时右边带箭头）；没给就是一行普通的。
 */
export function CardListRow({
  first,
  onPress,
  accessibilityLabel,
  chevron = false,
  style,
  children,
}: {
  first: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  chevron?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <>
      {first ? null : <View style={cardListStyles.divider} />}
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={onPress}
          unstable_pressDelay={LIST_PRESS_DELAY}
          style={({ pressed }) => [cardListStyles.row, style, pressed && cardListStyles.rowPressed]}
        >
          {children}
          {chevron ? <Ionicons name="chevron-forward" size={16} color={colors.faint} /> : null}
        </Pressable>
      ) : (
        <View style={[cardListStyles.row, style]}>{children}</View>
      )}
    </>
  );
}

/**
 * 行右边的状态标签。Chip 自己是靠左上的（alignSelf: flex-start），直接放进行里会贴着行的顶上；
 * 套一层 View 后跟着行上下居中，放在靠右的一列里也会靠右。
 */
export function RowChip({ text, tone, icon }: { text: string; tone?: Tone; icon?: IconName }) {
  return (
    <View>
      <Chip text={text} tone={tone} icon={icon} />
    </View>
  );
}

export const cardListStyles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  // 左边 16（和卡片、分组标题对齐），右边 12（右边一般是状态标签或箭头）
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 60,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 12,
  },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 16 },
  // 行里左边的两行字：标题 + 说明
  main: { flex: 1, minWidth: 0, gap: 2 },
});
