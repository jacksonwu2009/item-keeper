import { Stack } from 'expo-router';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { DATABASE_NAME, migrateDbIfNeeded } from '../db/schema';
import { OfficeProvider } from '../hooks/useOffice';
import { rescheduleReminders, setupNotifications } from '../lib/notifications';
import { colors } from '../theme';

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
  return (
    <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <SQLiteProvider databaseName={DATABASE_NAME} onInit={migrateDbIfNeeded}>
        <OfficeProvider>
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
