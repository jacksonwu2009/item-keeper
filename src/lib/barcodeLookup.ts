/**
 * 扫到没见过的条码时，去 Open Food Facts（开放的商品条码库）查商品名。
 * 只发条码本身，不带任何个人信息。国产商品收录不全，查不到就让用户手填，
 * 填过一次之后同一条码再扫就直接从本机库里认出来。
 */

export type BarcodeInfo = {
  name: string | null;
  brand: string | null;
  spec: string | null;
};

const ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'product_name,product_name_zh,product_name_en,generic_name,brands,quantity';

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function looksLikeProductBarcode(code: string): boolean {
  return /^\d{8,14}$/.test(code.trim());
}

export async function lookupBarcode(code: string, timeoutMs = 6000): Promise<BarcodeInfo | null> {
  if (!looksLikeProductBarcode(code)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ENDPOINT}${encodeURIComponent(code.trim())}.json?fields=${FIELDS}`, {
      headers: { 'User-Agent': 'ItemKeeper/1.0 (mobile)' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { status?: number; product?: Record<string, unknown> };
    if (json.status !== 1 || !json.product) return null;
    const product = json.product;
    const name =
      clean(product.product_name_zh) ??
      clean(product.product_name) ??
      clean(product.product_name_en) ??
      clean(product.generic_name);
    const brand = clean(product.brands)?.split(',')[0]?.trim() ?? null;
    const spec = clean(product.quantity);
    if (!name && !brand) return null;
    return { name, brand, spec };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
