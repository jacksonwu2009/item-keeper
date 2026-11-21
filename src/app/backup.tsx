import { Stack } from 'expo-router';

import { BackupManager } from '../components/BackupManager';
import { Screen } from '../components/ui';

/** 「导入导出」页：设置页「数据」一组里的一行点进来，内容就是原来设置页里的导入导出 */
export default function BackupScreen() {
  return (
    <Screen>
      {/* 标题在页面里设（和盘点页一样） */}
      <Stack.Screen options={{ title: '导入导出' }} />
      <BackupManager />
    </Screen>
  );
}
