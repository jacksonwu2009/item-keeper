/**
 * 提醒页列表：每组前几样、每行的短文字、库存不足的排序、保修快到期。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  expiryRowText,
  isReminderGroup,
  lowStockRowText,
  moreText,
  previewOf,
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
});
