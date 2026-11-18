import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';

import { OfficeSwitcher } from '../../components/OfficeSwitcher';
import { TabSwipe } from '../../components/TabSwipe';
import type { IconName } from '../../components/ui';
import { TAB_ROUTES } from '../../lib/tabs';
import { colors } from '../../theme';

function tabIcon(name: IconName) {
  function TabBarIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons name={name} size={size} color={typeof color === 'string' ? color : undefined} />;
  }
  return TabBarIcon;
}

export default function TabsLayout() {
  return (
    <Tabs
      // 每个标签页都能左右滑动切到相邻标签
      screenLayout={({ children, route }) => (
        <TabSwipe index={TAB_ROUTES.indexOf(route.name as (typeof TAB_ROUTES)[number])}>{children}</TabSwipe>
      )}
      screenOptions={{
        animation: 'shift',
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
        headerStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { color: colors.ink, fontWeight: '700' },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
        headerRight: () => <OfficeSwitcher />,
      }}
    >
      <Tabs.Screen name="index" options={{ title: '提醒', tabBarIcon: tabIcon('notifications-outline') }} />
      <Tabs.Screen name="food" options={{ title: '食品', tabBarIcon: tabIcon('nutrition-outline') }} />
      <Tabs.Screen name="daily" options={{ title: '日用品', tabBarIcon: tabIcon('basket-outline') }} />
      <Tabs.Screen name="devices" options={{ title: '设备', tabBarIcon: tabIcon('laptop-outline') }} />
      <Tabs.Screen
        name="settings"
        options={{ title: '设置', tabBarIcon: tabIcon('settings-outline'), headerRight: () => null }}
      />
    </Tabs>
  );
}
