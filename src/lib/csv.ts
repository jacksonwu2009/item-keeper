/**
 * 生成 CSV 文本（给 Excel、WPS、Numbers 打开）。纯函数，有单测。
 * - 开头加 BOM，Excel 才认得出是 UTF-8，中文不乱码
 * - 含逗号、引号、换行的格子加引号
 * - 文字以 = + - @ 开头时前面加 '，免得被表格软件当成公式执行；数字不受影响
 * - 条码、序列号、发票号这类「看着像数字的文字」用 textCell 包一下，
 *   输出成 ="0123" 的写法，表格软件按文字显示，不会丢前导 0、不会变成 6.90123E+12
 */

/** 要按文字显示的格子（条码、序列号、发票号） */
export type CsvTextCell = { text: string };

export type CsvCell = string | number | null | undefined | CsvTextCell;

const BOM = '\uFEFF';

/** 表格软件会当成数字的样子：纯数字（可带前导 0）、小数、科学计数 */
const NUMBER_LIKE = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** 把条码、序列号、发票号这类值包成「按文字显示」的格子；空值返回 null */
export function textCell(value: string | null | undefined): CsvTextCell | null {
  const text = value?.trim();
  return text ? { text } : null;
}

function quoteIfNeeded(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  if (typeof cell === 'object') {
    // 只有看着像数字的才写成 ="…"；其余照普通文字处理（含公式防护）
    if (NUMBER_LIKE.test(cell.text)) return quoteIfNeeded(`="${cell.text}"`);
    return escapeCell(cell.text);
  }
  let text = cell;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return quoteIfNeeded(text);
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** 文件名里不能有的字符换成 -，如「北京/上海」 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
