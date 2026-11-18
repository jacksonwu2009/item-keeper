/**
 * 数字输入框的纯函数：只留数字（和小数点），加减按钮按步长改值。有单测。
 */

/** 全角数字、全角句点、中文逗号先转成半角，免得中文输入法下输不进去。 */
function normalizeChars(text: string): string {
  return text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[．。，,]/g, '.');
}

/**
 * 只保留数字；decimals > 0 时再保留一个小数点和最多 decimals 位小数。
 * 去掉多余的前导 0（「007」→「7」，「0.5」保留）。
 */
export function sanitizeNumberText(text: string, decimals: number): string {
  const normalized = normalizeChars(text);
  if (decimals <= 0) {
    const digits = normalized.replace(/\D/g, '');
    return digits.replace(/^0+(?=\d)/, '');
  }
  let result = '';
  let seenDot = false;
  let fraction = 0;
  for (const char of normalized) {
    if (char >= '0' && char <= '9') {
      if (seenDot) {
        if (fraction >= decimals) continue;
        fraction++;
      }
      result += char;
    } else if (char === '.' && !seenDot) {
      seenDot = true;
      result += result === '' ? '0.' : '.';
    }
  }
  return result.replace(/^0+(?=\d)/, '');
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(value * factor) / factor;
}

/** 文字转数字；空串或只有「.」返回 null。 */
export function parseNumberText(text: string): number | null {
  if (!text || text === '.') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 加减按钮：在当前值上加 delta，夹在 [min, max] 之间。当前为空时，加得到 max(min, delta)，减停在 min。 */
export function stepNumberText(
  text: string,
  delta: number,
  options: { min: number; max: number; decimals: number },
): string {
  const current = parseNumberText(text);
  const base = current === null ? (delta > 0 ? Math.max(options.min, delta) - delta : options.min) : current;
  const next = roundTo(Math.min(options.max, Math.max(options.min, base + delta)), options.decimals);
  return String(next);
}
