import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/db/settings';
import {
  backupFileName,
  buildBackup,
  findBarcodeConflict,
  parseBackup,
  type BackupSource,
} from '../src/lib/backup';

const source: BackupSource = {
  settings: { ...DEFAULT_SETTINGS, expiryLeadDays: 5 },
  products: [
    {
      id: 1,
      kind: 'food',
      barcode: '6901234567892',
      name: '纯牛奶',
      brand: '某牌',
      spec: '250ml×12',
      unit: '盒',
      location: '冰箱',
      lowStockThreshold: 2,
      expiryLeadDays: null,
      note: null,
      createdAt: '2026-11-01T01:00:00.000Z',
      updatedAt: '2026-11-18T01:00:00.000Z',
    },
    {
      id: 2,
      kind: 'daily',
      barcode: null,
      name: '抽纸',
      brand: null,
      spec: null,
      unit: '包',
      location: null,
      lowStockThreshold: 3,
      expiryLeadDays: null,
      note: null,
      createdAt: '2026-11-01T01:00:00.000Z',
      updatedAt: '2026-11-01T01:00:00.000Z',
    },
  ],
  packs: [{ productId: 1, unit: '箱', size: 12, barcode: '16901234567899' }],
  batches: [
    { productId: 1, quantity: 6, expiryDate: '2026-11-25', addedOn: '2026-11-18', note: null },
    { productId: 1, quantity: 0, expiryDate: '2026-11-20', addedOn: '2026-11-10', note: null },
    { productId: 2, quantity: 10, expiryDate: null, addedOn: '2026-11-01', note: null },
  ],
  movements: [
    {
      productId: 1,
      type: 'in',
      delta: 12,
      expiryDate: '2026-11-25',
      happenedAt: '2026-11-18T01:00:00.000Z',
      note: null,
      inputQty: 1,
      inputUnit: '箱',
    },
    {
      productId: 2,
      type: 'out',
      delta: -2,
      expiryDate: null,
      happenedAt: '2026-11-17T01:00:00.000Z',
      note: '用掉',
      inputQty: 2,
      inputUnit: '包',
    },
  ],
  devices: [
    {
      id: 7,
      category: '笔记本',
      name: 'MacBook Pro 14',
      model: 'M3 Pro',
      serialNo: 'C02XYZ',
      quantity: 2,
      note: null,
      createdAt: '2026-10-01T01:00:00.000Z',
      updatedAt: '2026-10-01T01:00:00.000Z',
    },
  ],
  assignments: [
    { deviceId: 7, person: '张三', quantity: 1, issuedOn: '2026-10-02', returnedOn: null, note: '含充电器' },
    { deviceId: 7, person: '李四', quantity: 1, issuedOn: '2026-09-01', returnedOn: '2026-09-30', note: null },
  ],
};

function exported(): Record<string, any> {
  return JSON.parse(JSON.stringify(buildBackup(source, new Date('2026-11-18T02:00:00.000Z'))));
}

describe('备份导出', () => {
  it('按物品和设备嵌套，数量为 0 的批次不导出', () => {
    const data = buildBackup(source, new Date('2026-11-18T02:00:00.000Z'));
    assert.equal(data.products.length, 2);
    assert.equal(data.products[0].batches.length, 1);
    assert.equal(data.products[0].movements.length, 1);
    assert.deepEqual(data.products[0].packs, [{ unit: '箱', size: 12, barcode: '16901234567899' }]);
    assert.deepEqual(data.products[1].packs, []);
    assert.equal(data.products[0].movements[0].inputUnit, '箱');
    assert.equal(data.products[1].movements[0].note, '用掉');
    assert.equal(data.devices[0].assignments.length, 2);
    assert.equal('id' in data.products[0], false);
  });

  it('文件名带日期时间', () => {
    assert.equal(backupFileName(new Date(2026, 10, 18, 9, 5)), 'item-keeper-backup-20261118-0905.json');
  });
});

describe('备份导入校验', () => {
  it('导出再导入内容一致', () => {
    const text = JSON.stringify(buildBackup(source, new Date('2026-11-18T02:00:00.000Z')));
    const result = parseBackup(text);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, JSON.parse(text));
    assert.deepEqual(
      { food: result.summary.food, daily: result.summary.daily, devices: result.summary.devices },
      { food: 1, daily: 1, devices: 1 },
    );
    assert.equal(result.data.settings.expiryLeadDays, 5);
  });

  it('容忍多余字段和缺省的可选字段', () => {
    const data = exported();
    data.products[0].totalQty = 6;
    delete data.products[0].brand;
    delete data.products[1].movements;
    const result = parseBackup(JSON.stringify(data));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.products[0].brand, null);
    assert.deepEqual(result.data.products[1].movements, []);
    assert.equal('totalQty' in result.data.products[0], false);
  });

  it('设置里不认识的键和类型不对的值用默认值', () => {
    const data = exported();
    data.settings = { expiryLeadDays: '9', reminderHour: 20, hacked: true };
    const result = parseBackup(JSON.stringify(data));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.settings.expiryLeadDays, DEFAULT_SETTINGS.expiryLeadDays);
    assert.equal(result.data.settings.reminderHour, 20);
    assert.equal('hacked' in result.data.settings, false);
  });

  const rejects: [string, (data: Record<string, any>) => unknown, RegExp][] = [
    ['不是本 App 的文件', (data) => (data.app = 'other'), /不是物品管家的备份/],
    ['版本更新', (data) => (data.format = 99), /更新版本/],
    ['过期日期无效', (data) => (data.products[0].batches[0].expiryDate = '2026-13-01'), /纯牛奶.*过期日期「2026-13-01」/],
    ['类别不对', (data) => (data.products[1].kind = 'tool'), /抽纸.*类别/],
    ['缺名称', (data) => (data.products[0].name = ' '), /第 1 个物品：缺少名称/],
    ['条码重复', (data) => (data.products[1].barcode = '6901234567892'), /条码 6901234567892 同时出现/],
    ['包装条码和别的物品条码重复', (data) => (data.products[1].barcode = '16901234567899'), /同时出现在「纯牛奶」的箱和「抽纸」/],
    ['包装和最小单位同名', (data) => (data.products[0].packs[0].unit = '盒'), /不能和最小单位「盒」同名/],
    ['包装换算数量为 0', (data) => (data.products[0].packs[0].size = 0), /大于 0/],
    ['退还早于领取', (data) => (data.devices[0].assignments[1].returnedOn = '2026-08-01'), /退还日期早于领取日期/],
    ['借出比总数多', (data) => (data.devices[0].quantity = 1, data.devices[0].assignments[1].returnedOn = null), /比总数 1 件还多/],
    ['数量是负数', (data) => (data.products[0].batches[0].quantity = -1), /数量「-1」不对/],
  ];
  for (const [title, mutate, pattern] of rejects) {
    it(`拒绝：${title}`, () => {
      const data = exported();
      mutate(data);
      const result = parseBackup(JSON.stringify(data));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, pattern);
    });
  }

  it('拒绝：不是 JSON', () => {
    const result = parseBackup('hello');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /不是 JSON/);
  });

  it('第 1 版备份（没有包装规格和输入单位）也能导入', () => {
    const data = exported();
    data.format = 1;
    for (const product of data.products) {
      delete product.packs;
      for (const movement of product.movements) {
        delete movement.inputQty;
        delete movement.inputUnit;
      }
    }
    const result = parseBackup(JSON.stringify(data));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.products[0].packs, []);
    assert.equal(result.data.products[0].movements[0].inputUnit, null);
  });

  it('带 BOM 的文件也能读', () => {
    const result = parseBackup(`﻿${JSON.stringify(exported())}`);
    assert.equal(result.ok, true);
  });
});

describe('按分类导出导入', () => {
  const at = new Date('2026-11-18T02:00:00.000Z');

  it('只导出食品：没有日用品、设备和设置', () => {
    const data = buildBackup(source, at, ['food']);
    assert.deepEqual(data.scope, ['food']);
    assert.deepEqual(
      data.products.map((product) => product.name),
      ['纯牛奶'],
    );
    assert.deepEqual(data.devices, []);
    assert.equal(data.settings, null);
  });

  it('分类按固定顺序、去重', () => {
    assert.deepEqual(buildBackup(source, at, ['devices', 'food', 'food']).scope, ['food', 'devices']);
  });

  it('文件名带上分类', () => {
    const now = new Date(2026, 10, 18, 9, 5);
    assert.equal(backupFileName(now, ['devices', 'food']), 'item-keeper-food-devices-20261118-0905.json');
    assert.equal(backupFileName(now, ['food', 'daily', 'devices', 'settings']), 'item-keeper-backup-20261118-0905.json');
  });

  it('部分分类的备份能导回来，范围不变', () => {
    const result = parseBackup(JSON.stringify(buildBackup(source, at, ['daily', 'settings'])));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.summary.scope, ['daily', 'settings']);
    assert.equal(result.summary.daily, 1);
    assert.equal(result.summary.food, 0);
    assert.equal(result.data.settings?.expiryLeadDays, 5);
  });

  it('第 2 版备份没有 scope，当作全部分类', () => {
    const data = JSON.parse(JSON.stringify(buildBackup(source, at)));
    data.format = 2;
    delete data.scope;
    const result = parseBackup(JSON.stringify(data));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data.scope, ['food', 'daily', 'devices', 'settings']);
  });

  it('拒绝：标明只有食品却混进了日用品', () => {
    const data = JSON.parse(JSON.stringify(buildBackup(source, at)));
    data.scope = ['food', 'devices', 'settings'];
    const result = parseBackup(JSON.stringify(data));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /不含日用品.*抽纸/);
  });

  it('拒绝：不认识的分类', () => {
    const data = JSON.parse(JSON.stringify(buildBackup(source, at, ['food'])));
    data.scope = ['food', 'tools'];
    const result = parseBackup(JSON.stringify(data));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /不认识的分类「tools」/);
  });

  it('导入食品时，条码不能和手机上保留的日用品撞（含包装条码）', () => {
    const food = buildBackup(source, at, ['food']).products;
    assert.equal(findBarcodeConflict(food, [{ name: '抽纸', kind: 'daily', barcodes: ['111'] }]), null);
    assert.match(
      findBarcodeConflict(food, [{ name: '洗衣液', kind: 'daily', barcodes: ['16901234567899'] }]) ?? '',
      /条码 16901234567899 在备份的「纯牛奶」和手机上日用品里的「洗衣液」重复/,
    );
  });
});
