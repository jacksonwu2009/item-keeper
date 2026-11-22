import { Stack } from 'expo-router';

import { OfficeManager } from '../components/OfficeManager';
import { Screen } from '../components/ui';
import { useTerms } from '../hooks/useScene';

/** 「办公点」页（家庭场景叫「地点」）：设置页「数据」组里那一行点进来，内容就是原来设置页里的办公点管理 */
export default function OfficesScreen() {
  const terms = useTerms();
  return (
    <Screen>
      {/* 标题在页面里设（和盘点页一样） */}
      <Stack.Screen options={{ title: terms.place }} />
      <OfficeManager />
    </Screen>
  );
}
