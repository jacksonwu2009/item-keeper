import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

const UNDO_WINDOW_MS = 5000;

type Pending<K> = { key: K; label: string };

/**
 * 删除先在界面上隐藏，底部给几秒「撤销」；时间到、又删了另一条、或离开这一页时才真正删。
 * commit 是真正删除的函数，onCommitted 在删完后调（比如刷新列表、重排提醒）。
 */
export function usePendingDelete<K extends string | number>(
  commit: (key: K) => Promise<void>,
  onCommitted?: () => void,
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
    setPending(null);
    try {
      await commitRef.current(item.key);
    } finally {
      committedRef.current?.();
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

  return { pending, remove, undo };
}
