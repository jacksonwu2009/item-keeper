import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribeDataChanged } from '../lib/dataEvents';

/**
 * 页面回到前台时重新加载数据（从详情页改完库存返回列表时能看到新数字）；
 * 别处延后提交的修改（比如离开页面时才真正执行的删除）提交后也会重新加载。
 * 返回 [数据, 手动刷新]。loader 需要用 useCallback 包好。
 */
export function useFocusData<T>(loader: () => Promise<T>, initial: T): [T, () => Promise<void>, boolean] {
  const [data, setData] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    const next = await loader();
    if (current === generation.current) {
      setData(next);
      setLoaded(true);
    }
  }, [loader]);

  useFocusEffect(
    useCallback(() => {
      reload().catch(() => setLoaded(true));
    }, [reload]),
  );

  useEffect(
    () =>
      subscribeDataChanged(() => {
        reload().catch(() => undefined);
      }),
    [reload],
  );

  return [data, reload, loaded];
}
