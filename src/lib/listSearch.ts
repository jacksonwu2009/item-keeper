/**
 * 列表搜索的规则，纯函数：物品列表（StockList）、设备列表和提醒明细页用同一套。
 * 搜索框里的字去掉首尾空白、转小写当关键词；一样东西的几项文字（空的不算）用空格连起来转小写，包含关键词就算搜到。
 */
import type { DeviceSummary } from '../db/devices';
import { describeConfig } from './devicePresets';

/** 搜索框里的字 → 关键词（去掉首尾空白、转小写）；空串是没在搜 */
export function searchKeyword(query: string): string {
  return query.trim().toLowerCase();
}

/** 物品搜索用到的字段 */
export type StockSearchFields = {
  name: string;
  category: string | null;
  spec: string | null;
  location: string | null;
  barcode: string | null;
};

/** 物品拿来比关键词的文字：名称、分类、规格、位置、条码 */
export function stockSearchText(product: StockSearchFields): string {
  return [product.name, product.category, product.spec, product.location, product.barcode].filter(Boolean).join(' ').toLowerCase();
}

/** 设备搜索用到的字段 */
export type DeviceSearchFields = Pick<
  DeviceSummary,
  'name' | 'model' | 'chip' | 'memory' | 'storage' | 'serialNo' | 'invoiceNo' | 'category' | 'holders'
>;

/** 设备拿来比关键词的文字：名称、型号、配置（芯片、内存/存储）、序列号、发票号、分类、使用人 */
export function deviceSearchText(device: DeviceSearchFields): string {
  return [device.name, device.model, describeConfig(device), device.serialNo, device.invoiceNo, device.category, device.holders]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
