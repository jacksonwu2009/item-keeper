/**
 * 报表首页（图表）和明细页的纯函数：时间段切成几根柱子、把聚合查询的结果整理成首页要画的数字和条形、
 * 明细页的种类、筛选条件和每一行显示的文字。有单测。
 *
 * 单机版、联网版两个仓的这个文件一字不差（同 labelParse.ts），改了要两边一起改。
 * 数据怎么来各仓自己管：手机读本机库，用 GROUP BY 直接算出数字（db/reportOverview.ts）；联网版网页向服务端要算好的
 * （/api/view/report-summary、/api/view/report-details）。两边交到这里的「聚合行」是一个样子。
 * 规则和逐条算的 lib/report.ts（导出表格时用）一致：调拨、冲正记录、被冲正的记录不算进货也不算消耗，
 * 估算损失按出库前最近一次的进价；单测拿同一批数据比对两种算法。
 */

import { compareDefault, compareZh } from './collate';
import { usedCategories } from './categories';
import { describeDaysLeft, diffDays, formatShortDate, toDateStr } from './dates';
import { describeConfig } from './devicePresets';
import { formatPrice, perBaseUnitPrice, roundTotalPrice } from './price';
import { KIND_LABEL, roundQty, type StockKind } from './stock';
import { warrantyStatus } from './warranty';

// ---------- 时间分桶（进货的柱状图） ----------

export type OverviewPeriodKey = 'thisMonth' | 'lastMonth' | 'last3Months' | 'thisYear';

/** 一根柱子：显示的标签和起止时刻（本地时间的零点转成 ISO，起点含、终点不含，和 lib/report.ts 的 periodRange 一样） */
export type ReportBucket = { label: string; startIso: string; endIso: string };

/**
 * 把时间段切成柱子：今年按月（1–12 月）、近 3 个月按月、本月和上月按周。
 * 周是周一到周日，月初、月末不满一周的那几天也单独一根；标签写日期范围，如「2–8日」，只有一天的写「1日」。
 * 第一根的起点、最后一根的终点就是 periodRange 的起止。
 */
export function periodBuckets(key: OverviewPeriodKey, now: Date = new Date()): ReportBucket[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  if (key === 'thisYear') return monthBuckets(year, 0, 12);
  if (key === 'last3Months') return monthBuckets(year, month - 2, 3);
  return weekBuckets(key === 'thisMonth' ? new Date(year, month, 1) : new Date(year, month - 1, 1));
}

function monthBuckets(year: number, firstMonth: number, count: number): ReportBucket[] {
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(year, firstMonth + index, 1);
    const end = new Date(year, firstMonth + index + 1, 1);
    return { label: `${start.getMonth() + 1}月`, startIso: start.toISOString(), endIso: end.toISOString() };
  });
}

function weekBuckets(first: Date): ReportBucket[] {
  const year = first.getFullYear();
  const month = first.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const buckets: ReportBucket[] = [];
  let startDay = 1;
  while (startDay <= lastDay) {
    // getDay：0 是周日。从 startDay 数到这周的周日（或月底）
    const toSunday = (7 - new Date(year, month, startDay).getDay()) % 7;
    const endDay = Math.min(lastDay, startDay + toSunday);
    buckets.push({
      label: startDay === endDay ? `${startDay}日` : `${startDay}–${endDay}日`,
      startIso: new Date(year, month, startDay).toISOString(),
      endIso: new Date(year, month, endDay + 1).toISOString(),
    });
    startDay = endDay + 1;
  }
  return buckets;
}

/** 分桶的边界（第一根的起点，再加每一根的终点，共 n + 1 个）：联网版网页把它带给服务端，服务端照着分 */
export function bucketEdges(buckets: readonly ReportBucket[]): string[] {
  return buckets.length ? [buckets[0].startIso, ...buckets.map((bucket) => bucket.endIso)] : [];
}

// ---------- 聚合行（本机库、服务端查出来的样子） ----------

/** 每个大类的物品数，和其中库存不足、快到期、已过期的样数（按「今天」和到期前几天算） */
export type InventoryRow = { kind: StockKind; products: number; lowStock: number; expiring: number; expired: number };
/** 进货按 大类 × 分类 × 第几根柱子 合计：入库次数、没填总价的次数、填了总价的金额合计（一次都没填为 null） */
export type PurchaseRow = { kind: StockKind; category: string | null; bucket: number; count: number; unpriced: number; amount: number | null };
/** 出库按原备注（原因）原样合计次数；去掉首尾空白、合并在这里做 */
export type OutNoteRow = { note: string | null; count: number };
/** 出库多的物品（查询按次数、数量取前几十样，排名在这里定） */
export type ConsumerRow = { productId: number; name: string; kind: StockKind; unit: string; count: number; quantity: number };
/** 损耗（过期丢弃、坏了）的合计：条数、能估出的损失金额、没有进价估不出的条数 */
export type LossSummary = { count: number; estimatedTotal: number; unestimatedCount: number };
/** 设备按类别：件数、借出件数（每台不超过它的数量）、保修 30 天内到期和已过保的件数 */
export type DeviceCategoryRow = { category: string; quantity: number; out: number; warrantySoon: number; warrantyExpired: number };
/** 还没还的领用按人合计：personUid、departmentUid 只有联网版有（名单里的人、他的部门），单机版为 null */
export type HolderRow = { person: string; personUid: string | null; departmentUid: string | null; quantity: number };

export type OverviewRows = {
  inventory: InventoryRow[];
  purchases: PurchaseRow[];
  outNotes: OutNoteRow[];
  consumers: ConsumerRow[];
  losses: LossSummary;
  devices: DeviceCategoryRow[];
  holders: HolderRow[];
};

/** 查出库多的物品时取前几样（同次数、同数量的按名称再排一次，取前 OVERVIEW_TOP） */
export const CONSUMER_CANDIDATES = 50;
/** 首页每张横条图最多几条（其余的合成一条「其余 N 类」） */
export const OVERVIEW_TOP = 5;

// ---------- 损耗 ----------

/** 出库原因的固定顺序（和出库面板一致），别的原因排在后面 */
export const REASON_ORDER = ['用掉', '过期丢弃', '坏了', '送人', '其他'];
/** 算作损失、要估金额的出库原因 */
export const LOSS_REASON_LIST = ['过期丢弃', '坏了'];
export const NO_REASON = '没写原因';

/** 出库备注当原因：去掉首尾空白，空的算「没写原因」 */
export function reasonOf(note: string | null | undefined): string {
  return note?.trim() || NO_REASON;
}

export function isLossNote(note: string | null | undefined): boolean {
  return LOSS_REASON_LIST.includes(reasonOf(note));
}

/** 进价那条入库的数量和价格（折成最小单位的单价见 perBaseUnitPrice） */
export type PriceFields = { delta: number; inputQty: number | null; unitPrice: number | null; totalPrice: number | null };

/** 一条损耗：数量（正数，最小单位）、出库前最近一次的进价（没有为 null） */
export type LossRow = { note: string | null; quantity: number; price: PriceFields | null };

/** 一条损耗估出的金额：最近一次进价折成最小单位 × 数量，总价保留 2 位；没有进价为 null */
export function lossEstimate(row: { quantity: number; price: PriceFields | null }): number | null {
  const unitCost = row.price ? perBaseUnitPrice(row.price) : null;
  return unitCost === null ? null : roundTotalPrice(unitCost * row.quantity);
}

/** 损耗合计（只算原因是过期丢弃、坏了的；rows 可以多给别的出库，这里再挑一遍） */
export function summarizeLossRows(rows: readonly LossRow[]): LossSummary {
  let count = 0;
  let total = 0;
  let unestimated = 0;
  for (const row of rows) {
    if (!isLossNote(row.note)) continue;
    count += 1;
    const estimate = lossEstimate(row);
    if (estimate === null) unestimated += 1;
    else total += estimate;
  }
  return { count, estimatedTotal: roundTotalPrice(total), unestimatedCount: unestimated };
}

// ---------- 首页 ----------

/** 横条图的一条：key 稳定（画图不用下标当 key），value 决定条的长短，text 是右边写的数 */
export type BarDatum = { key: string; label: string; value: number; text: string };
/** 柱状图的一根 */
export type ColumnDatum = { key: string; label: string; value: number; count: number };

export type ConsumptionTop = { productId: number; name: string; kind: StockKind; unit: string; count: number; quantity: number };

export type ReportOverview = {
  inventory: { total: number; byKind: Record<StockKind, number>; lowStock: number; expiring: number; expired: number };
  purchases: {
    count: number;
    amount: number;
    unpricedCount: number;
    amountByKind: Record<StockKind, number>;
    /** 每根柱子的进货金额和入库次数 */
    columns: ColumnDatum[];
    /** 按分类的进货金额，前 OVERVIEW_TOP 个，其余合成一条 */
    categories: BarDatum[];
  };
  consumption: {
    count: number;
    /** 按原因的出库次数（固定顺序，别的原因按次数） */
    reasons: BarDatum[];
    top: ConsumptionTop[];
    losses: LossSummary;
  };
  devices: {
    total: number;
    out: number;
    inStock: number;
    /** 按类别的件数，前 OVERVIEW_TOP 个，其余合成一条 */
    categories: BarDatum[];
    warrantySoon: number;
    warrantyExpired: number;
    /** 领用最多的几个人（按件数） */
    holders: BarDatum[];
  };
};

export const EMPTY_OVERVIEW_ROWS: OverviewRows = {
  inventory: [],
  purchases: [],
  outNotes: [],
  consumers: [],
  losses: { count: 0, estimatedTotal: 0, unestimatedCount: 0 },
  devices: [],
  holders: [],
};

/** 取前 top 条，其余合成一条「其余 N 个」（只多一个时直接列出来） */
function topWithRest(items: BarDatum[], top: number, restText: (value: number) => string, unit: string): BarDatum[] {
  if (items.length <= top + 1) return items;
  const rest = items.slice(top);
  const value = rest.reduce((sum, item) => sum + item.value, 0);
  return [...items.slice(0, top), { key: '__rest__', label: `其余 ${rest.length} ${unit}`, value, text: restText(value) }];
}

/** 分类的显示名：没选的叫「没选分类」；同一个名字两个大类都有（比如「其他」）时后面注上大类 */
function categoryLabels(rows: readonly { kind: StockKind; category: string | null }[]): (kind: StockKind, category: string | null) => string {
  const kindsByName = new Map<string, Set<StockKind>>();
  for (const row of rows) {
    const name = row.category ?? '没选分类';
    const kinds = kindsByName.get(name) ?? new Set<StockKind>();
    kinds.add(row.kind);
    kindsByName.set(name, kinds);
  }
  return (kind, category) => {
    const name = category ?? '没选分类';
    return (kindsByName.get(name)?.size ?? 0) > 1 ? `${name}（${KIND_LABEL[kind]}）` : name;
  };
}

/** 把聚合行整理成首页要画的东西；bucketLabels 是各根柱子的标签（periodBuckets 的顺序） */
export function buildOverview(rows: OverviewRows, bucketLabels: readonly string[]): ReportOverview {
  // 库存概况
  const byKind: Record<StockKind, number> = { food: 0, daily: 0 };
  let lowStock = 0;
  let expiring = 0;
  let expired = 0;
  for (const row of rows.inventory) {
    byKind[row.kind] += row.products;
    lowStock += row.lowStock;
    expiring += row.expiring;
    expired += row.expired;
  }

  // 进货
  let purchaseCount = 0;
  let unpricedCount = 0;
  let amount = 0;
  const amountByKind: Record<StockKind, number> = { food: 0, daily: 0 };
  const columns: ColumnDatum[] = bucketLabels.map((label, index) => ({ key: String(index), label, value: 0, count: 0 }));
  const categoryTotals = new Map<string, { kind: StockKind; category: string | null; amount: number; count: number }>();
  for (const row of rows.purchases) {
    purchaseCount += row.count;
    unpricedCount += row.unpriced;
    const rowAmount = row.amount ?? 0;
    amount += rowAmount;
    amountByKind[row.kind] += rowAmount;
    const column = columns[row.bucket];
    if (column) {
      column.value += rowAmount;
      column.count += row.count;
    }
    const key = `${row.kind}\u0000${row.category ?? ''}`;
    const total = categoryTotals.get(key) ?? { kind: row.kind, category: row.category, amount: 0, count: 0 };
    total.amount += rowAmount;
    total.count += row.count;
    categoryTotals.set(key, total);
  }
  for (const column of columns) column.value = roundTotalPrice(column.value);
  const labelOf = categoryLabels([...categoryTotals.values()]);
  const categoryBars = [...categoryTotals.values()]
    .map((total) => ({ ...total, amount: roundTotalPrice(total.amount), label: labelOf(total.kind, total.category) }))
    .filter((total) => total.amount > 0)
    .sort((left, right) => right.amount - left.amount || right.count - left.count || compareZh(left.label, right.label))
    .map((total) => ({ key: `${total.kind}:${total.category ?? ''}`, label: total.label, value: total.amount, text: formatPrice(total.amount) }));

  // 消耗：原因按固定顺序，别的按次数；出库多的按次数、再按数量（各物品单位不同，数量只在同次数时比）
  const reasonCounts = new Map<string, number>();
  let outCount = 0;
  for (const row of rows.outNotes) {
    const reason = reasonOf(row.note);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + row.count);
    outCount += row.count;
  }
  const orderOf = (reason: string) => {
    const index = REASON_ORDER.indexOf(reason);
    return index === -1 ? REASON_ORDER.length : index;
  };
  const reasons = [...reasonCounts.entries()]
    .sort(([left, leftCount], [right, rightCount]) => orderOf(left) - orderOf(right) || rightCount - leftCount || compareZh(left, right))
    .map(([reason, count]) => ({ key: reason, label: reason, value: count, text: `${count} 次` }));
  const top = rows.consumers
    .map((row) => ({ ...row, quantity: roundQty(row.quantity) }))
    .sort((left, right) => right.count - left.count || right.quantity - left.quantity || compareDefault(left.name, right.name))
    .slice(0, OVERVIEW_TOP);

  // 设备
  let deviceTotal = 0;
  let deviceOut = 0;
  let warrantySoon = 0;
  let warrantyExpired = 0;
  for (const row of rows.devices) {
    deviceTotal += row.quantity;
    deviceOut += row.out;
    warrantySoon += row.warrantySoon;
    warrantyExpired += row.warrantyExpired;
  }
  const deviceBars = [...rows.devices]
    .sort((left, right) => right.quantity - left.quantity || compareZh(left.category, right.category))
    .map((row) => ({ key: row.category, label: row.category, value: row.quantity, text: `${row.quantity} 件` }));
  const holderTotals = new Map<string, number>();
  for (const row of rows.holders) holderTotals.set(row.person, (holderTotals.get(row.person) ?? 0) + row.quantity);
  const holders = [...holderTotals.entries()]
    .sort(([left, leftQty], [right, rightQty]) => rightQty - leftQty || compareZh(left, right))
    .slice(0, OVERVIEW_TOP)
    .map(([person, quantity]) => ({ key: person, label: person, value: quantity, text: `${quantity} 件` }));

  return {
    inventory: { total: byKind.food + byKind.daily, byKind, lowStock, expiring, expired },
    purchases: {
      count: purchaseCount,
      amount: roundTotalPrice(amount),
      unpricedCount,
      amountByKind: { food: roundTotalPrice(amountByKind.food), daily: roundTotalPrice(amountByKind.daily) },
      columns,
      categories: topWithRest(categoryBars, OVERVIEW_TOP, (value) => formatPrice(roundTotalPrice(value)), '类'),
    },
    consumption: { count: outCount, reasons, top, losses: rows.losses },
    devices: {
      total: deviceTotal,
      out: deviceOut,
      inStock: deviceTotal - deviceOut,
      categories: topWithRest(deviceBars, OVERVIEW_TOP, (value) => `${value} 件`, '类'),
      warrantySoon,
      warrantyExpired,
      holders,
    },
  };
}

// ---------- 明细页 ----------

export type ReportDetailKind = 'products' | 'purchases' | 'consumption' | 'losses' | 'lowStock' | 'expiring' | 'expired' | 'devices';

export const DETAIL_TITLE: Record<ReportDetailKind, string> = {
  products: '物品明细',
  purchases: '进货明细',
  consumption: '消耗明细',
  losses: '损耗明细',
  lowStock: '库存不足',
  expiring: '快到期',
  expired: '已过期',
  devices: '设备明细',
};

export function isDetailKind(value: unknown): value is ReportDetailKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DETAIL_TITLE, value);
}

/** 按时间段统计的明细（标题下面写时间段）；其余是现在的情况 */
export function detailUsesPeriod(kind: ReportDetailKind): boolean {
  return kind === 'products' || kind === 'purchases' || kind === 'consumption' || kind === 'losses';
}

/** 明细里列的是物品（能按大类、分类筛）；设备明细按设备类别筛 */
export function detailListsProducts(kind: ReportDetailKind): boolean {
  return kind !== 'devices';
}

/** 一页多少条 */
export const DETAIL_PAGE_SIZE = 40;

export type DeviceStatusFilter = 'all' | 'out' | 'inStock' | 'warrantySoon' | 'warrantyExpired';

export const DEVICE_STATUS_OPTIONS: { value: DeviceStatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'out', label: '借出中' },
  { value: 'inStock', label: '在库' },
  { value: 'warrantySoon', label: '保修快到期' },
  { value: 'warrantyExpired', label: '已过保' },
];

/** 明细查询的条件：时间段、今天、到期前几天由首页带过来；stockKind、category、search 是明细页上的筛选 */
export type ReportDetailQuery = {
  kind: ReportDetailKind;
  officeId: number | null;
  startIso: string;
  endIso: string;
  today: string;
  leadDays: number;
  /** 大类（食品 / 日用品），null 是全部 */
  stockKind: StockKind | null;
  /** 物品的分类；设备明细是设备类别。null 是全部 */
  category: string | null;
  /** 按名称搜（设备还搜型号、序列号、使用人）：已去掉首尾空白、转成小写，空串是不搜 */
  search: string;
  deviceStatus: DeviceStatusFilter;
};

/** 搜索框里的字变成查询用的关键词 */
export function searchKeyword(text: string): string {
  return text.trim().toLowerCase();
}

/** 物品类明细的一行（库存、时间段内的进出都带上，各种明细按需要显示） */
export type ProductDetailItem = {
  type: 'product';
  productId: number;
  kind: StockKind;
  category: string | null;
  name: string;
  unit: string;
  totalQty: number;
  nearestExpiry: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  inQty: number;
  outQty: number;
  inCount: number;
  outCount: number;
  /** 时间段内填了总价的入库金额合计；一次都没填为 null */
  purchaseAmount: number | null;
};

export type LossDetailItem = {
  type: 'loss';
  movementId: number;
  productId: number;
  kind: StockKind;
  category: string | null;
  name: string;
  unit: string;
  note: string | null;
  /** 出库数量（正数） */
  quantity: number;
  happenedAt: string;
  price: PriceFields | null;
};

export type DeviceDetailItem = {
  type: 'device';
  deviceId: number;
  category: string;
  name: string;
  model: string | null;
  chip: string | null;
  memory: string | null;
  storage: string | null;
  quantity: number;
  outQty: number;
  /** 现在的使用人，用「、」连接 */
  holders: string | null;
  warrantyUntil: string | null;
};

export type ReportDetailItem = ProductDetailItem | LossDetailItem | DeviceDetailItem;

/** 一页明细：nextOffset 为 null 是没有下一页；total、categories 只有第一页带（条数、能选的分类） */
export type ReportDetailPage = { items: ReportDetailItem[]; nextOffset: number | null; total: number | null; categories: string[] | null };

/** 物品的分类选项：选了大类只列这个大类用到的，全部时两个大类的合在一起（同名的只列一次） */
export function detailCategoryOptions(stockKind: StockKind | null, rows: readonly { kind: StockKind; category: string | null }[]): string[] {
  const kinds: StockKind[] = stockKind ? [stockKind] : ['food', 'daily'];
  const options: string[] = [];
  for (const kind of kinds) {
    for (const category of usedCategories(
      kind,
      rows.filter((row) => row.kind === kind),
    )) {
      if (!options.includes(category)) options.push(category);
    }
  }
  return options;
}

/** 明细里一行显示什么：标题、下面一行小字、右边的数值和颜色、点了去哪 */
export type DetailRowView = {
  key: string;
  title: string;
  subtitle: string;
  value: string;
  tone: 'danger' | 'warn' | 'info' | null;
  productId: number | null;
  deviceId: number | null;
};

/** ISO 时刻按手机本地日期显示成「11月18日」 */
function localDay(iso: string): string {
  return formatShortDate(toDateStr(new Date(iso)));
}

function kindAndCategory(item: { kind: StockKind; category: string | null }): string {
  return item.category ? `${KIND_LABEL[item.kind]}·${item.category}` : KIND_LABEL[item.kind];
}

/**
 * 明细的一行。today、leadDays 用来写到期的说法（快到期、已过期）；lending 为 false 时（单机版家庭场景）设备不写借出。
 */
export function detailRowView(
  kind: ReportDetailKind,
  item: ReportDetailItem,
  today: string,
  leadDays: number,
  lending = true,
): DetailRowView {
  if (item.type === 'device') {
    const config = describeConfig(item);
    const out = Math.min(item.outQty, item.quantity);
    const parts = [item.category, [item.model, config].filter(Boolean).join(' '), `共 ${item.quantity} 件`];
    if (lending && out > 0) parts.push(`借出 ${out}`);
    if (item.holders) parts.push([...new Set(item.holders.split('、'))].join('、'));
    const warranty = warrantyStatus(item.warrantyUntil, today);
    const flagged = warranty && warranty.level !== 'ok';
    return {
      key: `d${item.deviceId}`,
      title: item.name,
      subtitle: parts.filter(Boolean).join(' · '),
      value: flagged ? warranty.text : lending ? `${item.quantity - out}/${item.quantity} 在库` : `${item.quantity} 件`,
      tone: flagged ? (warranty.level === 'expired' ? 'danger' : 'warn') : null,
      productId: null,
      deviceId: item.deviceId,
    };
  }
  if (item.type === 'loss') {
    const estimate = lossEstimate(item);
    return {
      key: `l${item.movementId}`,
      title: item.name,
      subtitle: `${localDay(item.happenedAt)} · ${reasonOf(item.note)} ${roundQty(item.quantity)} ${item.unit} · ${kindAndCategory(item)}`,
      value: estimate === null ? '—' : formatPrice(estimate),
      tone: null,
      productId: item.productId,
      deviceId: null,
    };
  }
  const base = { key: `p${item.productId}`, title: item.name, productId: item.productId, deviceId: null };
  const label = kindAndCategory(item);
  const current = `现有 ${roundQty(item.totalQty)} ${item.unit}`;
  if (kind === 'purchases') {
    return {
      ...base,
      subtitle: `${label} · 入库 ${item.inCount} 次，共 ${roundQty(item.inQty)} ${item.unit}`,
      value: item.purchaseAmount === null ? '—' : formatPrice(item.purchaseAmount),
      tone: null,
    };
  }
  if (kind === 'consumption') {
    return { ...base, subtitle: `${label} · 共 ${roundQty(item.outQty)} ${item.unit} · ${current}`, value: `${item.outCount} 次`, tone: null };
  }
  if (kind === 'lowStock') {
    return {
      ...base,
      subtitle: `${label} · 库存下限 ${roundQty(item.lowStockThreshold ?? 0)} ${item.unit}`,
      value: `剩 ${roundQty(item.totalQty)} ${item.unit}`,
      tone: 'warn',
    };
  }
  if (kind === 'expiring' || kind === 'expired') {
    const daysLeft = item.nearestExpiry ? diffDays(item.nearestExpiry, today) : 0;
    return {
      ...base,
      subtitle: `${label} · ${current} · ${formatShortDate(item.nearestExpiry)}到期`,
      value: describeDaysLeft(daysLeft),
      tone: daysLeft < 0 ? 'danger' : 'warn',
    };
  }
  return {
    ...base,
    subtitle: `${label} · 入 ${roundQty(item.inQty)} · 出 ${roundQty(item.outQty)} · ${current}`,
    value: item.purchaseAmount === null ? '—' : formatPrice(item.purchaseAmount),
    tone: null,
  };
}

