import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Pressable as GesturePressable } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, radius } from '../theme';

/** 同一时间只让一行露出「删除」：新的一行滑开时，把上一行收回去。 */
let openRow: SwipeableMethods | null = null;

/**
 * 删除按钮一直垫在这一行下面，行滑开才露出来。
 * 没滑开时把它隐藏，免得红色从圆角、细边框的缝里透出来。
 */
function DeleteAction({ progress, onPress }: { progress: SharedValue<number>; onPress: () => void }) {
  const visible = useAnimatedStyle(() => ({ opacity: progress.value > 0.02 ? 1 : 0 }));
  return (
    <Animated.View style={[swipeStyles.deleteWrap, visible]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="删除"
        onPress={onPress}
        style={({ pressed }) => [swipeStyles.deleteAction, pressed && { opacity: 0.8 }]}
      >
        <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
        <Text style={swipeStyles.deleteText}>删除</Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * 列表里的一行：点按打开，长按编辑，向左滑出现「删除」，点删除就删。
 * 点按和长按用手势库自己的 Pressable：手指一开始横着滑，它就取消这次点按、长按，
 * 不会滑到一半弹出编辑页，也不会一直保持按下的灰色。
 * 读屏用户可以从「操作」菜单里选编辑和删除。
 */
export function SwipeRow({
  children,
  onPress,
  onLongPress,
  onDelete,
  style,
  pressedStyle,
  rounded = true,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  onDelete: () => void;
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  /** 整行是独立卡片时圆角（列表）；在卡片里的一行时不圆角（批次） */
  rounded?: boolean;
  accessibilityLabel?: string;
}) {
  const swipeable = useRef<SwipeableMethods>(null);

  function remove() {
    swipeable.current?.close();
    if (openRow === swipeable.current) openRow = null;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    onDelete();
  }

  function longPress() {
    if (!onLongPress) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    onLongPress();
  }

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      // 只响应向左滑（删除）；向右滑交给外层，用来切换标签
      dragOffsetFromLeft={10000}
      containerStyle={rounded ? swipeStyles.roundedContainer : undefined}
      onSwipeableWillOpen={() => {
        if (openRow && openRow !== swipeable.current) openRow.close();
        openRow = swipeable.current;
      }}
      onSwipeableClose={() => {
        if (openRow === swipeable.current) openRow = null;
      }}
      renderRightActions={(progress) => <DeleteAction progress={progress} onPress={remove} />}
    >
      <GesturePressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="长按编辑，向左滑删除"
        accessibilityActions={[
          ...(onLongPress ? [{ name: 'longpress', label: '编辑' }] : []),
          { name: 'delete', label: '删除' },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'delete') remove();
          if (event.nativeEvent.actionName === 'longpress') longPress();
        }}
        onPress={onPress}
        onLongPress={onLongPress ? longPress : undefined}
        delayLongPress={400}
        style={({ pressed }) => [style, pressed && pressedStyle]}
      >
        {children}
      </GesturePressable>
    </ReanimatedSwipeable>
  );
}

/** 删除后底部出现几秒的「撤销」条。 */
export function UndoBar({ text, onUndo }: { text: string; onUndo: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[swipeStyles.undoBar, { left: 16 + insets.left, right: 16 + insets.right }]}
      accessibilityLiveRegion="polite"
    >
      <Text style={swipeStyles.undoText} numberOfLines={2}>
        {text}
      </Text>
      <Pressable accessibilityRole="button" onPress={onUndo} hitSlop={10} style={swipeStyles.undoButton}>
        <Text style={swipeStyles.undoButtonText}>撤销</Text>
      </Pressable>
    </View>
  );
}

const swipeStyles = StyleSheet.create({
  roundedContainer: { borderRadius: radius.md, overflow: 'hidden' },
  deleteWrap: { width: 84 },
  deleteAction: {
    flex: 1,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  deleteText: { color: '#FFFFFF', fontSize: font.small, fontWeight: '700' },
  undoBar: {
    position: 'absolute',
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 16,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  undoText: { flex: 1, color: '#FFFFFF', fontSize: font.body },
  undoButton: { paddingHorizontal: 4 },
  undoButtonText: { color: '#7FD3C3', fontSize: font.body, fontWeight: '700' },
});
