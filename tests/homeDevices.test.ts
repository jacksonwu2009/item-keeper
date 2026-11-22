/**
 * 家庭场景的设备：「谁在用」（存成领用记录）、保修到期前 30 天提醒、导出表格去掉借出 / 在库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDevice, issueDevice, listAssignments, listDevices, setDeviceHolder, type DeviceInput } from '../src/db/devices';
import { buildMessage, planReminders, warrantyDueOn, type ReminderSettings } from '../src/lib/reminderPlan';
import { deviceTable, type ReportDevice } from '../src/lib/report';
import { setActiveScene } from '../src/lib/terms';
import { openDb } from './helpers/memoryDb';

const tv: DeviceInput = {
  officeId: 1,
  category: '电视',
  name: '客厅电视',
  model: null,
  serialNo: null,
  quantity: 1,
  note: null,
  purchaseDate: '2025-12-20',
  warrantyUntil: '2026-12-19',
  invoiceNo: null,
  accessories: [],
};

describe('谁在用', () => {
  it('填了就记一条今天开始的领用；换人把原来的按今天还掉；同一个人不重复记', async () => {
    const db = await openDb();
    const id = await createDevice(db, tv);
    await setDeviceHolder(db, id, ' 孩子 ', '2026-11-22');
    let [device] = await listDevices(db, 1);
    assert.equal(device.holders, '孩子');
    assert.equal(device.outQty, 1);

    await setDeviceHolder(db, id, '孩子', '2026-11-23');
    assert.equal((await listAssignments(db, id)).length, 1);

    await setDeviceHolder(db, id, '爸爸', '2026-11-25');
    [device] = await listDevices(db, 1);
    assert.equal(device.holders, '爸爸');
    const history = await listAssignments(db, id);
    assert.deepEqual(
      history.map((row) => [row.person, row.issuedOn, row.returnedOn, row.quantity]),
      [
        ['爸爸', '2026-11-25', null, 1],
        ['孩子', '2026-11-22', '2026-11-25', 1],
      ],
    );
  });

  it('清空就是都还掉；办公场景里领用的几个人也一起还掉', async () => {
    const db = await openDb();
    const id = await createDevice(db, { ...tv, quantity: 3 });
    await issueDevice(db, id, { person: '张三', quantity: 1, issuedOn: '2026-11-01', returnedOn: null, note: null });
    await issueDevice(db, id, { person: '李四', quantity: 2, issuedOn: '2026-11-30', returnedOn: null, note: null });
    await setDeviceHolder(db, id, null, '2026-11-22');
    const [device] = await listDevices(db, 1);
    assert.equal(device.holders, null);
    assert.equal(device.outQty, 0);
    // 开始日期在今天之后的，按开始那天还，不会出现还得比领得早
    const returned = Object.fromEntries((await listAssignments(db, id)).map((row) => [row.person, row.returnedOn]));
    assert.deepEqual(returned, { 张三: '2026-11-22', 李四: '2026-11-30' });
  });

  it('名字太长不让存；办公场景记的长名字原样保存不报错', async () => {
    const db = await openDb();
    const id = await createDevice(db, tv);
    await assert.rejects(setDeviceHolder(db, id, '一'.repeat(21)), /最多 20 个字/);
    const long = '二'.repeat(25);
    await issueDevice(db, id, { person: long, quantity: 1, issuedOn: '2026-11-01', returnedOn: null, note: null });
    await setDeviceHolder(db, id, long, '2026-11-22');
    assert.equal((await listAssignments(db, id)).length, 1);
  });
});

describe('保修提醒', () => {
  const settings: ReminderSettings = {
    expiryEnabled: true,
    lowStockEnabled: true,
    expiryLeadDays: 7,
    repeatEveryDays: 1,
    reminderHour: 9,
    reminderMinute: 0,
  };
  const warranties = [
    { name: '客厅电视', warrantyUntil: '2026-12-22' },
    { name: '冰箱', warrantyUntil: '2027-03-01' },
  ];

  it('保修到期前 30 天那天提醒一次', () => {
    assert.deepEqual(warrantyDueOn(warranties, '2026-11-22'), ['客厅电视']);
    assert.deepEqual(warrantyDueOn(warranties, '2026-11-23'), []);
  });

  it('那天没有别的提醒也单发一条；关了到期提醒就不发', () => {
    const now = new Date(2026, 10, 20, 8, 0);
    const plan = planReminders([], settings, now, 60, 60, warranties);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].day, '2026-11-22');
    assert.equal(plan[0].title, '1 件设备保修快到期');
    assert.match(plan[0].body, /保修 30 天后到期：客厅电视/);
    assert.equal(planReminders([], { ...settings, expiryEnabled: false }, now, 60, 60, warranties).length, 0);
    assert.equal(planReminders([], settings, now, 60, 60).length, 0);
  });

  it('和物品提醒在同一条通知里', () => {
    const message = buildMessage({ expiring: [], expired: [], lowStock: [], due: true }, ['冰箱', '空调']);
    assert.equal(message.title, '2 件设备保修快到期');
    assert.equal(message.body, '保修 30 天后到期：冰箱、空调，有问题趁保修期内报修');
  });
});

describe('导出设备清单', () => {
  const rows: ReportDevice[] = [
    {
      id: 1,
      officeId: 1,
      category: '电视',
      name: '客厅电视',
      model: null,
      serialNo: null,
      invoiceNo: null,
      chip: null,
      memory: null,
      storage: null,
      quantity: 1,
      outQty: 1,
      holders: '孩子',
      purchaseDate: '2025-12-20',
      warrantyUntil: '2026-12-19',
    },
  ];

  it('家庭场景没有借出、在库，「使用人」叫「谁在用」；办公场景不变', () => {
    setActiveScene('home');
    const home = deviceTable(rows, new Map(), () => '家');
    setActiveScene('office');
    const office = deviceTable(rows, new Map(), () => '北京');
    assert.equal(home.header.includes('借出'), false);
    assert.equal(home.header.includes('在库'), false);
    assert.equal(home.header[0], '地点');
    assert.equal(home.rows[0][home.header.indexOf('谁在用')], '孩子');
    assert.equal(home.rows[0].length, home.header.length);
    assert.deepEqual(office.header.slice(9, 13), ['数量', '借出', '在库', '使用人']);
  });
});
