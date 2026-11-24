/**
 * 重排提醒：排队时合并还没开始的那次、计划没变不动系统通知（比较用的序列化）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PlannedReminder } from '../src/lib/reminderPlan';
import { createCoalescedQueue, scheduleSignature } from '../src/lib/reschedule';

/** 手动放行的任务：记下每次执行用的参数，调 release 才结束 */
function controlledRun() {
  const calls: string[] = [];
  const releases: (() => void)[] = [];
  const run = (arg: string) =>
    new Promise<string>((resolve) => {
      calls.push(arg);
      releases.push(() => resolve(`done:${arg}`));
    });
  return { calls, releases, run };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round++) await Promise.resolve();
}

describe('重排提醒排队', () => {
  it('前面那次还没开始时，后来的调用合进去：只执行一次，用最后一次的参数，拿到同一个结果', async () => {
    const { calls, releases, run } = controlledRun();
    const reschedule = createCoalescedQueue(run);
    const first = reschedule('a');
    const second = reschedule('b');
    const third = reschedule('c');
    assert.equal(first, second);
    assert.equal(second, third);
    await flush();
    assert.deepEqual(calls, ['c']);
    releases[0]();
    assert.equal(await first, 'done:c');
  });

  it('正在执行时再调：排在后面再执行一次（不会和正在执行的交错），后面的几次也合成一次', async () => {
    const { calls, releases, run } = controlledRun();
    const reschedule = createCoalescedQueue(run);
    const running = reschedule('a');
    await flush();
    assert.deepEqual(calls, ['a']);
    const queuedB = reschedule('b');
    const queuedC = reschedule('c');
    assert.notEqual(running, queuedB);
    assert.equal(queuedB, queuedC);
    await flush();
    // a 还没结束，c 不会开始
    assert.deepEqual(calls, ['a']);
    releases[0]();
    assert.equal(await running, 'done:a');
    await flush();
    assert.deepEqual(calls, ['a', 'c']);
    releases[1]();
    assert.equal(await queuedC, 'done:c');
  });

  it('前一次出错不挡住后面的', async () => {
    let attempt = 0;
    const reschedule = createCoalescedQueue(async (arg: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('排程失败');
      return arg;
    });
    const failed = reschedule('a');
    await assert.rejects(failed, /排程失败/);
    assert.equal(await reschedule('b'), 'b');
  });
});

function reminder(day: string, title: string, body: string): PlannedReminder {
  return { day, at: new Date(`${day}T09:00:00`), title, body };
}

describe('通知计划比较', () => {
  const plan = [reminder('2026-11-25', '2 样快到期', '牛奶 明天到期'), reminder('2026-11-27', '1 样已过期', '面包 已过期 1 天')];

  it('同样的计划、同样的权限：一样', () => {
    const copy = plan.map((item) => ({ ...item, at: new Date(item.at.getTime()) }));
    assert.equal(scheduleSignature(plan, 'granted'), scheduleSignature(copy, 'granted'));
  });

  it('时间、标题、正文、条数、权限任何一项变了都不一样', () => {
    const base = scheduleSignature(plan, 'granted');
    assert.notEqual(base, scheduleSignature(plan, 'denied'));
    assert.notEqual(base, scheduleSignature([plan[0]], 'granted'));
    assert.notEqual(base, scheduleSignature([{ ...plan[0], at: new Date(plan[0].at.getTime() + 60_000) }, plan[1]], 'granted'));
    assert.notEqual(base, scheduleSignature([{ ...plan[0], title: '3 样快到期' }, plan[1]], 'granted'));
    assert.notEqual(base, scheduleSignature([plan[0], { ...plan[1], body: '面包 已过期 2 天' }], 'granted'));
  });
});
