import { Ionicons } from '@expo/vector-icons';
import { router, Tabs } from 'expo-router';
import type { BottomTabBarButtonProps, BottomTabNavigationOptions } from 'expo-router/tabs';
import { useCallback, useState } from 'react';
import { Easing, Platform, Pressable, useWindowDimensions, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfficeSwitcher } from '../../components/OfficeSwitcher';
import { TabSwipe } from '../../components/TabSwipe';
import type { IconName } from '../../components/ui';
import { TAB_PATHS, TAB_ROUTES, TAB_SLIDE_MS, TAB_TITLES, tabSlideRange, type TabRoute } from '../../lib/tabs';
import { useColors } from '../../hooks/useTheme';

/** 标签栏图标：选中的用实心图标，没选中的用线条图标（和鸿蒙版底部标签栏一样） */
function tabIcon(name: IconName, focusedName: IconName) {
  function TabBarIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? focusedName : name} size={size} color={typeof color === 'string' ? color : undefined} />;
  }
  return TabBarIcon;
}

const WEB_TAB_BAR_HEIGHT = 56;

type TransitionSpec = NonNullable<BottomTabNavigationOptions['transitionSpec']>;
type SceneStyleInterpolator = NonNullable<BottomTabNavigationOptions['sceneStyleInterpolator']>;

/** 左右滑动切标签：新页面整页滑进来，开头快、结尾慢 */
const SLIDE_SPEC: TransitionSpec = { animation: 'timing', config: { duration: TAB_SLIDE_MS, easing: Easing.out(Easing.cubic) } };
/** 点标签栏切换：直接切过去。不能把动画选项整个去掉：有没有动画决定导航库用哪种页面容器，来回换会把五个标签页全部重建 */
const NO_ANIMATION_SPEC: TransitionSpec = { animation: 'timing', config: { duration: 0 } };

/** 整页平移（规则见 lib/tabs 的 tabSlideRange） */
function slideInterpolator(width: number): SceneStyleInterpolator {
  const range = tabSlideRange(width);
  return ({ current }) => ({ sceneStyle: { transform: [{ translateX: current.progress.interpolate(range) }] } });
}

/**
 * 安卓的标签按钮：导航库默认的按钮按下时有一圈灰色水波纹，换成不带水波纹的；按下后只是图标和文字变成选中的颜色。
 * 导航库给按钮的水波纹、按下变淡、网页悬停这些参数不往下传。iOS、网页还用导航库自己的按钮（本来就没有水波纹）。
 */
function TabBarButtonWithoutRipple({
  onPress,
  pressColor: _pressColor,
  pressOpacity: _pressOpacity,
  hoverEffect: _hoverEffect,
  android_ripple: _androidRipple,
  href: _href,
  ref: _ref,
  ...rest
}: BottomTabBarButtonProps) {
  return <Pressable {...rest} onPress={(event) => onPress?.(event)} />;
}

/**
 * 启动时五个标签页一起建好（手机）：切过去时页面和数据已经在，不会先空白再出数据。
 * 网页版照旧第一次点到才建，行为不变。
 */
const PRELOAD_TABS = Platform.OS !== 'web';

export default function TabsLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  /** 正在左右滑动切去的标签：这次新页面整页滑进来；点标签栏、滑完了清掉（点标签栏切换不要动画） */
  const [slidingTo, setSlidingTo] = useState<TabRoute | null>(null);
  const swipeTo = useCallback((index: number) => {
    setSlidingTo(TAB_ROUTES[index]);
    router.navigate(TAB_PATHS[index]);
  }, []);
  return (
    <Tabs
      // 每个标签页都能左右滑动切到相邻标签
      screenLayout={({ children, route }) => (
        <TabSwipe index={TAB_ROUTES.indexOf(route.name as TabRoute)} onSwipeTo={swipeTo}>
          {children}
        </TabSwipe>
      )}
      screenListeners={({ route }) => ({
        tabPress: () => setSlidingTo(null),
        transitionEnd: () => setSlidingTo((current) => (current === route.name ? null : current)),
      })}
      screenOptions={{
        lazy: !PRELOAD_TABS,
        sceneStyleInterpolator: slideInterpolator(width),
        transitionSpec: slidingTo ? SLIDE_SPEC : NO_ANIMATION_SPEC,
        tabBarButton: Platform.OS === 'android' ? TabBarButtonWithoutRipple : undefined,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.faint,
        // 网页版标签栏默认只有 48 高，手机宽度下图标下面的字被挤得只剩半截：网页版加高到 56（再加上底部安全区）；
        // 手机 App 的高度由导航库按安全区算，不动
        tabBarStyle: [
          { backgroundColor: colors.surface, borderTopColor: colors.line },
          Platform.OS === 'web' && { height: WEB_TAB_BAR_HEIGHT + insets.bottom },
        ],
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        // iOS 上标签页的标题栏是每个标签自己那层系统导航栏（大标题，见 components/TabStack），这里的不显示；安卓、网页照旧用这个
        headerShown: Platform.OS !== 'ios',
        headerStyle: { backgroundColor: colors.bg },
        // 标签页的标题照鸿蒙版：靠左的大标题
        headerTitleAlign: 'left',
        headerTitleStyle: { color: colors.ink, fontWeight: '700', fontSize: 24 },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
        headerRight: () => <OfficeSwitcher />,
      }}
    >
      <Tabs.Screen name="(home)" options={{ title: TAB_TITLES['(home)'], tabBarIcon: tabIcon('notifications-outline', 'notifications') }} />
      <Tabs.Screen name="food" options={{ title: TAB_TITLES.food, tabBarIcon: tabIcon('nutrition-outline', 'nutrition') }} />
      <Tabs.Screen name="daily" options={{ title: TAB_TITLES.daily, tabBarIcon: tabIcon('basket-outline', 'basket') }} />
      <Tabs.Screen name="devices" options={{ title: TAB_TITLES.devices, tabBarIcon: tabIcon('laptop-outline', 'laptop') }} />
      <Tabs.Screen
        name="settings"
        options={{ title: TAB_TITLES.settings, tabBarIcon: tabIcon('settings-outline', 'settings'), headerRight: () => null }}
      />
    </Tabs>
  );
}
