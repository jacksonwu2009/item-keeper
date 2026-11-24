import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { moreText } from '../lib/reminderList';
import { makeStyles, useColors } from '../hooks/useTheme';
import { font } from '../theme';
import { Card, Chip, LIST_PRESS_DELAY, type Tone } from './ui';

/** 提醒页和「查看全部」页共用：一组列表的白卡片（不留内边距，按下的底色铺满整行） */
export function ReminderCard({ children }: { children: ReactNode }) {
  const rowStyles = useRowStyles();
  return <Card style={rowStyles.card}>{children}</Card>;
}

/** 一行：左边名称和一行说明，右边状态标签和箭头 */
export function ReminderRow({
  title,
  subtitle,
  chip,
  first,
  onPress,
}: {
  title: string;
  subtitle: string;
  chip: { text: string; tone: Tone };
  first: boolean;
  onPress: () => void;
}) {
  // 分隔线单独画，左边留空、右边到头
  const colors = useColors();
  const rowStyles = useRowStyles();
  return (
    <>
      {first ? null : <View style={rowStyles.divider} />}
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
      >
        <View style={rowStyles.main}>
          <Text style={rowStyles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={rowStyles.sub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Chip text={chip.text} tone={chip.tone} />
        <Ionicons name="chevron-forward" size={16} color={colors.faint} />
      </Pressable>
    </>
  );
}

/** 卡片最后一行「查看全部 12 样 ›」 */
export function ReminderMoreRow({ total, onPress }: { total: number; onPress: () => void }) {
  const colors = useColors();
  const rowStyles = useRowStyles();
  return (
    <>
      <View style={rowStyles.divider} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={moreText(total)}
        onPress={onPress}
        style={({ pressed }) => [rowStyles.more, pressed && rowStyles.pressed]}
      >
        <Text style={rowStyles.moreText}>{moreText(total)}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.accent} />
      </Pressable>
    </>
  );
}

const useRowStyles = makeStyles((colors) => ({
  card: { padding: 0, gap: 0, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 56,
    paddingVertical: 10,
    paddingLeft: 16,
    paddingRight: 12,
  },
  pressed: { backgroundColor: colors.surfaceSunken },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 16 },
  main: { flex: 1, minWidth: 0, gap: 2, marginRight: 4 },
  title: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  sub: { fontSize: font.small, color: colors.muted },
  more: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  moreText: { fontSize: font.body, color: colors.accent, fontWeight: '500' },
}));
