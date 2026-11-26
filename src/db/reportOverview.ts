import type { SQLiteDatabase } from 'expo-sqlite';

import { compareZh } from '../lib/collate';
import { roundTotalPrice } from '../lib/price';
import {
  CONSUMER_CANDIDATES,
  detailCategoryOptions,
  summarizeLossRows,
  type ConsumerRow,
  type DeviceCategoryRow,
  type DeviceDetailItem,
  type HolderRow,
  type InventoryRow,
  type LossDetailItem,
  type LossRow,
  type OutNoteRow,
  type OverviewRows,
  type ProductDetailItem,
  type PurchaseRow,
  type ReportBucket,
  type ReportDetailPage,
  type ReportDetailQuery,
} from '../lib/reportOverview';
import { roundQty, type StockKind } from '../lib/stock';
import { WARRANTY_SOON_DAYS } from '../lib/warranty';

/**
 * 报表首页、明细页读本机库（手机）：首页只用 GROUP BY 算出数字（不把几万条出入库记录读进 JS），明细一页一页查。
 * 整理成显示的样子在 lib/reportOverview.ts（单机版、联网版同一份）。
 * 导出表格要逐条数据，照旧用 db/report.ts 的 loadReportSource（点导出时才读）。
 */

type Params = (string | number | null)[];

/** 算进货、消耗的出入库记录：单机版没有调拨、冲正，出入库记录都算（同 lib/report.ts） */
function counted(_alias: string): string {
  return '1 = 1';
}

/** 填了价的入库（估算损失找进价用；同 loadReportSource 读 priceHistory 的条件） */
function pricedIn(alias: string): string {
  return `${alias}.type = 'in' AND ${alias}.delta > 0 AND (${alias}.unit_price IS NOT NULL OR ${alias}.total_price IS NOT NULL)`;
}

/** 损耗：原因（备注去掉首尾空白）是过期丢弃、坏了 */
const LOSS_NOTE = `TRIM(m.note, ' ' || char(9) || char(10) || char(13) || char(12288)) IN ('过期丢弃', '坏了')`;

/** 有库存的批次按物品合计：数量、最早的过期日期（同 listProducts） */
const BATCH_TOTALS = `SELECT product_id, SUM(quantity) AS total_qty, MIN(expiry_date) AS nearest_expiry
                        FROM stock_batch WHERE quantity > 0 GROUP BY product_id`;

/** 办公点条件：选了才加（写成「? IS NULL OR」会让 SQLite 用不上办公点的索引） */
function officeWhere(column: string, officeId: number | null, params: Params): string {
  if (officeId === null) return '';
  params.push(officeId);
  return ` AND ${column} = ?`;
}

/** 时间段内、物品在这个办公点的出入库（FROM 和 WHERE 的开头；后面接 AND …） */
function movementsIn(officeId: number | null, period: { startIso: string; endIso: string }, params: Params): string {
  params.push(period.startIso, period.endIso);
  return `FROM stock_movement m JOIN stock_product p ON p.id = m.product_id
          WHERE m.happened_at >= ? AND m.happened_at < ?${officeWhere('p.office_id', officeId, params)}`;
}

/** 第几根柱子：按各根的终点依次比（buckets 首尾相接，第一根的起点就是时间段的起点） */
function bucketCase(buckets: readonly ReportBucket[], params: Params): string {
  if (!buckets.length) return '0';
  const whens = buckets.map((bucket, index) => {
    params.push(bucket.endIso, index);
    return 'WHEN m.happened_at < ? THEN ?';
  });
  return `CASE ${whens.join(' ')} ELSE ${buckets.length - 1} END`;
}

/**
 * 首页要的聚合：库存概况、进货（按大类 × 分类 × 柱子）、出库原因、出库多的物品、损耗合计、设备按类别、领用按人。
 * officeId 为 null 是全部办公点；today 是本地日期（yyyy-MM-dd），leadDays 是设置里的到期前几天。
 */
export async function loadOverviewRows(
  db: SQLiteDatabase,
  officeId: number | null,
  period: { startIso: string; endIso: string },
  buckets: readonly ReportBucket[],
  today: string,
  leadDays: number,
): Promise<OverviewRows> {
  const inventoryParams: Params = [today, today, today, leadDays];
  const inventorySql = `
    SELECT p.kind AS kind, COUNT(*) AS products,
           SUM(p.low_stock_threshold IS NOT NULL AND COALESCE(b.total_qty, 0) <= p.low_stock_threshold) AS lowStock,
           SUM(b.nearest_expiry IS NOT NULL AND b.nearest_expiry < ?) AS expired,
           SUM(b.nearest_expiry IS NOT NULL AND b.nearest_expiry >= ?
               AND julianday(b.nearest_expiry) - julianday(?) <= COALESCE(p.expiry_lead_days, ?)) AS expiring
      FROM stock_product p LEFT JOIN (${BATCH_TOTALS}) b ON b.product_id = p.id
     WHERE 1 = 1${officeWhere('p.office_id', officeId, inventoryParams)}
     GROUP BY p.kind`;

  const purchaseParams: Params = [];
  const bucket = bucketCase(buckets, purchaseParams);
  const purchaseSql = `
    SELECT p.kind AS kind, p.category AS category, ${bucket} AS bucket, COUNT(*) AS count,
           SUM(m.total_price IS NULL) AS unpriced, SUM(m.total_price) AS amount
      ${movementsIn(officeId, period, purchaseParams)}
       AND m.type = 'in' AND m.delta > 0 AND ${counted('m')}
     GROUP BY p.kind, p.category, bucket`;

  const noteParams: Params = [];
  const noteSql = `
    SELECT m.note AS note, COUNT(*) AS count
      ${movementsIn(officeId, period, noteParams)}
       AND m.type = 'out' AND m.delta < 0 AND ${counted('m')}
     GROUP BY m.note`;

  const consumerParams: Params = [];
  const consumerSql = `
    SELECT m.product_id AS productId, p.name AS name, p.kind AS kind, p.unit AS unit, COUNT(*) AS count, -SUM(m.delta) AS quantity
      ${movementsIn(officeId, period, consumerParams)}
       AND m.type = 'out' AND m.delta < 0 AND ${counted('m')}
     GROUP BY m.product_id
     ORDER BY count DESC, quantity DESC
     LIMIT ${CONSUMER_CANDIDATES}`;

  const lossParams: Params = [];
  const lossSql = lossRowsSql(officeId, period, lossParams, '', '');

  const deviceParams: Params = [today, today, WARRANTY_SOON_DAYS, today];
  const deviceSql = `
    SELECT d.category AS category, SUM(d.quantity) AS quantity, SUM(MIN(COALESCE(a.out_qty, 0), d.quantity)) AS out,
           SUM(CASE WHEN d.warranty_until >= ? AND julianday(d.warranty_until) - julianday(?) <= ? THEN d.quantity ELSE 0 END) AS warrantySoon,
           SUM(CASE WHEN d.warranty_until < ? THEN d.quantity ELSE 0 END) AS warrantyExpired
      FROM device d
      LEFT JOIN (SELECT device_id, SUM(quantity) AS out_qty FROM device_assignment WHERE returned_on IS NULL GROUP BY device_id) a
        ON a.device_id = d.id
     WHERE 1 = 1${officeWhere('d.office_id', officeId, deviceParams)}
     GROUP BY d.category`;

  const holderParams: Params = [];
  const holderSql = `
    SELECT a.person AS person, NULL AS personUid, NULL AS departmentUid, SUM(a.quantity) AS quantity
      FROM device_assignment a JOIN device d ON d.id = a.device_id
     WHERE a.returned_on IS NULL${officeWhere('d.office_id', officeId, holderParams)}
     GROUP BY a.person`;

  const [inventory, purchases, outNotes, consumers, lossRows, devices, holders] = await Promise.all([
    db.getAllAsync<InventoryRow>(inventorySql, inventoryParams),
    db.getAllAsync<PurchaseRow>(purchaseSql, purchaseParams),
    db.getAllAsync<OutNoteRow>(noteSql, noteParams),
    db.getAllAsync<ConsumerRow>(consumerSql, consumerParams),
    db.getAllAsync<LossQueryRow>(lossSql, lossParams),
    db.getAllAsync<DeviceCategoryRow>(deviceSql, deviceParams),
    db.getAllAsync<HolderRow>(holderSql, holderParams),
  ]);
  return {
    inventory,
    purchases,
    outNotes,
    consumers,
    losses: summarizeLossRows(lossRows.map(lossRowOf)),
    devices,
    holders,
  };
}

type LossQueryRow = {
  movementId: number;
  productId: number;
  kind: StockKind;
  category: string | null;
  name: string;
  unit: string;
  note: string | null;
  quantity: number;
  happenedAt: string;
  priceDelta: number | null;
  priceInputQty: number | null;
  priceUnit: number | null;
  priceTotal: number | null;
};

function lossRowOf(row: LossQueryRow): LossRow & LossDetailItem {
  return {
    type: 'loss',
    movementId: row.movementId,
    productId: row.productId,
    kind: row.kind,
    category: row.category,
    name: row.name,
    unit: row.unit,
    note: row.note,
    quantity: row.quantity,
    happenedAt: row.happenedAt,
    price:
      row.priceDelta === null
        ? null
        : { delta: row.priceDelta, inputQty: row.priceInputQty, unitPrice: row.priceUnit, totalPrice: row.priceTotal },
  };
}

/**
 * 时间段内的损耗（过期丢弃、坏了），新的在前，各带出库前最近一次的进价（同一时刻有几条取后记的）：
 * 进价按 (product_id, happened_at) 索引从出库时刻往前倒着找，找到一条就停。指定用这个索引（INDEXED BY）：库里没有统计信息时，
 * SQLite 会改用 (type, happened_at) 索引，每条损耗都把出库时刻之前的全部入库扫一遍（模拟器上 4 万条、今年：2.6–4.4 秒，指定后 16 毫秒）。
 * extraWhere 是明细页的筛选，tail 是 LIMIT / OFFSET
 */
function lossRowsSql(officeId: number | null, period: { startIso: string; endIso: string }, params: Params, extraWhere: string, tail: string): string {
  return `
    SELECT l.id AS movementId, l.product_id AS productId, l.kind AS kind, l.category AS category, l.name AS name, l.unit AS unit,
           l.note AS note, -l.delta AS quantity, l.happened_at AS happenedAt,
           pr.delta AS priceDelta, pr.input_qty AS priceInputQty, pr.unit_price AS priceUnit, pr.total_price AS priceTotal
      FROM (SELECT m.id, m.product_id, p.kind, p.category, p.name, p.unit, m.note, m.delta, m.happened_at,
                   (SELECT b.id FROM stock_movement b INDEXED BY ix_stock_movement_product
                     WHERE b.product_id = m.product_id AND b.happened_at <= m.happened_at AND ${pricedIn('b')}
                     ORDER BY b.happened_at DESC, b.id DESC LIMIT 1) AS price_id
              ${movementsIn(officeId, period, params)}
               AND m.type = 'out' AND m.delta < 0 AND ${counted('m')} AND ${LOSS_NOTE}${extraWhere}
             ORDER BY m.happened_at DESC, m.id DESC${tail}) l
      LEFT JOIN stock_movement pr ON pr.id = l.price_id
     ORDER BY l.happened_at DESC, l.id DESC`;
}

// ---------- 明细 ----------

/** 物品的筛选：大类、分类、名称关键字 */
function productFilter(query: ReportDetailQuery, params: Params): string {
  let where = officeWhere('p.office_id', query.officeId, params);
  if (query.stockKind) {
    where += ' AND p.kind = ?';
    params.push(query.stockKind);
  }
  if (query.category) {
    where += ' AND p.category = ?';
    params.push(query.category);
  }
  if (query.search) {
    where += ' AND instr(lower(p.name), ?) > 0';
    params.push(query.search);
  }
  return where;
}

/** 这几样物品的库存、时间段内的进出（物品明细、进货明细、消耗明细、名单共用），按 ids 的顺序 */
async function productItems(db: SQLiteDatabase, ids: readonly number[], query: ReportDetailQuery): Promise<ProductDetailItem[]> {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(', ');
  const rows = await db.getAllAsync<Omit<ProductDetailItem, 'type'>>(
    `SELECT p.id AS productId, p.kind AS kind, p.category AS category, p.name AS name, p.unit AS unit,
            p.low_stock_threshold AS lowStockThreshold, p.expiry_lead_days AS expiryLeadDays,
            COALESCE(b.total_qty, 0) AS totalQty, b.nearest_expiry AS nearestExpiry,
            COALESCE(mv.in_qty, 0) AS inQty, COALESCE(mv.out_qty, 0) AS outQty,
            COALESCE(mv.in_count, 0) AS inCount, COALESCE(mv.out_count, 0) AS outCount, mv.amount AS purchaseAmount
       FROM stock_product p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS total_qty, MIN(expiry_date) AS nearest_expiry
                    FROM stock_batch WHERE quantity > 0 AND product_id IN (${marks}) GROUP BY product_id) b ON b.product_id = p.id
       LEFT JOIN (SELECT m.product_id,
                         SUM(CASE WHEN m.type = 'in' AND m.delta > 0 THEN m.delta ELSE 0 END) AS in_qty,
                         SUM(CASE WHEN m.type = 'out' AND m.delta < 0 THEN -m.delta ELSE 0 END) AS out_qty,
                         SUM(m.type = 'in' AND m.delta > 0) AS in_count,
                         SUM(m.type = 'out' AND m.delta < 0) AS out_count,
                         SUM(CASE WHEN m.type = 'in' AND m.delta > 0 THEN m.total_price END) AS amount
                    FROM stock_movement m
                   WHERE m.product_id IN (${marks}) AND m.happened_at >= ? AND m.happened_at < ? AND ${counted('m')}
                   GROUP BY m.product_id) mv ON mv.product_id = p.id
      WHERE p.id IN (${marks})`,
    [...ids, ...ids, query.startIso, query.endIso, ...ids],
  );
  const byId = new Map(rows.map((row) => [row.productId, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    // 合计按 lib/report.ts 的 productDetails 一样保留小数（浮点相加的尾数去掉）
    return row
      ? [
          {
            type: 'product' as const,
            ...row,
            totalQty: roundQty(row.totalQty),
            inQty: roundQty(row.inQty),
            outQty: roundQty(row.outQty),
            purchaseAmount: row.purchaseAmount === null ? null : roundTotalPrice(row.purchaseAmount),
          },
        ]
      : [];
  });
}

/** 按名称（中文拼音）排的明细：先取出符合条件的编号和名称排好（几千样也只是几毫秒），再查这一页的数 */
async function nameSortedIds(db: SQLiteDatabase, query: ReportDetailQuery): Promise<number[]> {
  const params: Params = [];
  const lowStock =
    query.kind === 'lowStock'
      ? ` AND p.low_stock_threshold IS NOT NULL
          AND COALESCE((SELECT SUM(quantity) FROM stock_batch WHERE product_id = p.id AND quantity > 0), 0) <= p.low_stock_threshold`
      : '';
  const rows = await db.getAllAsync<{ id: number; kind: StockKind; name: string }>(
    `SELECT p.id, p.kind, p.name FROM stock_product p WHERE 1 = 1${productFilter(query, params)}${lowStock}`,
    params,
  );
  const kindOrder: Record<StockKind, number> = { food: 0, daily: 1 };
  // 物品明细同原来：食品在前、日用品在后，各自按名称；库存不足只按名称
  const byKind = query.kind === 'products';
  rows.sort(
    (left, right) =>
      (byKind ? kindOrder[left.kind] - kindOrder[right.kind] : 0) || compareZh(left.name, right.name) || left.id - right.id,
  );
  return rows.map((row) => row.id);
}

/** 在 SQL 里排好、按页取的物品明细：进货（金额高的在前）、消耗（出库次数多的在前）、快到期 / 已过期（先到期的在前） */
function orderedIdsSql(query: ReportDetailQuery, params: Params): string {
  if (query.kind === 'purchases' || query.kind === 'consumption') {
    params.push(query.startIso, query.endIso);
    const filter = productFilter(query, params);
    const purchases = query.kind === 'purchases';
    return `SELECT m.product_id AS id
              FROM stock_movement m JOIN stock_product p ON p.id = m.product_id
             WHERE m.happened_at >= ? AND m.happened_at < ?${filter}
               AND ${purchases ? "m.type = 'in' AND m.delta > 0" : "m.type = 'out' AND m.delta < 0"} AND ${counted('m')}
             GROUP BY m.product_id
             ORDER BY ${purchases ? 'COALESCE(SUM(m.total_price), -1) DESC, COUNT(*) DESC' : 'COUNT(*) DESC, -SUM(m.delta) DESC'}, m.product_id`;
  }
  // 快到期、已过期（同 lib/status 的 expiryStatus：剩下的天数 < 0 是已过期，≤ 到期前几天是快到期）
  params.push(query.today);
  const condition =
    query.kind === 'expired'
      ? 'b.nearest_expiry < ?'
      : 'b.nearest_expiry >= ? AND julianday(b.nearest_expiry) - julianday(?) <= COALESCE(p.expiry_lead_days, ?)';
  if (query.kind !== 'expired') params.push(query.today, query.leadDays);
  const filter = productFilter(query, params);
  return `SELECT p.id AS id FROM stock_product p JOIN (${BATCH_TOTALS}) b ON b.product_id = p.id
           WHERE b.nearest_expiry IS NOT NULL AND ${condition}${filter}
           ORDER BY b.nearest_expiry, p.id`;
}

const DEVICE_STATUS_WHERE: Record<ReportDetailQuery['deviceStatus'], string> = {
  all: '',
  out: ' AND COALESCE(a.out_qty, 0) > 0',
  inStock: ' AND d.quantity > COALESCE(a.out_qty, 0)',
  warrantySoon: ` AND d.warranty_until >= :today AND julianday(d.warranty_until) - julianday(:today) <= ${WARRANTY_SOON_DAYS}`,
  warrantyExpired: ' AND d.warranty_until < :today',
};

async function devicePage(db: SQLiteDatabase, query: ReportDetailQuery, offset: number, limit: number): Promise<ReportDetailPage> {
  const params: Params = [];
  let where = officeWhere('d.office_id', query.officeId, params);
  if (query.category) {
    where += ' AND d.category = ?';
    params.push(query.category);
  }
  if (query.search) {
    where += ` AND (instr(lower(d.name || ' ' || COALESCE(d.model, '') || ' ' || COALESCE(d.serial_no, '')), ?) > 0
                    OR instr(lower(COALESCE(a.holders, '')), ?) > 0)`;
    params.push(query.search, query.search);
  }
  const status = DEVICE_STATUS_WHERE[query.deviceStatus];
  where += status.replaceAll(':today', '?');
  for (let index = 0; index < (status.match(/:today/g)?.length ?? 0); index++) params.push(query.today);
  const from = `FROM device d
     LEFT JOIN (SELECT device_id, SUM(quantity) AS out_qty, GROUP_CONCAT(person, '、') AS holders
                  FROM device_assignment WHERE returned_on IS NULL GROUP BY device_id) a ON a.device_id = d.id
    WHERE 1 = 1${where}`;
  const rows = await db.getAllAsync<Omit<DeviceDetailItem, 'type'>>(
    `SELECT d.id AS deviceId, d.category AS category, d.name AS name, d.model AS model, d.chip AS chip, d.memory AS memory,
            d.storage AS storage, d.quantity AS quantity, COALESCE(a.out_qty, 0) AS outQty, a.holders AS holders,
            d.warranty_until AS warrantyUntil
       ${from}
      ORDER BY d.category, d.name COLLATE NOCASE, d.id
      LIMIT ? OFFSET ?`,
    [...params, limit + 1, offset],
  );
  let total: number | null = null;
  let categories: string[] | null = null;
  if (offset === 0) {
    const categoryParams: Params = [];
    const [count, used] = await Promise.all([
      db.getFirstAsync<{ total: number }>(`SELECT COUNT(*) AS total ${from}`, params),
      db.getAllAsync<{ category: string }>(
        `SELECT DISTINCT category FROM device d WHERE 1 = 1${officeWhere('d.office_id', query.officeId, categoryParams)}`,
        categoryParams,
      ),
    ]);
    total = count?.total ?? 0;
    categories = used.map((row) => row.category).sort(compareZh);
  }
  return {
    items: rows.slice(0, limit).map((row) => ({ type: 'device', ...row })),
    nextOffset: rows.length > limit ? offset + limit : null,
    total,
    categories,
  };
}

/** 物品的分类选项（第一页带）：这个办公点里用到的分类 */
async function productCategories(db: SQLiteDatabase, query: ReportDetailQuery): Promise<string[]> {
  const params: Params = [];
  const rows = await db.getAllAsync<{ kind: StockKind; category: string | null }>(
    `SELECT DISTINCT p.kind AS kind, p.category AS category FROM stock_product p
      WHERE p.category IS NOT NULL${officeWhere('p.office_id', query.officeId, params)}`,
    params,
  );
  return detailCategoryOptions(query.stockKind, rows);
}

/** 明细的一页：offset 从 0 起，limit 条；第一页另带条数和分类选项 */
export async function loadDetailPage(
  db: SQLiteDatabase,
  query: ReportDetailQuery,
  offset: number,
  limit: number,
): Promise<ReportDetailPage> {
  if (query.kind === 'devices') return devicePage(db, query, offset, limit);
  const first = offset === 0;
  const categories = first ? productCategories(db, query) : Promise.resolve(null);
  if (query.kind === 'losses') {
    const params: Params = [];
    const filterParams: Params = [];
    const filter = productFilter({ ...query, officeId: null }, filterParams);
    const sql = lossRowsSql(query.officeId, query, params, filter, ' LIMIT ? OFFSET ?');
    const rows = await db.getAllAsync<LossQueryRow>(sql, [...params, ...filterParams, limit + 1, offset]);
    let total: number | null = null;
    if (first) {
      const countParams: Params = [];
      const count = await db.getFirstAsync<{ total: number }>(
        `SELECT COUNT(*) AS total ${movementsIn(query.officeId, query, countParams)}
            AND m.type = 'out' AND m.delta < 0 AND ${counted('m')} AND ${LOSS_NOTE}${filter}`,
        [...countParams, ...filterParams],
      );
      total = count?.total ?? 0;
    }
    return {
      items: rows.slice(0, limit).map(lossRowOf),
      nextOffset: rows.length > limit ? offset + limit : null,
      total,
      categories: await categories,
    };
  }
  if (query.kind === 'products' || query.kind === 'lowStock') {
    const ids = await nameSortedIds(db, query);
    const page = ids.slice(offset, offset + limit);
    return {
      items: await productItems(db, page, query),
      nextOffset: offset + limit < ids.length ? offset + limit : null,
      total: first ? ids.length : null,
      categories: await categories,
    };
  }
  const params: Params = [];
  const sql = orderedIdsSql(query, params);
  const rows = await db.getAllAsync<{ id: number }>(`${sql} LIMIT ? OFFSET ?`, [...params, limit + 1, offset]);
  let total: number | null = null;
  if (first) {
    const count = await db.getFirstAsync<{ total: number }>(`SELECT COUNT(*) AS total FROM (${sql})`, params);
    total = count?.total ?? 0;
  }
  const ids = rows.slice(0, limit).map((row) => row.id);
  return {
    items: await productItems(db, ids, query),
    nextOffset: rows.length > limit ? offset + limit : null,
    total,
    categories: await categories,
  };
}
