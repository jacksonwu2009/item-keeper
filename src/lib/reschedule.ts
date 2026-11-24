/**
 * 重排提醒用的两个小工具（纯函数，不碰通知 API，方便单测）：
 * - createCoalescedQueue：多次调用排队依次执行；前面还有一次在排队、还没开始的，新的调用不再追加，
 *   改用最新的参数、返回同一个结果。数据连着变几次（比如出库后连着又改了两样）只多排一次。
 * - scheduleSignature：一份通知计划（连同通知权限）序列化成一个字符串，和上次排进系统的比，一样就不用重排。
 */

import type { PlannedReminder } from './reminderPlan';

export function createCoalescedQueue<A, R>(run: (arg: A) => Promise<R>): (arg: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  /** 排在队里、还没开始的那一次；开始执行时清掉，之后的调用重新排一次 */
  let waiting: { arg: A; result: Promise<R> } | null = null;
  return (arg: A) => {
    if (waiting) {
      waiting.arg = arg;
      return waiting.result;
    }
    const entry: { arg: A; result: Promise<R> } = { arg, result: Promise.resolve() as Promise<R> };
    entry.result = tail.then(() => {
      if (waiting === entry) waiting = null;
      return run(entry.arg);
    });
    waiting = entry;
    tail = entry.result.catch(() => undefined);
    return entry.result;
  };
}

/** 计划里每条通知的触发时刻、标题、正文，加上通知权限；两次一样说明系统里排着的通知不用动 */
export function scheduleSignature(plan: readonly PlannedReminder[], permission: string): string {
  return JSON.stringify({
    permission,
    plan: plan.map((reminder) => [reminder.at.getTime(), reminder.title, reminder.body]),
  });
}
