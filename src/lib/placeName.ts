/**
 * 根据定位反查到的地址，给办公点起几个候选名字（纯函数，有单测）。
 * 地址来自手机系统的地名查询或 OpenStreetMap，两边字段名不同，先统一成 PlaceParts。
 */

export type PlaceParts = {
  /** 地点名：楼宇、园区、商场等；有时是「xx 路 6 号」这样的门牌地址 */
  name?: string | null;
  street?: string | null;
  /** 区县，如「朝阳区」 */
  district?: string | null;
  /** 城市，如「北京市」 */
  city?: string | null;
  /** 省 */
  region?: string | null;
};

const MAX_NAME = 20;

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** 「北京市」→「北京」；「New York」原样 */
function shortCity(city: string): string {
  return city.length > 2 && city.endsWith('市') ? city.slice(0, -1) : city;
}

/** 门牌号、纯数字、和街道同名的不算地点名 */
function isPlaceName(name: string, street: string): boolean {
  if (!name) return false;
  if (/^\d+$/.test(name)) return false;
  if (/\d+\s*号$/.test(name)) return false;
  if (street && (name === street || name.startsWith(street))) return false;
  return true;
}

/**
 * 候选名字，按推荐顺序：地点名、城市+区、区+街道、城市。
 * 去掉重复、超过 20 个字的和已经存在的办公点名，最多 4 个。
 */
export function suggestOfficeNames(parts: PlaceParts, existingNames: readonly string[] = []): string[] {
  const name = clean(parts.name);
  const street = clean(parts.street);
  const district = clean(parts.district);
  const city = shortCity(clean(parts.city) || clean(parts.region));

  const candidates: string[] = [];
  if (isPlaceName(name, street)) candidates.push(name);
  if (city && district && !district.startsWith(city)) candidates.push(`${city}${district}`);
  if (district && street) candidates.push(`${district}${street}`);
  if (city) candidates.push(city);
  if (!candidates.length && district) candidates.push(district);

  const taken = new Set(existingNames.map((item) => item.trim()));
  const result: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length > MAX_NAME || taken.has(candidate) || result.includes(candidate)) continue;
    result.push(candidate);
    if (result.length === 4) break;
  }
  return result;
}

/** OpenStreetMap（Nominatim）反查结果转成 PlaceParts。 */
export function partsFromNominatim(json: unknown): PlaceParts | null {
  if (typeof json !== 'object' || json === null) return null;
  const data = json as { name?: unknown; address?: Record<string, unknown> };
  const address = data.address ?? {};
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = address[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };
  const parts: PlaceParts = {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : pick('building', 'office', 'amenity', 'shop'),
    street: pick('road', 'pedestrian'),
    district: pick('city_district', 'district', 'suburb', 'county'),
    city: pick('city', 'town', 'municipality', 'state_district'),
    region: pick('state', 'province'),
  };
  return Object.values(parts).some(Boolean) ? parts : null;
}
