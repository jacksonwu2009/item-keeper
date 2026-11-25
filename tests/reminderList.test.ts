/**
 * 提醒页列表：每组前几样、每行的短文字、库存不足的排序、保修快到期。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deviceSearchText, stockSearchText } from '../src/lib/listSearch';
import {
  expiryRowText,
  filterReminderItems,
  isReminderGroup,
  lowStockRowText,
  moreText,
  noMatchTitle,
  previewOf,
  reminderGroupTitle,
  shortDateIn,
  showKindFor,
  sortLowStock,
  warrantyChipText,
  warrantySoonDevices,
} from '../src/lib/reminderList';
import type { ExpiryEntry, LowStockEntry, PlanProduct } from '../src/lib/reminderPlan';

function product(name: string, kind: 'food' | 'daily', lowStockThreshold: number | null = null): PlanProduct {
  return { id: 1, kind, name, unit: '盒', totalQty: 0, lowStockThreshold, expiryLeadDays: null, batches: [] };
}

function expiry(name: string, kind: 'food' | 'daily', expiryDate: string, daysLeft: number, quantity: number): ExpiryEntry {
  return { product: product(name, kind), name, daysLeft, expiryDate, quantity, due: true };
}

function low(name: string, qty: number, threshold: number): LowStockEntry {
  return { product: product(name, 'daily', threshold), name, qty, unit: '包' };
}

describe('提醒页列表', () => {
  it('每组最多显示 5 样，告诉还有几样没显示', () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    assert.deepEqual(previewOf(items), { shown: [0, 1, 2, 3, 4], hidden: 7 });
    assert.deepEqual(previewOf([1, 2]), { shown: [1, 2], hidden: 0 });
    assert.equal(moreText(12), '查看全部 12 样');
  });

  it('今年的日期只写月日，别的年份写全', () => {
    assert.equal(shortDateIn('2026-11-18', '2026-11-23'), '11月18日');
    assert.equal(shortDateIn('2027-01-03', '2026-11-23'), '2027年1月3日');
  });

  it('食品、日用品混在一组时才写分类；剩多少放进标签', () => {
    const food = expiry('饼干', 'food', '2026-11-18', -5, 2);
    const daily = expiry('洗手液', 'daily', '2026-11-30', 7, 1);
    assert.equal(showKindFor([food]), false);
    assert.equal(showKindFor([food, daily]), true);
    assert.deepEqual(expiryRowText(food, '2026-11-23', false), { subtitle: '11月18日到期', chip: '已过期 5 天 · 2 盒' });
    assert.deepEqual(expiryRowText(food, '2026-11-23', true), { subtitle: '食品 · 11月18日到期', chip: '已过期 5 天 · 2 盒' });
    assert.deepEqual(lowStockRowText(low('纸巾', 1, 5), false), { subtitle: '下限 5 包', chip: '剩 1 包' });
  });

  it('库存不足：一点没有的在前，再按剩下的占下限的比例', () => {
    const sorted = sortLowStock([low('A', 4, 5), low('B', 0, 3), low('C', 1, 10)]);
    assert.deepEqual(sorted.map((entry) => entry.name), ['B', 'C', 'A']);
  });

  it('保修快到期：30 天内（含今天），最快到期的在前', () => {
    const devices = [
      { id: 1, warrantyUntil: '2026-12-20' },
      { id: 2, warrantyUntil: '2026-11-23' },
      { id: 3, warrantyUntil: '2027-06-01' },
      { id: 4, warrantyUntil: null },
      { id: 5, warrantyUntil: '2026-11-01' },
    ];
    assert.deepEqual(
      warrantySoonDevices(devices, '2026-11-23').map((entry) => [entry.device.id, entry.daysLeft]),
      [
        [2, 0],
        [1, 27],
      ],
    );
    assert.equal(warrantyChipText(0), '今天到期');
    assert.equal(warrantyChipText(12), '剩 12 天');
  });

  it('只认这几组', () => {
    assert.equal(isReminderGroup('lowStock'), true);
    assert.equal(isReminderGroup('devices'), false);
  });

  it('明细页搜索：和物品列表一样搜名称、分类、规格、位置、条码，去掉首尾空白、不分大小写', () => {
    const fields = (name: string, extra: Partial<Parameters<typeof stockSearchText>[0]> = {}) => ({
      name,
      category: null,
      spec: null,
      location: null,
      barcode: null,
      ...extra,
    });
    const items = [
      { key: 'a', searchText: stockSearchText(fields('可口可乐', { category: '饮料', spec: '500ML' })) },
      { key: 'b', searchText: stockSearchText(fields('Apple 苹果', { location: '茶水间', barcode: '6901234567890' })) },
      { key: 'c', searchText: stockSearchText(fields('纸巾', { category: '纸品' })) },
      { key: 'd', searchText: null },
    ];
    const keys = (query: string) => filterReminderItems(items, query).map((item) => item.key);
    assert.equal(filterReminderItems(items, '  '), items, '没在搜时原样返回');
    assert.deepEqual(keys('可乐'), ['a']);
    assert.deepEqual(keys(' ml '), ['a'], '规格，不分大小写');
    assert.deepEqual(keys('APPLE'), ['b']);
    assert.deepEqual(keys('茶水间'), ['b'], '位置');
    assert.deepEqual(keys('690123'), ['b'], '条码');
    assert.deepEqual(keys('纸品'), ['c'], '分类');
    assert.deepEqual(keys('乐 饮'), ['a'], '几项用空格连起来');
    assert.deepEqual(keys('没有的'), []);
  });

  it('明细页搜索：保修那一组和设备列表一样搜名称、型号、配置、序列号、发票号、分类、使用人', () => {
    const device = {
      name: '办公电脑',
      model: 'MacBook Pro',
      chip: 'M3',
      memory: '16G',
      storage: '512G',
      serialNo: 'C02XYZ',
      invoiceNo: 'FP-001',
      category: '电脑',
      holders: '张三、李四',
    };
    const items = [{ searchText: deviceSearchText(device) }];
    for (const query of ['macbook', 'm3 16g/512g', 'c02xyz', 'fp-001', '电脑', '李四']) {
      assert.equal(filterReminderItems(items, query).length, 1, query);
    }
    assert.equal(filterReminderItems(items, '王五').length, 0);
  });

  it('明细页标题：搜的时候写「搜到几条/一共几条」；搜不到的提示', () => {
    assert.equal(reminderGroupTitle('已过期', 208, null), '已过期（208）');
    assert.equal(reminderGroupTitle('已过期', 208, 3), '已过期（3/208）');
    assert.equal(reminderGroupTitle('快到期', 12, 0), '快到期（0/12）');
    assert.equal(noMatchTitle(' 可乐 '), '没有找到「可乐」');
  });
});
