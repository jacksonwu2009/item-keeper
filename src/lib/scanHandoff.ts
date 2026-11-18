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
