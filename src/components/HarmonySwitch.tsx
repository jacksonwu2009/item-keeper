import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable } from 'react-native';

import { makeStyles, useColors } from '../hooks/useTheme';

/**
 * 鸿蒙版样式的开关：细长的胶囊底（开：主色，关：浅灰），白色圆钮在里面左右滑。
 * 系统 Switch 在安卓上是 Material 样式（圆钮比底大、伸出去），iOS 又是另一种，这里自己画，安卓、iOS、网页长得一样。
 */
const TRACK_WIDTH = 40;
const TRACK_HEIGHT = 24;
const KNOB_GAP = 2;
const KNOB_SIZE = TRACK_HEIGHT - KNOB_GAP * 2;
const KNOB_TRAVEL = TRACK_WIDTH - KNOB_SIZE - KNOB_GAP * 2;
/** 关着时的底色（colors.switchOff）：鸿蒙系统开关关着是半透明的深色，落在白卡片上是浅灰；深色模式下反过来，半透明的浅色 */

/** 只画样子、不处理点按（放在整行可点的 SwitchRow 里用） */
export function SwitchTrack({ value, disabled = false }: { value: boolean; disabled?: boolean }) {
  const colors = useColors();
  const switchStyles = useSwitchStyles();
  const [progress] = useState(() => new Animated.Value(value ? 1 : 0));

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [progress, value]);

  const trackColor = progress.interpolate({ inputRange: [0, 1], outputRange: [colors.switchOff, colors.accent] });
  const knobOffset = progress.interpolate({ inputRange: [0, 1], outputRange: [0, KNOB_TRAVEL] });

  return (
    <Animated.View style={[switchStyles.track, { backgroundColor: trackColor }, disabled ? switchStyles.disabled : null]}>
      <Animated.View style={[switchStyles.knob, { transform: [{ translateX: knobOffset }] }]} />
    </Animated.View>
  );
}

/** 单独用的开关（自己处理点按） */
export function HarmonySwitch({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
    >
      <SwitchTrack value={value} disabled={disabled} />
    </Pressable>
  );
}

const useSwitchStyles = makeStyles((colors) => ({
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    padding: KNOB_GAP,
    justifyContent: 'center',
  },
  knob: {
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    backgroundColor: colors.switchKnob,
    shadowColor: colors.shadow,
    shadowOpacity: 0.18,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  disabled: { opacity: 0.4 },
}));
