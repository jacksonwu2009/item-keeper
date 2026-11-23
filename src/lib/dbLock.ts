/**
 * 同一个库文件的迁移、首次打开时的准备按顺序一个一个来：排通知时会另开一个连接读另一个场景的库，
 * 刚好切过去时 SQLiteProvider 也在迁移同一个库，两边同时建表会撞。按库文件名排队，前一个失败也不影响后面的。
 */
const tails = new Map<string, Promise<unknown>>();

export function withDatabaseLock<T>(databaseName: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(databaseName) ?? Promise.resolve();
  const next = previous.then(task, task);
  tails.set(
    databaseName,
    next.catch(() => undefined),
  );
  return next;
}
