import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

/**
 * 页面回到前台时重新加载数据（从详情页改完库存返回列表时能看到新数字）。
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

  return [data, reload, loaded];
}
