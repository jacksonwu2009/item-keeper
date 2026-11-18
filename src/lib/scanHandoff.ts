/**
 * 「扫一下填进表单」用的中转：表单打开扫码页，扫码页把结果放这里再返回，
 * 表单回到前台时取走。只在内存里，不跨重启。
 */

let pending: { target: string; code: string } | null = null;

export function putScanResult(target: string, code: string): void {
  pending = { target, code };
}

export function takeScanResult(target: string): string | null {
  if (!pending || pending.target !== target) return null;
  const { code } = pending;
  pending = null;
  return code;
}

/** 取走目标以 prefix 开头的扫码结果（表单里有多行都能扫时用），返回目标名和条码。 */
export function takeScanResultWithPrefix(prefix: string): { target: string; code: string } | null {
  if (!pending || !pending.target.startsWith(prefix)) return null;
  const result = pending;
  pending = null;
  return result;
}
