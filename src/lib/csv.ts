/**
 * 生成 CSV 文本（给 Excel、WPS、Numbers 打开）。纯函数，有单测。
 * - 开头加 BOM，Excel 才认得出是 UTF-8，中文不乱码
 * - 含逗号、引号、换行的格子加引号
 * - 文字以 = + - @ 开头时前面加 '，免得被表格软件当成公式执行；数字不受影响
 */

export type CsvCell = string | number | null | undefined;

const BOM = '﻿';

function escapeCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  let text = cell;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** 文件名里不能有的字符换成 -，如「北京/上海」 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
