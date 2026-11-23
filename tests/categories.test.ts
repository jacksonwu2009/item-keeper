import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CATEGORIES, categoryForKind, isCategoryOf, usedCategories } from '../src/lib/categories';

describe('物品分类', () => {
  it('食品、日用品各一套固定选项', () => {
    assert.deepEqual(CATEGORIES.food, ['粮油米面', '调味品', '零食', '饮料冲调', '乳品', '生鲜', '速食冻品', '其他']);
    assert.deepEqual(CATEGORIES.daily, ['纸品', '清洁用品', '洗护用品', '厨房用品', '药品', '办公用品', '其他']);
    assert.equal(isCategoryOf('food', '零食'), true);
    assert.equal(isCategoryOf('daily', '零食'), false);
    assert.equal(isCategoryOf('food', null), false);
  });

  it('换了食品 / 日用品：不属于新的那类就清空，「其他」两边都有留着', () => {
    assert.equal(categoryForKind('daily', '零食'), null);
    assert.equal(categoryForKind('daily', '其他'), '其他');
    assert.equal(categoryForKind('food', '乳品'), '乳品');
    assert.equal(categoryForKind('food', null), null);
  });

  it('列表筛选只列用到的分类，按固定顺序，不在列表里的排后面', () => {
    const products = [{ category: '乳品' }, { category: null }, { category: '零食' }, { category: '乳品' }, { category: '老分类' }];
    assert.deepEqual(usedCategories('food', products), ['零食', '乳品', '老分类']);
    assert.deepEqual(usedCategories('food', [{ category: null }]), []);
  });
});
