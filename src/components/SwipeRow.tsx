import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { GestureDetector, Pressable as GesturePressable, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { rowSwipeIntent, type RowSwipeIntent } from '../lib/tabs';
import { makeStyles, useColors } from '../hooks/useTheme';
import { font, radius } from '../theme';
import { useTabSwipe } from './TabSwipe';
import { LIST_PRESS_DELAY } from './ui';

const ACTION_WIDTH = 84;
const ANIMATION = { duration: 180 };
/** 收起时向右滑要滑这么远才算（等于不认右滑，让给外层切标签）；滑开后改成 12，向右滑就收回 */
const CLOSED_RIGHT_ACTIVATION = 10000;
const OPEN_RIGHT_ACTIVATION = 12;

/** 同一时间只让一行露出「删除」：新的一行滑开时，把上一行收回去。owner 用来认是哪一行。 */
let openRow: { owner: object; close: () => void } | null = null;

/**
 * 列表里的一行：点按打开，长按编辑，向左滑从右边滑出「删除」，点删除就删。
 *
 * 这一行本身不动，红色「删除」从右边滑进来，盖住右侧的数量那一块；
 * 左边的名称、标签一直看得见（整行左移会把短名称整个推出屏幕，看着像内容没了）。
 * 点按、长按用手势库的 Pressable：手指一开始横着滑就取消，不会滑到一半弹出编辑页。
 * 只认向左滑；向右滑留给外层切换标签（已经滑开时向右滑是收回）。
 * 在标签页里时，向左滑和外层切标签的手势同时识别：快速一划是切标签，删除按钮不露出来；按住慢慢拖才是左滑删除
 * （规则见 lib/tabs 的 rowSwipeIntent）。不在标签页里（详情页的列表）照旧一滑就跟手。
 * 读屏用户可以从「操作」菜单里选编辑和删除。
 */
export function SwipeRow({
  children,
  onPress,
  onLongPress,
  onDelete,
  style,
  pressedStyle,
  accessibilityLabel,
  cornerRadius = radius.md,
}: {
  children: ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  onDelete: () => void;
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** 外框圆角（裁掉滑出来的删除按钮的角），和这一行卡片自己的圆角一样；默认 radius.md */
  cornerRadius?: number;
}) {
  /** 删除按钮露出来多少：0 = 收起，ACTION_WIDTH = 完全露出 */
  const colors = useColors();
  const swipeStyles = useSwipeStyles();
  const reveal = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const rightActivation = useSharedValue(CLOSED_RIGHT_ACTIVATION);
  const tabSwipe = useTabSwipe();
  const insideTabs = tabSwipe !== null;
  const rowOwnsSwipe = tabSwipe?.rowOwnsSwipe;
  /** 这次横滑：还在判断 / 按住慢慢拖（跟手露出删除）/ 快速一划（交给外层切标签） */
  const intent = useSharedValue<RowSwipeIntent>('drag');
  const activatedAt = useSharedValue(0);

  const [owner] = useState(() => ({}));

  const markClosed = useCallback(() => {
    if (openRow?.owner === owner) openRow = null;
  }, [owner]);

  const close = useCallback(() => {
    reveal.set(withTiming(0, ANIMATION));
    rightActivation.set(CLOSED_RIGHT_ACTIVATION);
    markClosed();
  }, [reveal, rightActivation, markClosed]);

  const markOpen = useCallback(() => {
    if (openRow && openRow.owner !== owner) openRow.close();
    openRow = { owner, close };
  }, [owner, close]);

  // 这一行被移除（比如删掉了）时，别让它占着「已打开」的位置
  useEffect(() => markClosed, [markClosed]);

  const pan = usePanGesture({
    activeOffsetX: [-12, rightActivation],
    failOffsetY: [-12, 12],
    simultaneousWith: tabSwipe?.gesture,
    onActivate: () => {
      'worklet';
      dragStart.set(reveal.get());
      activatedAt.set(Date.now());
      // 不在标签页里（没有要让的手势）、或者已经滑开了（这次是收回或接着拉）：直接跟手，这次松手也不切标签
      const followNow = !insideTabs || reveal.get() > 0;
      intent.set(followNow ? 'drag' : 'pending');
      if (followNow && rowOwnsSwipe) rowOwnsSwipe.set(true);
    },
    onUpdate: (event) => {
      'worklet';
      if (intent.get() === 'pending') {
        const decided = rowSwipeIntent(Date.now() - activatedAt.get(), event.velocityX);
        intent.set(decided);
        if (decided === 'drag' && rowOwnsSwipe) rowOwnsSwipe.set(true);
      }
      if (intent.get() !== 'drag') return;
      const next = dragStart.get() - event.translationX;
      reveal.set(Math.min(ACTION_WIDTH, Math.max(0, next)));
    },
    onDeactivate: (event) => {
      'worklet';
      // 快速一划、或者还没判断出来就松手：删除按钮一直没露出来，交给外层切标签
      if (intent.get() !== 'drag') return;
      const open = (reveal.get() > ACTION_WIDTH / 2 || event.velocityX < -500) && event.velocityX <= 500;
      if (open) {
        reveal.set(withTiming(ACTION_WIDTH, ANIMATION));
        rightActivation.set(OPEN_RIGHT_ACTIVATION);
        scheduleOnRN(markOpen);
      } else {
        reveal.set(withTiming(0, ANIMATION));
        rightActivation.set(CLOSED_RIGHT_ACTIVATION);
        scheduleOnRN(markClosed);
      }
    },
  });

  // 收起时完全隐藏：只靠移出右边界的话，像素取整后会露出一条细红线
  const panelStyle = useAnimatedStyle(() => ({
    opacity: reveal.get() > 0.5 ? 1 : 0,
    transform: [{ translateX: ACTION_WIDTH - reveal.get() }],
  }));

  function remove() {
    close();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    onDelete();
  }

  function press() {
    // 已经滑开时点这一行，是收回，不是打开
    if (reveal.get() > 4) {
      close();
      return;
    }
    onPress();
  }

  function longPress() {
    if (!onLongPress || reveal.get() > 4) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    onLongPress();
  }

  return (
    <View style={[swipeStyles.container, { borderRadius: cornerRadius }]}>
      <GestureDetector gesture={pan}>
        <View collapsable={false}>
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
            onPress={press}
            onLongPress={onLongPress ? longPress : undefined}
            unstable_pressDelay={LIST_PRESS_DELAY}
            delayLongPress={400 - LIST_PRESS_DELAY}
            style={({ pressed }) => [style, pressed && pressedStyle]}
          >
            {children}
          </GesturePressable>
          <Animated.View
            style={[swipeStyles.panel, panelStyle]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="删除"
              onPress={remove}
              style={({ pressed }) => [swipeStyles.deleteAction, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="trash-outline" size={20} color={colors.dangerFillInk} />
              <Text style={swipeStyles.deleteText}>删除</Text>
            </Pressable>
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}

/** 删除后底部出现几秒的「撤销」条。 */
export function UndoBar({ text, onUndo }: { text: string; onUndo: () => void }) {
  const swipeStyles = useSwipeStyles();
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

const useSwipeStyles = makeStyles((colors) => ({
  // 每一行都是一张圆角卡片；收起时删除按钮停在右边界外，靠 overflow 和透明度藏起来
  container: { overflow: 'hidden', borderRadius: radius.md },
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: ACTION_WIDTH,
  },
  deleteAction: {
    flex: 1,
    backgroundColor: colors.dangerFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  deleteText: { color: colors.dangerFillInk, fontSize: font.small, fontWeight: '700' },
  undoBar: {
    position: 'absolute',
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.toast,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 16,
    shadowColor: colors.shadow,
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  undoText: { flex: 1, color: colors.toastInk, fontSize: font.body },
  undoButton: { paddingHorizontal: 4 },
  undoButtonText: { color: colors.toastAction, fontSize: font.body, fontWeight: '700' },
}));
