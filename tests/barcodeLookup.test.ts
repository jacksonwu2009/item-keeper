import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_LOOKUP_FIELDS, lookupFieldsOf, mergeLookupFields, nameWithBrand } from '../src/lib/barcodeLookup';

describe('扫码查商品库后填表单', () => {
  const milk = { name: '某乳业纯牛奶', spec: '250ml' };
  const cookie = { name: '苏打饼干', spec: '' };

  it('第一次扫：空着的都填上', () => {
    assert.deepEqual(mergeLookupFields(EMPTY_LOOKUP_FIELDS, EMPTY_LOOKUP_FIELDS, milk), milk);
  });

  it('再扫别的：上一次带出来、没改过的换成新的，这次没有的那项清空', () => {
    assert.deepEqual(mergeLookupFields(milk, milk, cookie), cookie);
  });

  it('再扫别的：手动改过的不动', () => {
    const edited = { ...milk, name: '早餐奶（会议室）' };
    assert.deepEqual(mergeLookupFields(edited, milk, cookie), { name: '早餐奶（会议室）', spec: '' });
  });

  it('再扫的条码商品库里没有：上一次带出来的清掉，手动填的留着', () => {
    const edited = { ...milk, spec: '1L' };
    assert.deepEqual(mergeLookupFields(edited, milk, lookupFieldsOf(null)), { name: '', spec: '1L' });
  });

  it('编辑已有物品时扫码：原来的名称等不是扫码带出来的，不动，只补空着的', () => {
    const existing = { name: '咖啡豆', spec: '' };
    assert.deepEqual(mergeLookupFields(existing, EMPTY_LOOKUP_FIELDS, milk), { name: '咖啡豆', spec: '250ml' });
  });

  it('查到的结果换成表单两项：品牌拼进名称', () => {
    assert.deepEqual(lookupFieldsOf({ name: '纯牛奶', brand: '某乳业', spec: '250ml' }), { name: '某乳业纯牛奶', spec: '250ml' });
    assert.deepEqual(lookupFieldsOf({ name: '纯牛奶', brand: null, spec: null }), { name: '纯牛奶', spec: '' });
  });
});

describe('品牌拼进名称', () => {
  it('名称里没有品牌：拼在前面，中文直接连', () => {
    assert.equal(nameWithBrand('饮用天然水', '农夫山泉'), '农夫山泉饮用天然水');
  });

  it('挨着英文、数字时空一格', () => {
    assert.equal(nameWithBrand('Classic', 'Coca-Cola'), 'Coca-Cola Classic');
    assert.equal(nameWithBrand('可乐', 'Coca-Cola'), 'Coca-Cola 可乐');
    assert.equal(nameWithBrand('100%橙汁', '汇源'), '汇源 100%橙汁');
  });

  it('名称里已经有品牌（不分大小写）：不重复', () => {
    assert.equal(nameWithBrand('农夫山泉 饮用天然水', '农夫山泉'), '农夫山泉 饮用天然水');
    assert.equal(nameWithBrand('coca-cola zero', 'Coca-Cola'), 'coca-cola zero');
  });

  it('只有品牌：名称就是品牌；都没有是空的', () => {
    assert.equal(nameWithBrand(null, '某乳业'), '某乳业');
    assert.equal(nameWithBrand('  ', null), '');
  });
});
