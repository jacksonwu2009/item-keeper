import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';

import { nextTabIndex, TAB_PATHS } from '../lib/tabs';

/**
 * 包住一个标签页：在页面上左右滑动切到相邻的标签。
 * 竖着滑（滚动列表）不会触发；列表行上向左滑是删除，由行自己处理。
 */
export function TabSwipe({ index, children }: { index: number; children: ReactNode }) {
  const pan = usePanGesture({
    activeOffsetX: [-24, 24],
    failOffsetY: [-14, 14],
    runOnJS: true,
    onDeactivate: (event) => {
      if (event.canceled) return;
      const next = nextTabIndex(index, event.translationX, event.velocityX, TAB_PATHS.length);
      if (next !== index) router.navigate(TAB_PATHS[next]);
    },
  });
  return (
    <GestureDetector gesture={pan}>
      <View style={tabSwipeStyles.fill}>{children}</View>
    </GestureDetector>
  );
}

const tabSwipeStyles = StyleSheet.create({
  fill: { flex: 1 },
});
