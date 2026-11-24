/**
 * 报表的纯函数：算时间段、汇总库存 / 进货 / 消耗 / 设备，生成导出表格的行。有单测。
 * 数据由 src/db/report.ts 一次取回，这里只做计算，不碰数据库。
 */

import { textCell, type CsvCell } from './csv';
import { describeConfig, hasComputerConfig } from './devicePresets';
import { perBaseUnitPrice, roundTotalPrice } from './price';
import { expiryStatus, isLowStock } from './status';
import { KIND_LABEL, roundQty, type StockKind } from './stock';
import { currentScene, currentTerms } from './terms';
import { describeAccessories, warrantyStatus, type Accessory } from './warranty';

// ---------- 时间段 ----------

export type ReportPeriodKey = 'thisMonth' | 'lastMonth' | 'last3Months' | 'thisYear';

export const PERIOD_OPTIONS: { value: ReportPeriodKey; label: string }[] = [
  { value: 'thisMonth', label: '本月' },
  { value: 'lastMonth', label: '上月' },
  { value: 'last3Months', label: '近 3 个月' },
  { value: 'thisYear', label: '今年' },
];

export type ReportPeriod = {
  key: ReportPeriodKey;
  /** 显示和文件名用，如「2026年11月」「2026年9月–11月」「2026年」 */
  label: string;
  /** 本地时间的起点（含）和终点（不含），转成 ISO 后和 happened_at 比较 */
  startIso: string;
  endIso: string;
};

function monthLabel(year: number, monthIndex: number): string {
  return `${year}年${monthIndex + 1}月`;
}

/** 按手机本地时区算时间段。「近 3 个月」是本月加前两个月。 */
export function periodRange(key: ReportPeriodKey, now: Date = new Date()): ReportPeriod {
  const year = now.getFullYear();
  const month = now.getMonth();
  let start: Date;
  let end: Date;
  let label: string;
  if (key === 'thisMonth') {
    start = new Date(year, month, 1);
    end = new Date(year, month + 1, 1);
    label = monthLabel(year, month);
  } else if (key === 'lastMonth') {
    start = new Date(year, month - 1, 1);
    end = new Date(year, month, 1);
    label = monthLabel(start.getFullYear(), start.getMonth());
  } else if (key === 'last3Months') {
    start = new Date(year, month - 2, 1);
    end = new Date(year, month + 1, 1);
    label =
      start.getFullYear() === year
        ? `${year}年${start.getMonth() + 1}月–${month + 1}月`
        : `${monthLabel(start.getFullYear(), start.getMonth())}–${monthLabel(year, month)}`;
  } else {
    start = new Date(year, 0, 1);
    end = new Date(year + 1, 0, 1);
    label = `${year}年`;
  }
  return { key, label, startIso: start.toISOString(), endIso: end.toISOString() };
}

// ---------- 输入数据 ----------

export type ReportProduct = {
  id: number;
  officeId: number;
  kind: StockKind;
  /** 分类（粮油米面等），没选是 null */
  category: string | null;
  name: string;
  barcode: string | null;
  unit: string;
  location: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  totalQty: number;
  /** 有库存的批次里最早的过期日期 */
  nearestExpiry: string | null;
};

export type ReportBatch = {
  productId: number;
  quantity: number;
  expiryDate: string | null;
  addedOn: string;
};

export type ReportMovement = {
  id: number;
  productId: number;
  officeId: number;
  kind: StockKind;
  category: string | null;
  productName: string;
  unit: string;
  type: 'in' | 'out' | 'adjust';
  delta: number;
  happenedAt: string;
  note: string | null;
  inputQty: number | null;
  inputUnit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
};

/** 填了价格的入库，用来估算损失 */
export type PricedStockIn = {
  productId: number;
  delta: number;
  inputQty: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
  happenedAt: string;
};

export type ReportDevice = {
  id: number;
  officeId: number;
  category: string;
  name: string;
  model: string | null;
  serialNo: string | null;
  invoiceNo: string | null;
  chip: string | null;
  memory: string | null;
  storage: string | null;
  quantity: number;
  outQty: number;
  holders: string | null;
  purchaseDate: string | null;
  warrantyUntil: string | null;
};

export type ReportAssignment = { person: string; quantity: number };

/** 报表里引用一个物品：名单、排行都用它 */
export type ProductRef = { productId: number; name: string; kind: StockKind; detail: string };

// ---------- 库存概况 ----------

export type InventorySummary = {
  productCount: Record<StockKind, number>;
  lowStock: ProductRef[];
  expiringSoon: ProductRef[];
  expired: ProductRef[];
};

export function summarizeInventory(
  products: readonly ReportProduct[],
  today: string,
  defaultLeadDays: number,
): InventorySummary {
  const summary: InventorySummary = { productCount: { food: 0, daily: 0 }, lowStock: [], expiringSoon: [], expired: [] };
  for (const product of products) {
    summary.productCount[product.kind] += 1;
    if (isLowStock(product.totalQty, product.lowStockThreshold)) {
      summary.lowStock.push({
        productId: product.id,
        name: product.name,
        kind: product.kind,
        detail: `剩 ${roundQty(product.totalQty)} ${product.unit}`,
      });
    }
    const status = expiryStatus(product.nearestExpiry, today, product.expiryLeadDays ?? defaultLeadDays);
    if (status?.level === 'expired') {
      summary.expired.push({ productId: product.id, name: product.name, kind: product.kind, detail: status.text });
    } else if (status?.level === 'soon') {
      summary.expiringSoon.push({ productId: product.id, name: product.name, kind: product.kind, detail: status.text });
    }
  }
  // 最急的排前面：已过期、快到期都按最早过期日期排
  const expiryById = new Map(products.map((product) => [product.id, product.nearestExpiry ?? '']));
  const byExpiry = (left: ProductRef, right: ProductRef) =>
    (expiryById.get(left.productId) ?? '').localeCompare(expiryById.get(right.productId) ?? '');
  summary.expired.sort(byExpiry);
  summary.expiringSoon.sort(byExpiry);
  return summary;
}

// ---------- 进货 ----------

export type PurchaseRank = { productId: number; name: string; kind: StockKind; count: number; amount: number };

export type PurchaseSummary = {
  stockInCount: number;
  /** 填了总价的入库金额合计 */
  pricedAmount: number;
  /** 没填价格、没算进金额的入库次数 */
  unpricedCount: number;
  amountByKind: Record<StockKind, number>;
  topProducts: PurchaseRank[];
};

export function summarizePurchases(movements: readonly ReportMovement[], topCount = 10): PurchaseSummary {
  const summary: PurchaseSummary = {
    stockInCount: 0,
    pricedAmount: 0,
    unpricedCount: 0,
    amountByKind: { food: 0, daily: 0 },
    topProducts: [],
  };
  const byProduct = new Map<number, PurchaseRank>();
  for (const movement of movements) {
    if (movement.type !== 'in' || movement.delta <= 0) continue;
    summary.stockInCount += 1;
    const rank = byProduct.get(movement.productId) ?? {
      productId: movement.productId,
      name: movement.productName,
      kind: movement.kind,
      count: 0,
      amount: 0,
    };
    rank.count += 1;
    if (movement.totalPrice === null) {
      summary.unpricedCount += 1;
    } else {
      summary.pricedAmount += movement.totalPrice;
      summary.amountByKind[movement.kind] += movement.totalPrice;
      rank.amount += movement.totalPrice;
    }
    byProduct.set(movement.productId, rank);
  }
  summary.pricedAmount = roundTotalPrice(summary.pricedAmount);
  summary.amountByKind = {
    food: roundTotalPrice(summary.amountByKind.food),
    daily: roundTotalPrice(summary.amountByKind.daily),
  };
  summary.topProducts = [...byProduct.values()]
    .filter((rank) => rank.amount > 0)
    .map((rank) => ({ ...rank, amount: roundTotalPrice(rank.amount) }))
    .sort((left, right) => right.amount - left.amount || left.name.localeCompare(right.name))
    .slice(0, topCount);
  return summary;
}

// ---------- 消耗 ----------

/** 出库原因的固定顺序，和出库面板一致；别的原因排在后面 */
const REASON_ORDER = ['用掉', '过期丢弃', '坏了', '送人', '其他'];
/** 算作损失、要估金额的出库原因 */
export const LOSS_REASONS = ['过期丢弃', '坏了'];
const NO_REASON = '没写原因';

export type ReasonCount = { reason: string; count: number };
/** 出库排行：count 是出库次数，quantity 是出库数量（按该物品的最小单位） */
export type ConsumptionRank = {
  productId: number;
  name: string;
  kind: StockKind;
  unit: string;
  count: number;
  quantity: number;
};
export type LossEntry = {
  movementId: number;
  productId: number;
  name: string;
  unit: string;
  reason: string;
  quantity: number;
  happenedAt: string;
  /** 按出库前最近一次进价估的金额；没有进价时为 null */
  estimatedLoss: number | null;
};

export type ConsumptionSummary = {
  stockOutCount: number;
  reasons: ReasonCount[];
  topProducts: ConsumptionRank[];
  losses: LossEntry[];
  /** 能估出金额的损失合计 */
  estimatedLossTotal: number;
  /** 估不出金额（没有进价）的损失条数 */
  unestimatedLossCount: number;
};

/** 某物品在某时刻之前最近一次填了价格的入库，折成最小单位的单价 */
export function priceBefore(history: readonly PricedStockIn[], productId: number, beforeIso: string): number | null {
  let latest: PricedStockIn | null = null;
  for (const entry of history) {
    if (entry.productId !== productId || entry.happenedAt > beforeIso) continue;
    if (!latest || entry.happenedAt >= latest.happenedAt) latest = entry;
  }
  return latest ? perBaseUnitPrice(latest) : null;
}

type PricedEntry = { entry: PricedStockIn; order: number };

/**
 * 查「某物品在某时刻之前最近一次填了价格的入库」：先按物品分组、组里按时间排好，每次查用二分查找，
 * 不再每条损耗都把全部进价记录从头扫一遍。结果和 priceBefore 一样：时间相同的几条取原来排在后面的那条。
 */
export function createPriceLookup(history: readonly PricedStockIn[]): (productId: number, beforeIso: string) => number | null {
  const byProduct = new Map<number, PricedEntry[]>();
  history.forEach((entry, order) => {
    const list = byProduct.get(entry.productId);
    if (list) list.push({ entry, order });
    else byProduct.set(entry.productId, [{ entry, order }]);
  });
  // 按时间（和 priceBefore 一样直接比字符串）排，时间相同的按原来的先后
  for (const list of byProduct.values()) {
    list.sort((left, right) =>
      left.entry.happenedAt < right.entry.happenedAt ? -1 : left.entry.happenedAt > right.entry.happenedAt ? 1 : left.order - right.order,
    );
  }
  return (productId, beforeIso) => {
    const list = byProduct.get(productId);
    if (!list) return null;
    // 找第一条晚于 beforeIso 的，它前面那条就是最近一次
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (list[middle].entry.happenedAt > beforeIso) high = middle;
      else low = middle + 1;
    }
    return low === 0 ? null : perBaseUnitPrice(list[low - 1].entry);
  };
}

export function summarizeConsumption(
  movements: readonly ReportMovement[],
  priceHistory: readonly PricedStockIn[],
  topCount = 10,
): ConsumptionSummary {
  const reasonCounts = new Map<string, number>();
  const byProduct = new Map<number, ConsumptionRank>();
  const losses: LossEntry[] = [];
  const priceAt = createPriceLookup(priceHistory);
  let stockOutCount = 0;
  for (const movement of movements) {
    if (movement.type !== 'out' || movement.delta >= 0) continue;
    stockOutCount += 1;
    const reason = movement.note?.trim() || NO_REASON;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    const quantity = -movement.delta;
    const rank = byProduct.get(movement.productId) ?? {
      productId: movement.productId,
      name: movement.productName,
      kind: movement.kind,
      unit: movement.unit,
      count: 0,
      quantity: 0,
    };
    rank.count += 1;
    rank.quantity += quantity;
    byProduct.set(movement.productId, rank);
    if (LOSS_REASONS.includes(reason)) {
      const unitCost = priceAt(movement.productId, movement.happenedAt);
      losses.push({
        movementId: movement.id,
        productId: movement.productId,
        name: movement.productName,
        unit: movement.unit,
        reason,
        quantity: roundQty(quantity),
        happenedAt: movement.happenedAt,
        estimatedLoss: unitCost === null ? null : roundTotalPrice(unitCost * quantity),
      });
    }
  }
  const orderOf = (reason: string) => {
    const index = REASON_ORDER.indexOf(reason);
    return index === -1 ? REASON_ORDER.length : index;
  };
  const reasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => orderOf(left.reason) - orderOf(right.reason) || right.count - left.count);
  // 各物品单位不同（瓶、包、克），数量放在一起比没有意义，所以按出库次数排，同次数再按数量
  const topProducts = [...byProduct.values()]
    .map((rank) => ({ ...rank, quantity: roundQty(rank.quantity) }))
    .sort(
      (left, right) =>
        right.count - left.count || right.quantity - left.quantity || left.name.localeCompare(right.name),
    )
    .slice(0, topCount);
  losses.sort((left, right) => right.happenedAt.localeCompare(left.happenedAt));
  const estimated = losses.filter((loss) => loss.estimatedLoss !== null);
  return {
    stockOutCount,
    reasons,
    topProducts,
    losses,
    estimatedLossTotal: roundTotalPrice(estimated.reduce((sum, loss) => sum + (loss.estimatedLoss ?? 0), 0)),
    unestimatedLossCount: losses.length - estimated.length,
  };
}

// ---------- 物品明细 ----------

export type ProductDetailRow = {
  productId: number;
  name: string;
  kind: StockKind;
  unit: string;
  inQty: number;
  outQty: number;
  currentQty: number;
  /** 时间段内填了总价的入库金额；一次都没填为 null */
  purchaseAmount: number | null;
};

/** 每个物品一行，按食品、日用品分组，组内按名称。时间段内没有进出的物品也列出（进出都是 0）。 */
export function productDetails(
  products: readonly ReportProduct[],
  movements: readonly ReportMovement[],
): ProductDetailRow[] {
  const rows = new Map<number, ProductDetailRow>(
    products.map((product) => [
      product.id,
      {
        productId: product.id,
        name: product.name,
        kind: product.kind,
        unit: product.unit,
        inQty: 0,
        outQty: 0,
        currentQty: roundQty(product.totalQty),
        purchaseAmount: null,
      },
    ]),
  );
  for (const movement of movements) {
    const row = rows.get(movement.productId);
    if (!row) continue;
    if (movement.type === 'in' && movement.delta > 0) {
      row.inQty += movement.delta;
      if (movement.totalPrice !== null) row.purchaseAmount = (row.purchaseAmount ?? 0) + movement.totalPrice;
    } else if (movement.type === 'out' && movement.delta < 0) {
      row.outQty += -movement.delta;
    }
  }
  const kindOrder: Record<StockKind, number> = { food: 0, daily: 1 };
  return [...rows.values()]
    .map((row) => ({
      ...row,
      inQty: roundQty(row.inQty),
      outQty: roundQty(row.outQty),
      purchaseAmount: row.purchaseAmount === null ? null : roundTotalPrice(row.purchaseAmount),
    }))
    .sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.name.localeCompare(right.name, 'zh'));
}

// ---------- 设备 ----------

export type DeviceCategoryRow = { category: string; total: number; out: number; inStock: number };
/** 电脑按配置（芯片 内存/硬盘）统计，方便看哪批该换 */
export type DeviceConfigRow = { config: string; total: number; out: number; inStock: number };
export type HolderRank = { person: string; quantity: number };
export type WarrantyRef = { deviceId: number; name: string; quantity: number; text: string };

export type DeviceSummary = {
  total: number;
  out: number;
  inStock: number;
  byCategory: DeviceCategoryRow[];
  /** 只算笔记本、台式机；没记配置的归到「没记配置」 */
  byConfig: DeviceConfigRow[];
  /** 30 天内到期（含今天），按件数 */
  warrantySoonQty: number;
  warrantyExpiredQty: number;
  warrantySoon: WarrantyRef[];
  warrantyExpired: WarrantyRef[];
  holders: HolderRank[];
};

export function summarizeDevices(
  devices: readonly ReportDevice[],
  assignments: readonly ReportAssignment[],
  today: string,
): DeviceSummary {
  const categories = new Map<string, DeviceCategoryRow>();
  const configs = new Map<string, DeviceConfigRow>();
  const summary: DeviceSummary = {
    total: 0,
    out: 0,
    inStock: 0,
    byCategory: [],
    byConfig: [],
    warrantySoonQty: 0,
    warrantyExpiredQty: 0,
    warrantySoon: [],
    warrantyExpired: [],
    holders: [],
  };
  for (const device of devices) {
    const out = Math.min(device.outQty, device.quantity);
    const row = categories.get(device.category) ?? { category: device.category, total: 0, out: 0, inStock: 0 };
    row.total += device.quantity;
    row.out += out;
    row.inStock += device.quantity - out;
    categories.set(device.category, row);
    if (hasComputerConfig(device.category)) {
      const config = describeConfig(device) || '没记配置';
      const configRow = configs.get(config) ?? { config, total: 0, out: 0, inStock: 0 };
      configRow.total += device.quantity;
      configRow.out += out;
      configRow.inStock += device.quantity - out;
      configs.set(config, configRow);
    }
    summary.total += device.quantity;
    summary.out += out;
    summary.inStock += device.quantity - out;
    const status = warrantyStatus(device.warrantyUntil, today);
    const ref = { deviceId: device.id, name: device.name, quantity: device.quantity, text: status?.text ?? '' };
    if (status?.level === 'soon') {
      summary.warrantySoonQty += device.quantity;
      summary.warrantySoon.push(ref);
    } else if (status?.level === 'expired') {
      summary.warrantyExpiredQty += device.quantity;
      summary.warrantyExpired.push(ref);
    }
  }
  summary.byCategory = [...categories.values()].sort(
    (left, right) => right.total - left.total || left.category.localeCompare(right.category, 'zh'),
  );
  summary.byConfig = [...configs.values()].sort(
    (left, right) =>
      Number(left.config === '没记配置') - Number(right.config === '没记配置') ||
      right.total - left.total ||
      left.config.localeCompare(right.config, 'zh'),
  );
  const holders = new Map<string, number>();
  for (const assignment of assignments) {
    holders.set(assignment.person, (holders.get(assignment.person) ?? 0) + assignment.quantity);
  }
  summary.holders = [...holders.entries()]
    .map(([person, quantity]) => ({ person, quantity }))
    .sort((left, right) => right.quantity - left.quantity || left.person.localeCompare(right.person, 'zh'));
  return summary;
}

// ---------- 导出表格 ----------

export type CsvTable = { header: string[]; rows: CsvCell[][] };

const MOVEMENT_TYPE_LABEL: Record<ReportMovement['type'], string> = { in: '入库', out: '出库', adjust: '调整' };

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** ISO 时间转成本地的「2026-11-18 09:30」 */
export function formatLocalTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`;
}

type OfficeNameOf = (officeId: number) => string;

export function movementTable(movements: readonly ReportMovement[], officeName: OfficeNameOf): CsvTable {
  return {
    // 大类是食品 / 日用品，分类是粮油米面这些
    header: ['时间', currentTerms().place, '大类', '分类', '物品', '类型', '数量变化', '单位', '按什么单位输入', '单价', '总价', '原因/备注'],
    rows: movements.map((movement) => [
      formatLocalTimestamp(movement.happenedAt),
      officeName(movement.officeId),
      KIND_LABEL[movement.kind],
      movement.category,
      movement.productName,
      MOVEMENT_TYPE_LABEL[movement.type],
      roundQty(movement.delta),
      movement.unit,
      movement.inputUnit && movement.inputQty !== null ? `${roundQty(movement.inputQty)} ${movement.inputUnit}` : null,
      movement.unitPrice,
      movement.totalPrice,
      movement.note,
    ]),
  };
}

/** 当前库存：每个物品每一批一行；没有批次的物品也列一行，数量 0 */
export function stockTable(
  products: readonly ReportProduct[],
  batches: readonly ReportBatch[],
  officeName: OfficeNameOf,
): CsvTable {
  const batchesByProduct = new Map<number, ReportBatch[]>();
  for (const batch of batches) {
    const list = batchesByProduct.get(batch.productId) ?? [];
    list.push(batch);
    batchesByProduct.set(batch.productId, list);
  }
  const rows: CsvCell[][] = [];
  for (const product of products) {
    const base: CsvCell[] = [
      officeName(product.officeId),
      KIND_LABEL[product.kind],
      product.category,
      product.name,
      textCell(product.barcode),
    ];
    const productBatches = batchesByProduct.get(product.id) ?? [];
    if (!productBatches.length) {
      rows.push([...base, 0, product.unit, null, null, product.location]);
      continue;
    }
    for (const batch of productBatches) {
      rows.push([...base, roundQty(batch.quantity), product.unit, batch.expiryDate, batch.addedOn, product.location]);
    }
  }
  return { header: [currentTerms().place, '大类', '分类', '物品', '条码', '数量', '单位', '过期日期', '入库日期', '存放位置'], rows };
}

export function deviceTable(
  devices: readonly ReportDevice[],
  accessoriesByDevice: ReadonlyMap<number, Accessory[]>,
  officeName: OfficeNameOf,
): CsvTable {
  const table = fullDeviceTable(devices, accessoriesByDevice, officeName);
  if (currentScene() !== 'home') return table;
  // 家庭场景：没有借出、在库，「使用人」叫「谁在用」
  const dropped = new Set(['借出', '在库'].map((name) => table.header.indexOf(name)));
  const keep = (_: unknown, index: number) => !dropped.has(index);
  return {
    header: table.header.filter(keep).map((name) => (name === '使用人' ? '谁在用' : name)),
    rows: table.rows.map((row) => row.filter(keep)),
  };
}

function fullDeviceTable(
  devices: readonly ReportDevice[],
  accessoriesByDevice: ReadonlyMap<number, Accessory[]>,
  officeName: OfficeNameOf,
): CsvTable {
  return {
    header: [
      currentTerms().place,
      '类别',
      '名称',
      '型号',
      '芯片',
      '内存',
      '硬盘',
      '序列号',
      '发票号',
      '数量',
      '借出',
      '在库',
      '使用人',
      '购买日期',
      '保修到期',
      '配件',
    ],
    rows: devices.map((device) => {
      const out = Math.min(device.outQty, device.quantity);
      const holders = device.holders ? [...new Set(device.holders.split('、'))].join('，') : null;
      const accessories = accessoriesByDevice.get(device.id) ?? [];
      return [
        officeName(device.officeId),
        device.category,
        device.name,
        device.model,
        device.chip,
        device.memory,
        device.storage,
        textCell(device.serialNo),
        textCell(device.invoiceNo),
        device.quantity,
        out,
        device.quantity - out,
        holders,
        device.purchaseDate,
        device.warrantyUntil,
        accessories.length ? describeAccessories(accessories) : null,
      ];
    }),
  };
}

/** 导出文件名：「出入库明细-北京-2026年11月.csv」；全部办公点写「全部办公点」 */
export function reportFileName(title: string, officeLabel: string | null, periodLabel: string | null): string {
  return [title, officeLabel ?? `全部${currentTerms().place}`, periodLabel].filter(Boolean).join('-') + '.csv';
}
