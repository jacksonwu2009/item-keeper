import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_LOOKUP_FIELDS, lookupFieldsOf, mergeLookupFields } from '../src/lib/barcodeLookup';

describe('扫码查商品库后填表单', () => {
  const milk = { name: '纯牛奶', brand: '某乳业', spec: '250ml×12' };
  const cookie = { name: '苏打饼干', brand: '某食品', spec: '' };

  it('第一次扫：空着的都填上', () => {
    assert.deepEqual(mergeLookupFields(EMPTY_LOOKUP_FIELDS, EMPTY_LOOKUP_FIELDS, milk), milk);
  });

  it('再扫别的：上一次带出来、没改过的换成新的，这次没有的那项清空', () => {
    assert.deepEqual(mergeLookupFields(milk, milk, cookie), cookie);
  });

  it('再扫别的：手动改过的不动', () => {
    const edited = { ...milk, name: '早餐奶（会议室）' };
    assert.deepEqual(mergeLookupFields(edited, milk, cookie), { name: '早餐奶（会议室）', brand: '某食品', spec: '' });
  });

  it('再扫的条码商品库里没有：上一次带出来的清掉，手动填的留着', () => {
    const edited = { ...milk, spec: '1L' };
    assert.deepEqual(mergeLookupFields(edited, milk, lookupFieldsOf(null)), { name: '', brand: '', spec: '1L' });
  });

  it('编辑已有物品时扫码：原来的名称等不是扫码带出来的，不动，只补空着的', () => {
    const existing = { name: '咖啡豆', brand: '', spec: '' };
    assert.deepEqual(mergeLookupFields(existing, EMPTY_LOOKUP_FIELDS, milk), { name: '咖啡豆', brand: '某乳业', spec: '250ml×12' });
  });

  it('查到的结果换成表单三项', () => {
    assert.deepEqual(lookupFieldsOf({ name: '纯牛奶', brand: null, spec: '250ml' }), { name: '纯牛奶', brand: '', spec: '250ml' });
  });
});
