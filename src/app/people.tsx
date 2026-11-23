import { Stack } from 'expo-router';

import { PeopleManager } from '../components/PeopleManager';
import { Screen } from '../components/ui';
import { useTerms } from '../hooks/useScene';

/** 「员工名单」页（家庭场景叫「家庭成员」）：设置页「通用」组里那一行点进来 */
export default function PeopleScreen() {
  const terms = useTerms();
  return (
    <Screen>
      {/* 标题在页面里设（和办公点页一样） */}
      <Stack.Screen options={{ title: terms.roster }} />
      <PeopleManager />
    </Screen>
  );
}
