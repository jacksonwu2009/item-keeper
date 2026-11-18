import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { notifyDataChanged } from '../lib/dataEvents';

const UNDO_WINDOW_MS = 5000;

type Pending<K> = { key: K; label: string };

/**
 * 删除先在界面上隐藏，底部给几秒「撤销」；时间到、又删了另一条、或离开这一页时才真正删。
 * commit 是真正删除的函数，onCommitted 在删完后调（比如刷新列表、重排提醒）。
 */
export function usePendingDelete<K extends string | number>(
  commit: (key: K) => Promise<void>,
  onCommitted?: () => void | Promise<void>,
) {
  const [pending, setPending] = useState<Pending<K> | null>(null);
  const pendingRef = useRef<Pending<K> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(commit);
  const committedRef = useRef(onCommitted);

  useEffect(() => {
    commitRef.current = commit;
    committedRef.current = onCommitted;
  });

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const item = pendingRef.current;
    if (!item) return;
    pendingRef.current = null;
    try {
      await commitRef.current(item.key);
    } finally {
      // 等列表按新数据重读完再取消隐藏，免得删掉的那行闪回来一下
      await Promise.resolve(committedRef.current?.()).catch(() => undefined);
      setPending((current) => (current?.key === item.key ? null : current));
      // 离开页面时才提交的删除，回到的那一页早就读过数了，通知它重读
      notifyDataChanged();
    }
  }, []);

  const remove = useCallback(
    (key: K, label: string) => {
      flush().catch(() => undefined);
      const item = { key, label };
      pendingRef.current = item;
      setPending(item);
      timer.current = setTimeout(() => {
        flush().catch(() => undefined);
      }, UNDO_WINDOW_MS);
    },
    [flush],
  );

  const undo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pendingRef.current = null;
    setPending(null);
  }, []);

  // 离开这一页（或切到别的标签）时把还在等撤销的删掉
  useFocusEffect(
    useCallback(
      () => () => {
        flush().catch(() => undefined);
      },
      [flush],
    ),
  );

  /** 有等撤销的删除就马上执行掉；入库、出库这类要按最新数据算的操作之前调用。 */
  return { pending, remove, undo, flush };
}
