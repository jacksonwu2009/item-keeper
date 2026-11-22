import { Slot, Stack } from 'expo-router';
import { Platform } from 'react-native';

import { useOffice } from '../hooks/useOffice';
import { IOS_BEFORE_LIQUID_GLASS, IOS_LIQUID_GLASS } from '../lib/liquidGlass';
import { TAB_TITLES, type TabRoute } from '../lib/tabs';
import { colors } from '../theme';
import { OfficeSwitcher } from './OfficeSwitcher';

/**
 * iOS 26 以前标题栏用 colors.bg 作底色。iOS 26 起不设底色：给标题栏设了底色，大标题会被画到底色下面看不见、
 * 或者滑动一次以后消失（UIKit 的已知问题，Apple 建议 iOS 26 起别再自定义标题栏底色；React Navigation 开大标题时默认也不设）。
 * 不设底色时，在页面顶部标题栏是透明的，露出来的就是页面的 colors.bg；往上滑以后顶部那条栏由系统画。
 */

/**
 * 一个底部标签外面的那层（app/(tabs) 下每个标签文件夹的 _layout 用它）：
 * - iOS：包一层系统导航栏（native stack），标题用 iOS 的大标题。在页面顶部时 34 号粗体、靠左、在内容最上面；
 *   往上滑时大标题跟着内容滑走，顶部出现系统导航栏、标题变成小号居中；滑回顶部又变回大标题。收缩、滑动、顶部那条栏
 *   都是系统画的，页面最外层的滚动视图要配合（Screen 的 largeTitle、列表的 LARGE_TITLE_SCROLL_INSET）。
 *   右上角照搬标签栏原来的 headerRight：办公点切换（设置页不放）。
 * - 安卓、网页：不包这层，直接显示页面（Slot），标题栏还是标签栏自带的那个（见 (tabs)/_layout.tsx），样子和行为都不变。
 */
export function TabStack({ route, withOffice = true }: { route: TabRoute; withOffice?: boolean }) {
  if (Platform.OS !== 'ios') return <Slot />;
  return <LargeTitleStack route={route} withOffice={withOffice} />;
}

/** iOS：一层系统导航栏，里面只有这个标签的页面（同一文件夹下的 index），标题栏开大标题 */
function LargeTitleStack({ route, withOffice }: { route: TabRoute; withOffice: boolean }) {
  const office = useOffice();
  // 办公点切换只有多个办公点时才显示。系统标题栏右边放了按钮位就会画按钮底（iOS 26 起是玻璃底），里面是空的也会画，所以没东西时别放
  const headerRightShown = withOffice && office.multiple;
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: true,
        headerStyle: IOS_BEFORE_LIQUID_GLASS ? { backgroundColor: colors.bg } : undefined,
        // 大标题就用系统的 34 号粗体，只改颜色。小标题只设颜色的话，iOS 26 起导航库会把它画成 bold，粗细照系统标题栏写成 600
        headerLargeTitleStyle: { color: colors.ink },
        headerTitleStyle: { color: colors.ink, fontWeight: '600' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
        headerRight: headerRightShown && !IOS_LIQUID_GLASS ? () => <OfficeSwitcher /> : undefined,
        // iOS 26 起系统给右上角的按钮套一层共享的玻璃底，办公点切换自己有样子，关掉那层底（不然像两层）
        unstable_headerRightItems:
          headerRightShown && IOS_LIQUID_GLASS
            ? () => [{ type: 'custom', element: <OfficeSwitcher />, hidesSharedBackground: true }]
            : undefined,
      }}
    >
      <Stack.Screen name="index" options={{ title: TAB_TITLES[route] }} />
    </Stack>
  );
}
