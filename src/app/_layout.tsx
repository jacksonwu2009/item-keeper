import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { DATABASE_NAME, migrateDbIfNeeded } from '../db/schema';
import { OfficeProvider } from '../hooks/useOffice';
import { rescheduleReminders, setupNotifications } from '../lib/notifications';
import { colors } from '../theme';

// 开屏（我们自己的图标、浅灰绿底）一直留到本地库打开并迁移完，再淡出到首页，中间不露出空白。
SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: 250, fade: true });

/** 本地库可用后才会渲染：这时首页马上能画出来，收起开屏 */
function HideSplashWhenReady() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  return null;
}

/** 启动时、以及每次 App 回到前台时，按最新库存重排未来的提醒。 */
function ReminderKeeper() {
  const db = useSQLiteContext();
  useEffect(() => {
    setupNotifications()
      .then(() => rescheduleReminders(db))
      .catch(() => undefined);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') rescheduleReminders(db).catch(() => undefined);
    });
    return () => subscription.remove();
  }, [db]);
  return null;
}

export default function RootLayout() {
  // 兜底：本地库迟迟打不开（出错）时，5 秒后也收起开屏，别一直停在开屏上
  useEffect(() => {
    const timer = setTimeout(() => SplashScreen.hideAsync().catch(() => undefined), 5000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <GestureHandlerRootView style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      <SQLiteProvider databaseName={DATABASE_NAME} onInit={migrateDbIfNeeded}>
        <OfficeProvider>
          <HideSplashWhenReady />
          <ReminderKeeper />
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.accent,
              headerTitleStyle: { color: colors.ink, fontWeight: '700' },
              headerShadowVisible: false,
              headerBackTitle: '返回',
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', headerShown: false }} />
            <Stack.Screen name="stock/new" options={{ title: '新增物品' }} />
            <Stack.Screen name="stock/[id]" options={{ title: '' }} />
            <Stack.Screen name="stock/edit/[id]" options={{ title: '编辑物品' }} />
            <Stack.Screen name="device/new" options={{ title: '新增设备' }} />
            <Stack.Screen name="device/[id]" options={{ title: '' }} />
            <Stack.Screen name="device/edit/[id]" options={{ title: '编辑设备' }} />
          </Stack>
        </OfficeProvider>
      </SQLiteProvider>
    </GestureHandlerRootView>
  );
}
