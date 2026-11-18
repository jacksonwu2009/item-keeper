import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { safeFileName, toCsv } from '../src/lib/csv';

describe('CSV', () => {
  it('带 BOM，逗号、引号、换行加引号，空值留空', () => {
    const text = toCsv(['名称', '数量', '备注'], [
      ['可乐, 罐装', 12, null],
      ['说"明"', -3, '第一行\n第二行'],
    ]);
    assert.equal(
      text,
      '﻿名称,数量,备注\r\n"可乐, 罐装",12,\r\n"说""明""",-3,"第一行\n第二行"\r\n',
    );
  });

  it('文字开头是公式符号时加单引号，负数不加', () => {
    assert.equal(toCsv(['a', 'b'], [['=SUM(A1)', -5]]), "﻿a,b\r\n'=SUM(A1),-5\r\n");
  });

  it('文件名去掉非法字符', () => {
    assert.equal(safeFileName('库存 北京/上海: 11月'), '库存-北京-上海-11月');
  });
});
