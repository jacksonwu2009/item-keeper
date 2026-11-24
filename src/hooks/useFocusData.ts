import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribeDataChanged } from '../lib/dataEvents';

/**
 * 页面回到前台时重新加载数据（从详情页改完库存返回列表时能看到新数字）；
 * 别处延后提交的修改（比如离开页面时才真正执行的删除）提交后也会重新加载。
 * 预先建好、还没显示过的页面（手机上五个标签页启动时一起建好）挂上时先读一次，切过去时数据已经在；显示出来时照常再读一次。
 * 收到「数据变了」时只有在前台的页面马上重读；不在前台的（别的标签页、被上面一页盖住的）先不读，
 * 回到前台时本来就会重读一次（等于回到前台才读），不用每个已挂上的页面都跟着全量读一遍。
 * 返回 [数据, 手动刷新]。loader 需要用 useCallback 包好。
 */
export function useFocusData<T>(loader: () => Promise<T>, initial: T): [T, () => Promise<void>, boolean] {
  const [data, setData] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const navigation = useNavigation();
  const mountLoadChecked = useRef(false);

  // 读完才改状态（都在回调里）：挂上时的 useEffect 里也能直接调
  const reload = useCallback((): Promise<void> => {
    const current = ++generation.current;
    return loader().then((next) => {
      if (current !== generation.current) return;
      setData(next);
      setLoaded(true);
    });
  }, [loader]);

  // 挂上时不在前台（预先建好的标签页）：先读一次。在前台的交给下面的 useFocusEffect，不重复读
  useEffect(() => {
    if (mountLoadChecked.current) return;
    mountLoadChecked.current = true;
    if (!navigation.isFocused()) reload().catch(() => setLoaded(true));
  }, [navigation, reload]);

  useFocusEffect(
    useCallback(() => {
      reload().catch(() => setLoaded(true));
    }, [reload]),
  );

  useEffect(
    () =>
      subscribeDataChanged(() => {
        // 不在前台：先不读。回到前台时上面的 useFocusEffect 一定会重读一次，读到的就是变了以后的
        if (!navigation.isFocused()) return;
        reload().catch(() => undefined);
      }),
    [navigation, reload],
  );

  return [data, reload, loaded];
}
