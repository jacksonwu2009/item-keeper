import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { makeStyles, useColors } from '../hooks/useTheme';
import { font, radius } from '../theme';
import type { IconName } from './ui';

export type OptionCard<T extends string> = { value: T; title: string; description?: string; icon: IconName };

/**
 * 几个大选项里选一个：每项左边圆底图标、中间标题和一句说明、选中的右边打勾。
 * 首次打开时选使用场景、设置里的「使用场景」「颜色模式」面板都用它。
 */
export function OptionCards<T extends string>({
  options,
  value,
  disabled,
  onChoose,
}: {
  options: readonly OptionCard<T>[];
  value: T | null;
  disabled?: boolean;
  onChoose: (value: T) => void;
}) {
  const colors = useColors();
  const optionStyles = useOptionStyles();
  return (
    <View style={optionStyles.list} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChoose(option.value)}
            style={({ pressed }) => [optionStyles.option, selected && optionStyles.selected, pressed && optionStyles.pressed]}
          >
            <View style={[optionStyles.icon, selected && optionStyles.iconSelected]}>
              <Ionicons name={option.icon} size={22} color={selected ? colors.accentInk : colors.accent} />
            </View>
            <View style={optionStyles.text}>
              <Text style={optionStyles.title}>{option.title}</Text>
              {option.description ? <Text style={optionStyles.description}>{option.description}</Text> : null}
            </View>
            {selected ? <Ionicons name="checkmark-circle" size={22} color={colors.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const useOptionStyles = makeStyles((colors) => ({
  list: { gap: 12 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  selected: { backgroundColor: colors.accentSoft },
  pressed: { opacity: 0.7 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  iconSelected: { backgroundColor: colors.accent },
  text: { flex: 1, gap: 4 },
  title: { fontSize: font.heading, fontWeight: '600', color: colors.ink },
  description: { fontSize: font.small, color: colors.muted, lineHeight: 19 },
}));
