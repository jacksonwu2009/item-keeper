/**
 * 新增设备时的快速选择、电脑配置和扫码：
 * - 内置常用设备（以 Mac 为主），选了自动填类别、名称和常见配件；自己登记过的组合排在前面
 * - 电脑的芯片、内存、硬盘分开记；Mac 的芯片可以点选（代数 + 档次）
 * - 扫码得到的文字里认出序列号（苹果包装盒上的序列号条码前面带 S）
 * 纯函数，有单测。
 */

import type { Accessory } from './warranty';

export type DevicePreset = {
  category: string;
  name: string;
  model?: string | null;
  chip?: string | null;
  memory?: string | null;
  storage?: string | null;
  accessories: Accessory[];
};

/** 这些类别显示芯片、内存、硬盘 */
export const CONFIG_CATEGORIES = ['笔记本', '台式机'];

export function hasComputerConfig(category: string): boolean {
  return CONFIG_CATEGORIES.includes(category);
}

const MAC_CHARGER: Accessory[] = [
  { name: '电源适配器', quantity: 1 },
  { name: '充电线', quantity: 1 },
];

export const BUILTIN_DEVICE_PRESETS: DevicePreset[] = [
  { category: '笔记本', name: 'MacBook Air 13 英寸', accessories: MAC_CHARGER },
  { category: '笔记本', name: 'MacBook Air 15 英寸', accessories: MAC_CHARGER },
  { category: '笔记本', name: 'MacBook Pro 14 英寸', accessories: MAC_CHARGER },
  { category: '笔记本', name: 'MacBook Pro 16 英寸', accessories: MAC_CHARGER },
  { category: '台式机', name: 'Mac mini', accessories: [{ name: '电源线', quantity: 1 }] },
  { category: '台式机', name: 'Mac Studio', accessories: [{ name: '电源线', quantity: 1 }] },
  {
    category: '台式机',
    name: 'iMac 24 英寸',
    accessories: [
      { name: '电源适配器', quantity: 1 },
      { name: '妙控键盘', quantity: 1 },
      { name: '妙控鼠标', quantity: 1 },
    ],
  },
  { category: '显示器', name: 'Studio Display', accessories: [{ name: '雷雳线', quantity: 1 }] },
  { category: '键盘', name: '妙控键盘', accessories: [{ name: '充电线', quantity: 1 }] },
  { category: '鼠标', name: '妙控鼠标', accessories: [{ name: '充电线', quantity: 1 }] },
  { category: '鼠标', name: '妙控板', accessories: [{ name: '充电线', quantity: 1 }] },
];

/** 电脑配置连起来显示：M3 Pro 18G/512G */
export function describeConfig(config: { chip?: string | null; memory?: string | null; storage?: string | null }): string {
  const size = [config.memory, config.storage].filter(Boolean).join('/');
  return [config.chip, size].filter(Boolean).join(' ');
}

/** 选项按钮上显示的文字：有配置、型号时带上 */
export function presetLabel(preset: DevicePreset): string {
  const extra = [describeConfig(preset), preset.model].filter(Boolean).join(' ');
  return extra ? `${preset.name} · ${extra}` : preset.name;
}

/** 比较名称时不管空格和大小写：「MacBook Pro 14英寸」和「MacBook Pro 14 英寸」算同一个 */
function presetKey(preset: DevicePreset): string {
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, '').toLowerCase();
  return [preset.category, preset.name, preset.model, preset.chip, preset.memory, preset.storage].map(normalize).join('|');
}

/** 表单里现在填的（类别、名称、型号、配置）还是不是这个快速选项：是的话快速选择里把它标成选中 */
export function presetMatchesForm(preset: DevicePreset, form: Omit<DevicePreset, 'accessories'>): boolean {
  return presetKey(preset) === presetKey({ ...form, accessories: [] });
}

/** 自己登记过的组合排在前面；内置的里和自己登记过的同名（不管配置）就不再列出 */
export function mergePresets(recent: DevicePreset[], builtin: DevicePreset[] = BUILTIN_DEVICE_PRESETS): DevicePreset[] {
  const recentKeys = new Set(recent.map(presetKey));
  const recentNames = new Set(recent.map((preset) => preset.name.replace(/\s+/g, '').toLowerCase()));
  const extraBuiltin = builtin.filter(
    (preset) => !recentKeys.has(presetKey(preset)) && !recentNames.has(preset.name.replace(/\s+/g, '').toLowerCase()),
  );
  return [...recent, ...extraBuiltin];
}

// ---- 电脑配置 ----

export const MAC_CHIP_GENERATIONS = ['M1', 'M2', 'M3', 'M4', 'M5'] as const;
export const MAC_CHIP_TIERS = ['', 'Pro', 'Max', 'Ultra'] as const;
export const MEMORY_OPTIONS = ['8G', '16G', '18G', '24G', '32G', '36G', '48G', '64G', '128G'] as const;
export const STORAGE_OPTIONS = ['256G', '512G', '1T', '2T', '4T'] as const;

/** 名称里带 Mac 的，芯片显示 M1–M5 的点选 */
export function isMacName(name: string): boolean {
  return /\b(mac|imac|macbook)/i.test(name.trim());
}

/** 苹果芯片：代数 + 档次（空串 = 标准版），如 M3 + Pro → M3 Pro */
export function composeChip(generation: string | null, tier: string): string {
  if (!generation) return '';
  return tier ? `${generation} ${tier}` : generation;
}

/** 从芯片文字读回代数和档次；不是苹果芯片（如 i7-1260P）时代数为 null */
export function parseChip(chip: string | null | undefined): { generation: string | null; tier: string } {
  const match = (chip ?? '').trim().match(/^(M[1-9])(?:\s+(Pro|Max|Ultra))?$/i);
  if (!match) return { generation: null, tier: '' };
  const generation = match[1].toUpperCase();
  const tier = match[2] ? (MAC_CHIP_TIERS.find((value) => value.toLowerCase() === match[2].toLowerCase()) ?? '') : '';
  return { generation, tier };
}

/** 内存、硬盘统一写法：16gb → 16G，1 TB → 1T，纯数字按 G */
export function normalizeCapacity(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(G|GB|T|TB)?$/i);
  if (!match) return text;
  const unit = (match[2] ?? 'G').toUpperCase().startsWith('T') ? 'T' : 'G';
  return `${match[1]}${unit}`;
}

/**
 * 以前芯片、内存、硬盘都写在「型号」里（如「M3 Pro 18G/512G 深空黑」）。
 * 拆出来：认得出的芯片、内存/硬盘放进各自的栏，剩下的文字留在型号里；什么都认不出返回 null。
 */
export function splitLegacyModel(
  model: string | null | undefined,
): { chip: string | null; memory: string | null; storage: string | null; model: string | null } | null {
  let rest = (model ?? '').trim();
  if (!rest) return null;
  let chip: string | null = null;
  let memory: string | null = null;
  let storage: string | null = null;

  const chipMatch = rest.match(/\b(M[1-9])(?:\s+(Pro|Max|Ultra))?\b/i);
  if (chipMatch) {
    const parsed = parseChip(chipMatch[0]);
    chip = composeChip(parsed.generation, parsed.tier);
    rest = rest.replace(chipMatch[0], ' ');
  }
  const sizeMatch = rest.match(/\b(\d+)\s*G(?:B)?\s*\/\s*(\d+(?:\.\d+)?)\s*(G|T)(?:B)?\b/i);
  if (sizeMatch) {
    memory = `${sizeMatch[1]}G`;
    storage = `${sizeMatch[2]}${sizeMatch[3].toUpperCase()}`;
    rest = rest.replace(sizeMatch[0], ' ');
  }
  if (!chip && !memory) return null;
  const remaining = rest.replace(/\s+/g, ' ').replace(/^[\s,，/·-]+|[\s,，/·-]+$/g, '').trim();
  return { chip, memory, storage, model: remaining || null };
}

// ---- 扫码认序列号 ----

export type DeviceCodeResult =
  | { kind: 'serial'; serial: string }
  /** 商品条码（同款每台都一样）或苹果的型号编号（Part No.），不是序列号 */
  | { kind: 'notSerial'; reason: string };

const PRODUCT_BARCODE_TYPES = new Set(['ean13', 'ean8', 'upc_a', 'upc_e', 'itf14']);

/**
 * 扫到的文字里取序列号。
 * 苹果包装盒的标签上有几个条码：序列号条码内容是「S + 序列号」（序列号 10 或 12 位），
 * 型号编号是「1P + 编号」（如 1PMRX33CH/A），还有一个商品条码（数字）。只认序列号那个。
 */
export function parseDeviceCode(raw: string, barcodeType?: string | null): DeviceCodeResult {
  const text = raw.trim().toUpperCase();
  if (barcodeType && PRODUCT_BARCODE_TYPES.has(barcodeType.toLowerCase())) {
    return { kind: 'notSerial', reason: '这是商品条码，同款设备都一样。请扫标着 Serial No. 的条码' };
  }
  if (/^1P[A-Z0-9]+(\/[A-Z])?$/.test(text)) {
    return { kind: 'notSerial', reason: '这是型号编号（Part No.），请扫标着 Serial No. 的条码' };
  }
  if (/^S[A-Z0-9]{10}$/.test(text) || /^S[A-Z0-9]{12}$/.test(text)) {
    return { kind: 'serial', serial: text.slice(1) };
  }
  return { kind: 'serial', serial: text };
}
