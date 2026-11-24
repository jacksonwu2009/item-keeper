import { DarkTheme, DefaultTheme, Stack, ThemeProvider, type Theme } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { HeaderBackButton } from '../components/HeaderBackButton';
import { OfficeProvider } from '../hooks/useOffice';
import { SceneProvider } from '../hooks/useScene';
import { IOS_LIQUID_GLASS } from '../lib/liquidGlass';
import { rescheduleReminders, setupNotifications } from '../lib/notifications';
import { useColors, useColorScheme } from '../hooks/useTheme';

// 开屏（我们自己的图标；底色浅色模式是浅灰绿、深色模式是深灰绿，见 app.json 的 expo-splash-screen）一直留到本地库打开并迁移完，再淡出到首页，中间不露出空白。
// 新装还没选使用场景时，盖上首次选择就收起（hooks/useScene）。
SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: 250, fade: true });

/** 本地库可用后才会渲染：这时首页马上能画出来，收起开屏 */
function HideSplashWhenReady() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  return null;
}

/** 启动后等这么久再重排提醒：首页先读数、画出来 */
const STARTUP_RESCHEDULE_DELAY_MS = 1500;

/** 启动时、换了场景时（整棵树按新库重新挂上）、以及每次 App 回到前台时，按最新库存重排未来的提醒（两个场景都排）。 */
function ReminderKeeper() {
  const db = useSQLiteContext();
  useEffect(() => {
    const setup = setupNotifications();
    setup.catch(() => undefined);
    // 启动时先让首页读数、画出来，过一会儿再重排提醒（重排要把物品、批次全读一遍再排 60 天）
    let started = false;
    const timer = setTimeout(() => {
      started = true;
      setup.then(() => rescheduleReminders(db)).catch(() => undefined);
    }, STARTUP_RESCHEDULE_DELAY_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      // 启动后那次还没排的话等它排，不另外再排
      if (state === 'active' && started) rescheduleReminders(db).catch(() => undefined);
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [db]);
  return null;
}

export default function RootLayout() {
  const colors = useColors();
  const scheme = useColorScheme();
  // 导航库自己画的部分（页面切换时垫的底、没单独设颜色的标题和按钮）也用这套颜色
  const navigationTheme = useMemo<Theme>(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.accent,
        background: colors.bg,
        card: colors.bg,
        text: colors.ink,
        border: colors.line,
        notification: colors.danger,
      },
    };
  }, [scheme, colors]);
  // 最底下那层窗口的底色（键盘弹起、页面切换露出来的地方）跟着换，不然深色模式下会露出浅色
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.bg).catch(() => undefined);
  }, [colors.bg]);
  // 兜底：本地库迟迟打不开（出错）时，5 秒后也收起开屏，别一直停在开屏上
  useEffect(() => {
    const timer = setTimeout(() => SplashScreen.hideAsync().catch(() => undefined), 5000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <GestureHandlerRootView style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      {/* 状态栏的字和图标：深色模式用浅色的，浅色模式用深色的。放最外层：还没打开库（首次选择、登录页）时也要对 */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {/* SceneProvider 先定场景，再用那个场景的库包住下面（换场景时下面整棵树按新库重新挂上） */}
      <SceneProvider>
        <OfficeProvider>
          <HideSplashWhenReady />
          <ReminderKeeper />
          <ThemeProvider value={navigationTheme}>
            <Stack
              screenOptions={({ navigation }) => ({
                headerStyle: { backgroundColor: colors.bg },
                // iOS 26 起左上角是系统返回键（玻璃圆钮里一个箭头），箭头用深色，和别的平台那个浅灰圆钮里的箭头一样
                headerTintColor: IOS_LIQUID_GLASS ? colors.ink : colors.accent,
                headerTitleStyle: { color: colors.ink, fontWeight: '700', fontSize: 20 },
                headerShadowVisible: false,
                headerBackTitle: '返回',
                headerBackButtonDisplayMode: 'minimal',
                contentStyle: { backgroundColor: colors.bg },
                // 左上角：有上一页时是鸿蒙版那样的浅灰圆形返回按钮；没有上一页时和原来一样不放按钮。
                // 有没有上一页用标题栏给的 canGoBack 判断（按画标题栏时的导航状态），
                // 不用 navigation.canGoBack()：刚跳过来那一刻它还认为没有上一页，返回按钮会漏掉。
                // iOS 26 起不放自己的按钮：系统会给它再套一层玻璃底（圆里套圆），改用系统返回键（只显示箭头）
                headerLeft: IOS_LIQUID_GLASS
                  ? undefined
                  : ({ canGoBack }) => (canGoBack ? <HeaderBackButton onPress={() => navigation.goBack()} /> : null),
              })}
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
          </ThemeProvider>
        </OfficeProvider>
      </SceneProvider>
    </GestureHandlerRootView>
  );
}
