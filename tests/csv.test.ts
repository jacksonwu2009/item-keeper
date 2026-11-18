import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { safeFileName, textCell, toCsv } from '../src/lib/csv';

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

  it('条码、序列号这类看着像数字的文字写成 ="…"，表格软件按文字显示', () => {
    assert.equal(
      toCsv(['条码', '序列号', '空'], [[textCell('012345678905'), textCell('C02XK1ABJGH5'), textCell(null)]]),
      '﻿条码,序列号,空\r\n"=""012345678905""",C02XK1ABJGH5,\r\n',
    );
    // 科学计数样子的也按文字
    assert.equal(toCsv(['a'], [[textCell('12E5')]]), '﻿a\r\n"=""12E5"""\r\n');
    // 不像数字的照普通文字处理，公式防护照样生效
    assert.equal(toCsv(['a'], [[textCell('=cmd')]]), "﻿a\r\n'=cmd\r\n");
    assert.equal(toCsv(['a'], [[textCell('FP, 001')]]), '﻿a\r\n"FP, 001"\r\n');
  });

  it('文件名去掉非法字符', () => {
    assert.equal(safeFileName('库存 北京/上海: 11月'), '库存-北京-上海-11月');
  });
});
