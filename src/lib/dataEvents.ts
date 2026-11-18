/**
 * 「数据变了」的通知：有的修改是延后提交的（比如删除后留 5 秒撤销，离开页面时才真正删），
 * 提交时这边广播一下，已经显示在屏幕上的页面收到后重新读数，不会停在旧数据上。
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function notifyDataChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeDataChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
