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

export type LookupFields = { name: string; spec: string };

export const EMPTY_LOOKUP_FIELDS: LookupFields = { name: '', spec: '' };

/**
 * 新扫的条码查完后，表单上的名称、规格各填什么：
 * 空着的、或者还是上一次扫码带出来的（没手动改过），换成这次查到的（这次没查到的那一项清空，免得留着上一个物品的信息）；
 * 手动填过、改过的不动。
 */
export function mergeLookupFields(current: LookupFields, previousAuto: LookupFields, next: LookupFields): LookupFields {
  const pick = (key: keyof LookupFields) => (current[key] === '' || current[key] === previousAuto[key] ? next[key] : current[key]);
  return { name: pick('name'), spec: pick('spec') };
}

/**
 * 物品不记品牌：商品库带出的品牌，名称里没有就拼到名称前面（如「农夫山泉饮用天然水」）；
 * 挨着的是英文字母、数字时中间空一格；只有品牌没有名称时名称就是品牌
 */
export function nameWithBrand(name: string | null, brand: string | null): string {
  const base = name?.trim() ?? '';
  const prefix = brand?.trim() ?? '';
  if (!prefix || base.toLowerCase().includes(prefix.toLowerCase())) return base;
  if (!base) return prefix;
  const gap = /[A-Za-z0-9]$/.test(prefix) || /^[A-Za-z0-9]/.test(base) ? ' ' : '';
  return `${prefix}${gap}${base}`;
}

/** 查商品库的结果换成表单里的两项（没查到就都是空的） */
export function lookupFieldsOf(info: BarcodeInfo | null): LookupFields {
  return { name: nameWithBrand(info?.name ?? null, info?.brand ?? null), spec: info?.spec ?? '' };
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
