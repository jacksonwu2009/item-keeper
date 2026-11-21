import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { Platform, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfficeSwitcher } from '../../components/OfficeSwitcher';
import { TabSwipe } from '../../components/TabSwipe';
import type { IconName } from '../../components/ui';
import { TAB_ROUTES, TAB_TITLES, type TabRoute } from '../../lib/tabs';
import { colors } from '../../theme';

/** 标签栏图标：选中的用实心图标，没选中的用线条图标（和鸿蒙版底部标签栏一样） */
function tabIcon(name: IconName, focusedName: IconName) {
  function TabBarIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? focusedName : name} size={size} color={typeof color === 'string' ? color : undefined} />;
  }
  return TabBarIcon;
}

const WEB_TAB_BAR_HEIGHT = 56;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      // 每个标签页都能左右滑动切到相邻标签
      screenLayout={({ children, route }) => (
        <TabSwipe index={TAB_ROUTES.indexOf(route.name as TabRoute)}>{children}</TabSwipe>
      )}
      screenOptions={{
        animation: 'shift',
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
