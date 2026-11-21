import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture, type PanGesture, type PanGestureConfig } from 'react-native-gesture-handler';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { nextTabIndex, TAB_PATHS } from '../lib/tabs';

type TabSwipeShared = {
  /** 外层切标签的手势：列表行的左滑和它同时识别（见 SwipeRow） */
  gesture: PanGesture;
  /** 这次横滑被列表行拿去拖开删除了：松手时不切标签。每次按下时清掉 */
  rowOwnsSwipe: SharedValue<boolean>;
};

const TabSwipeContext = createContext<TabSwipeShared | null>(null);

/** 列表行用：所在的标签页的切标签手势；不在标签页里（详情页这些）是 null */
export function useTabSwipe(): TabSwipeShared | null {
  return useContext(TabSwipeContext);
}

/**
 * 包住一个标签页：在页面上左右滑动切到相邻的标签（onSwipeTo 收到要去的标签序号）。
 * 竖着滑（滚动列表）不会触发。列表行上横滑时两个手势同时识别：快速一划切标签，按住慢慢拖是行的左滑删除，
 * 由行判断（规则见 lib/tabs 的 rowSwipeIntent），行拿去拖开删除时这里松手不切。
 */
export function TabSwipe({ index, onSwipeTo, children }: { index: number; onSwipeTo: (next: number) => void; children: ReactNode }) {
  const rowOwnsSwipe = useSharedValue(false);
  // 配置记下来：外层布局每次重画时手势对象不变，列表行不用跟着重画
  const config = useMemo<PanGestureConfig>(
    () => ({
      activeOffsetX: [-24, 24],
      failOffsetY: [-14, 14],
      onBegin: () => {
        'worklet';
        rowOwnsSwipe.set(false);
      },
      onDeactivate: (event) => {
        'worklet';
        if (event.canceled || rowOwnsSwipe.get()) return;
        const next = nextTabIndex(index, event.translationX, event.velocityX, TAB_PATHS.length);
        if (next !== index) scheduleOnRN(onSwipeTo, next);
      },
    }),
    [index, onSwipeTo, rowOwnsSwipe],
  );
  const pan = usePanGesture(config);
  const shared = useMemo(() => ({ gesture: pan, rowOwnsSwipe }), [pan, rowOwnsSwipe]);
  return (
    <TabSwipeContext.Provider value={shared}>
      <GestureDetector gesture={pan}>
        <View style={tabSwipeStyles.fill}>{children}</View>
      </GestureDetector>
    </TabSwipeContext.Provider>
  );
}

const tabSwipeStyles = StyleSheet.create({
  fill: { flex: 1 },
});
