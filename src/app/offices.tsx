import { Stack } from 'expo-router';

import { OfficeManager } from '../components/OfficeManager';
import { Screen } from '../components/ui';

/** 「办公点」页：设置页「办公点」一组里的一行点进来，内容就是原来设置页里的办公点管理 */
export default function OfficesScreen() {
  return (
    <Screen>
      {/* 标题在页面里设（和盘点页一样） */}
      <Stack.Screen options={{ title: '办公点' }} />
      <OfficeManager />
    </Screen>
  );
}
