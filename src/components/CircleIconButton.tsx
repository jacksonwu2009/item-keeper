import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useColors } from '../hooks/useTheme';
import type { Colors } from '../theme';
import type { IconName } from './ui';

type CircleTone = 'neutral' | 'accent' | 'plain';

/** 三种底色：浅灰底深色图标（返回、关闭）、浅主色底主色图标（输入框旁的扫码）、透明底（行里的删除） */
function circleTone(colors: Colors, tone: CircleTone): { bg: string; fg: string } {
  switch (tone) {
    case 'neutral':
      return { bg: colors.surfaceSunken, fg: colors.ink };
    case 'accent':
      return { bg: colors.accentSoft, fg: colors.accent };
    case 'plain':
      return { bg: 'transparent', fg: colors.accent };
  }
}

/**
 * 圆形图标按钮，照鸿蒙版 Button({ type: ButtonType.Circle })：二级页左上角的返回、输入框右边的扫码、包装规格行的删除。
 * size 是圆的直径，图标约占一半多一点；color 不传就用底色对应的图标色。
 */
export function CircleIconButton({
  icon,
  label,
  onPress,
  tone = 'neutral',
  size = 40,
  color,
  style,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: CircleTone;
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const palette = circleTone(colors, tone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        circleStyles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: palette.bg },
        pressed && circleStyles.pressed,
        style,
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.55)} color={color ?? palette.fg} />
    </Pressable>
  );
}

const circleStyles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
