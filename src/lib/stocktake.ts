/**
 * 盘点的纯函数：差异怎么算、怎么分类统计、盘盈盘亏怎么落到批次上、导出表格。有单测。
 */
import { toCsv } from './csv';
import { planConsumption, roundQty, type BatchForConsume } from './stock';
import { currentTerms } from './terms';

export type StocktakeKind = 'food' | 'daily' | 'devices';
export type StocktakeStatus = 'open' | 'done' | 'cancelled';

export const STOCKTAKE_KINDS: StocktakeKind[] = ['food', 'daily', 'devices'];

export const STOCKTAKE_KIND_LABEL: Record<StocktakeKind, string> = {
  food: '食品',
  daily: '日用品',
  devices: '设备',
};

export const STOCKTAKE_STATUS_LABEL: Record<StocktakeStatus, string> = {
  open: '进行中',
  done: '已完成',
  cancelled: '已放弃',
};

export function isStocktakeKind(value: unknown): value is StocktakeKind {
  return value === 'food' || value === 'daily' || value === 'devices';
}

/** 存库用：按固定顺序、去重，逗号连接 */
export function serializeKinds(kinds: readonly StocktakeKind[]): string {
  return STOCKTAKE_KINDS.filter((kind) => kinds.includes(kind)).join(',');
}

export function parseKinds(text: string | null | undefined): StocktakeKind[] {
  const parts = (text ?? '').split(',').map((part) => part.trim());
  return STOCKTAKE_KINDS.filter((kind) => parts.includes(kind));
}

export function describeKinds(kinds: readonly StocktakeKind[]): string {
  return kinds.map((kind) => STOCKTAKE_KIND_LABEL[kind]).join('、');
}

/**
 * 盘点期间物品、设备的去向：null = 还在这次盘点的办公点和分类里；
 * deleted = 被删了；moved = 移到了别的办公点，或物品改成了不在这次盘点范围里的分类。
 * 不在的项完成时跳过，不调整。
 */
export type Absence = 'deleted' | 'moved' | null;

export function absenceLabel(absence: Exclude<Absence, null>): string {
  return absence === 'deleted' ? '已经删除，完成时跳过' : `已移到别的${currentTerms().place}或分类，完成时跳过`;
}

/** 每一项的盘点结果 */
export type CountState = 'uncounted' | 'match' | 'surplus' | 'deficit';

export type CountedValues = { expectedQty: number | null; countedQty: number | null };

/** 实盘 − 账面；还没盘时为 null */
export function countDifference(item: CountedValues): number | null {
  if (item.countedQty === null) return null;
  return roundQty(item.countedQty - (item.expectedQty ?? 0));
}

export function countState(item: CountedValues): CountState {
  const difference = countDifference(item);
  if (difference === null) return 'uncounted';
  if (difference > 0) return 'surplus';
  if (difference < 0) return 'deficit';
  return 'match';
}

export type CountSummary = Record<CountState, number> & { total: number; counted: number };

export function summarizeCounts(items: readonly CountedValues[]): CountSummary {
  const summary: CountSummary = { total: items.length, counted: 0, uncounted: 0, match: 0, surplus: 0, deficit: 0 };
  for (const item of items) {
    const state = countState(item);
    summary[state] += 1;
    if (state !== 'uncounted') summary.counted += 1;
  }
  return summary;
}

export type FinishPreview = {
  surplus: number;
  deficit: number;
  match: number;
  uncounted: number;
  /** 已删除或移走的项（不管盘没盘），完成时不调整 */
  absent: number;
  /** 有差异的设备（只记录，不改数量） */
  deviceDifferences: number;
};

/** 「完成盘点」确认框里的计数：已删除、移走的单独算，不计入盘盈盘亏和设备差异 */
export function previewFinish(
  items: readonly (CountedValues & { itemType: 'product' | 'device'; absence: Absence })[],
): FinishPreview {
  const preview: FinishPreview = { surplus: 0, deficit: 0, match: 0, uncounted: 0, absent: 0, deviceDifferences: 0 };
  for (const item of items) {
    if (item.absence) {
      preview.absent += 1;
      continue;
    }
    const state = countState(item);
    preview[state] += 1;
    if (item.itemType === 'device' && (state === 'surplus' || state === 'deficit')) preview.deviceDifferences += 1;
  }
  return preview;
}

/** 列表上的差异标签文字：盘盈 +2 瓶 / 盘亏 -1 瓶 / 相符 / 未盘 */
export function describeDifference(item: CountedValues, unit: string): string {
  const difference = countDifference(item);
  if (difference === null) return '未盘';
  if (difference === 0) return '相符';
  return difference > 0 ? `盘盈 +${difference} ${unit}` : `盘亏 ${difference} ${unit}`;
}

/** 盘点单上的筛选 */
export type ItemFilter = 'all' | 'uncounted' | 'different';

export function matchesFilter(item: CountedValues, filter: ItemFilter): boolean {
  const state = countState(item);
  if (filter === 'uncounted') return state === 'uncounted';
  if (filter === 'different') return state === 'surplus' || state === 'deficit';
  return true;
}

export function matchesKeyword(item: { name: string; code: string | null }, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return item.name.toLowerCase().includes(needle) || (item.code ?? '').toLowerCase().includes(needle);
}

/**
 * 完成盘点时一项物品的差异怎么落到批次上：
 * - 盘亏：和出库一样，先扣最早到期的批次；现在的库存不够扣时只扣到 0
 * - 盘盈：加到最早到期的那一批（宁可早一点提醒去看）；没有批次就新建一个不记过期日期的批次
 * 返回要改的批次数量、要不要新建批次、实际调整了多少（盘亏为负）。
 */
export type AdjustmentPlan = {
  updates: { id: number; quantity: number }[];
  /** 需要新建的批次数量；不需要时为 0 */
  newBatchQty: number;
  /** 加到哪一批（用来记出入库记录上的过期日期）；扣减或新建时为 null */
  targetExpiry: string | null;
  applied: number;
};

export function planAdjustment(batches: readonly BatchForConsume[], difference: number): AdjustmentPlan {
  const delta = roundQty(difference);
  if (delta < 0) {
    const consumption = planConsumption([...batches], -delta);
    return { updates: consumption.updates, newBatchQty: 0, targetExpiry: null, applied: roundQty(-consumption.consumed) };
  }
  if (delta > 0) {
    // 用出库的顺序找「最早到期」的那一批：planConsumption 扣 0 时不返回批次，所以这里自己排一次
    const target = [...batches]
      .filter((batch) => batch.quantity > 0)
      .sort((left, right) => {
        if (left.expiryDate && right.expiryDate && left.expiryDate !== right.expiryDate) {
          return left.expiryDate < right.expiryDate ? -1 : 1;
        }
        if (left.expiryDate && !right.expiryDate) return -1;
        if (!left.expiryDate && right.expiryDate) return 1;
        return left.id - right.id;
      })[0];
    if (!target) return { updates: [], newBatchQty: delta, targetExpiry: null, applied: delta };
    return {
      updates: [{ id: target.id, quantity: roundQty(target.quantity + delta) }],
      newBatchQty: 0,
      targetExpiry: target.expiryDate,
      applied: delta,
    };
  }
  return { updates: [], newBatchQty: 0, targetExpiry: null, applied: 0 };
}

/** 出入库记录里的备注 */
export function adjustmentNote(expectedQty: number, countedQty: number, applied: number): string {
  const base = `盘点：账面 ${roundQty(expectedQty)}，实盘 ${roundQty(countedQty)}`;
  const wanted = roundQty(countedQty - expectedQty);
  // 清点之后又出库了，现在的库存不够扣
  return wanted < 0 && applied > wanted ? `${base}（库存只够扣 ${-applied}）` : base;
}

export type CsvItem = CountedValues & {
  kind: StocktakeKind;
  name: string;
  unit: string;
  adjustedQty: number | null;
  itemType: 'product' | 'device';
};

/** 盘点表「是否已调整库存」一列 */
export function describeAdjustment(item: CsvItem, status: StocktakeStatus): string {
  const state = countState(item);
  if (status !== 'done' || state === 'uncounted') return '否';
  if (state === 'match') return '不需要';
  if (item.itemType === 'device') return '否（设备要手动处理）';
  // 完成时物品已删除或移走，跳过了，adjusted_qty 没写
  if (item.adjustedQty === null) return '否（物品已删除或移走）';
  if (item.adjustedQty === 0) return '否（库存已经是 0，没法再扣）';
  return `是（${item.adjustedQty > 0 ? '+' : ''}${roundQty(item.adjustedQty)}）`;
}

const STATE_LABEL: Record<CountState, string> = {
  uncounted: '未盘',
  match: '相符',
  surplus: '盘盈',
  deficit: '盘亏',
};

/** 导出盘点明细，给 Excel 打开 */
export function buildStocktakeCsv(items: readonly CsvItem[], status: StocktakeStatus): string {
  const rows = items.map((item) => {
    const state = countState(item);
    return [
      STOCKTAKE_KIND_LABEL[item.kind],
      item.name,
      item.unit,
      state === 'uncounted' ? null : item.expectedQty,
      item.countedQty,
      countDifference(item),
      STATE_LABEL[state],
      describeAdjustment(item, status),
    ];
  });
  return toCsv(['分类', '名称', '单位', '账面数量', '实盘数量', '差异', '结果', '是否已调整库存'], rows);
}

export type OpenStocktakeScope = { officeName: string | null; kinds: readonly StocktakeKind[] };

/**
 * 导入会清掉哪些办公点进行中的盘点：规则和导入（replaceData）一致——
 * 被替换的办公点里，盘点范围和导入的分类有交集的，就会被删（物品、设备重建后 id 对不上了）。
 * 返回办公点名称。
 */
export function stocktakesClearedByImport(
  open: readonly OpenStocktakeScope[],
  choice: { offices: readonly string[]; scope: readonly string[] },
): string[] {
  const replacedKinds = STOCKTAKE_KINDS.filter((kind) => choice.scope.includes(kind));
  if (!replacedKinds.length) return [];
  const names = open.flatMap((stocktake) =>
    stocktake.officeName !== null &&
    choice.offices.includes(stocktake.officeName) &&
    stocktake.kinds.some((kind) => replacedKinds.includes(kind))
      ? [stocktake.officeName]
      : [],
  );
  return [...new Set(names)];
}
