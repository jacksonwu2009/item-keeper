import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, radius } from '../theme';

/**
 * 列表里的一行：点按打开，长按编辑，向左滑出现「删除」，点删除就删。
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
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="删除"
          onPress={remove}
          style={({ pressed }) => [swipeStyles.deleteAction, pressed && { opacity: 0.8 }]}
        >
          <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
          <Text style={swipeStyles.deleteText}>删除</Text>
        </Pressable>
      )}
    >
      <Pressable
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
        delayLongPress={350}
        style={({ pressed }) => [style, pressed && pressedStyle]}
      >
        {children}
      </Pressable>
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
  deleteAction: {
    width: 84,
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
