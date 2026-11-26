/**
 * 报表首页（GROUP BY 聚合）和明细页（按页查）：
 * - 时间分桶：按周（周一到周日，月初月末不满一周的单独一根）、按月，首尾和 periodRange 对上，起点算这一根；
 * - 随机造一批数据（同一时刻的进价、备注带空格、没价格的入库……；联网版的表才有的调拨、冲正列这里插不进去，当普通出入库），各办公点、各时间段比对：
 *   聚合出来的数字和原来逐条算的（lib/report.ts）一样；
 * - 明细按页取（每页故意取得很小）：不重不漏、条数对；大类、分类、搜索筛选；顺序和原来的一致。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SQLiteDatabase } from 'expo-sqlite';

import { loadReportSource } from '../src/db/report';
import { loadDetailPage, loadOverviewRows } from '../src/db/reportOverview';
import { compareZh } from '../src/lib/collate';
import { toDateStr } from '../src/lib/dates';
import {
  periodRange,
  productDetails,
  summarizeConsumption,
  summarizeDevices,
  summarizeInventory,
  summarizePurchases,
  type ReportPeriodKey,
} from '../src/lib/report';
import {
  buildOverview,
  bucketEdges,
  detailRowView,
  lossEstimate,
  periodBuckets,
  type LossDetailItem,
  type ProductDetailItem,
  type ReportDetailItem,
  type ReportDetailKind,
  type ReportDetailQuery,
} from '../src/lib/reportOverview';
import type { StockKind } from '../src/lib/stock';
import { openDb } from './helpers/memoryDb';

/** 固定种子的伪随机数，失败时能复现 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('报表时间分桶', () => {
  const labels = (key: ReportPeriodKey, now: Date) => periodBuckets(key, now).map((bucket) => bucket.label);

  it('本月按周：周一到周日，月初、月末不满一周的单独一根', () => {
    // 2026 年 11 月 1 日是周日，30 日是周一
    assert.deepEqual(labels('thisMonth', new Date(2026, 10, 18)), ['1日', '2–8日', '9–15日', '16–22日', '23–29日', '30日']);
    // 2026 年 6 月 1 日是周一
    assert.deepEqual(labels('thisMonth', new Date(2026, 5, 3)), ['1–7日', '8–14日', '15–21日', '22–28日', '29–30日']);
    // 2027 年 2 月 1 日是周一，28 天正好四周
    assert.deepEqual(labels('thisMonth', new Date(2027, 1, 10)), ['1–7日', '8–14日', '15–21日', '22–28日']);
  });

  it('上月、近 3 个月、今年跨年也对；首尾和 periodRange 一样，一根接一根', () => {
    const january = new Date(2027, 0, 5);
    // 2026 年 12 月 1 日是周二
    assert.deepEqual(labels('lastMonth', january), ['1–6日', '7–13日', '14–20日', '21–27日', '28–31日']);
    assert.deepEqual(labels('last3Months', january), ['11月', '12月', '1月']);
    assert.equal(labels('thisYear', january).length, 12);
    for (const key of ['thisMonth', 'lastMonth', 'last3Months', 'thisYear'] as const) {
      for (const now of [january, new Date(2026, 10, 18), new Date(2026, 2, 31, 23, 59)]) {
        const buckets = periodBuckets(key, now);
        const period = periodRange(key, now);
        assert.equal(buckets[0].startIso, period.startIso, key);
        assert.equal(buckets[buckets.length - 1].endIso, period.endIso, key);
        buckets.slice(1).forEach((bucket, index) => assert.equal(bucket.startIso, buckets[index].endIso));
        assert.deepEqual(bucketEdges(buckets), [buckets[0].startIso, ...buckets.map((bucket) => bucket.endIso)]);
      }
    }
  });

  it('正好落在两根柱子交界的记录算后一根（起点含、终点不含）', async () => {
    const db = await openDb();
    const now = new Date(2026, 10, 18);
    const buckets = periodBuckets('thisMonth', now);
    await db.runAsync(
      `INSERT INTO stock_product (id, kind, name, unit, created_at, updated_at, office_id) VALUES (1, 'food', '可乐', '瓶', ?, ?, 1)`,
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    for (const [happenedAt, price] of [
      [buckets[1].startIso, 10],
      [buckets[2].startIso, 20],
      [new Date(Date.parse(buckets[2].startIso) - 1).toISOString(), 5],
    ] as const) {
      await db.runAsync(
        `INSERT INTO stock_movement (product_id, type, delta, happened_at, total_price) VALUES (1, 'in', 1, ?, ?)`,
        [happenedAt, price],
      );
    }
    const rows = await loadOverviewRows(db, null, periodRange('thisMonth', now), buckets, toDateStr(now), 7);
    const overview = buildOverview(rows, buckets.map((bucket) => bucket.label));
    assert.deepEqual(
      overview.purchases.columns.map((column) => column.value),
      [0, 15, 20, 0, 0, 0],
    );
  });
});

// ---------- 随机数据 ----------

const NOW = new Date(2026, 10, 18, 15, 30);
const TODAY = toDateStr(NOW);
const LEAD_DAYS = 7;

const NAMES = ['可乐', '雪碧', '牛奶', '面包', 'Apple 汁', 'apple 片', '纸巾', '洗手液', '电池', '咖啡', '茶叶', '大米', '酱油', '饼干'];
const CATEGORIES: Record<StockKind, (string | null)[]> = {
  food: ['饮料冲调', '乳品', '零食', '其他', null],
  daily: ['纸品', '清洁用品', '其他', null],
};

async function columnsOf(db: SQLiteDatabase, table: string): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

/** 只插表里有的列（单机版的表没有单据、冲正、编号这些列） */
async function insert(db: SQLiteDatabase, table: string, row: Record<string, unknown>): Promise<number> {
  const columns = await columnsOf(db, table);
  const keys = Object.keys(row).filter((key) => columns.has(key));
  const result = await db.runAsync(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((key) => row[key]) as (string | number | null)[],
  );
  return result.lastInsertRowId;
}

async function randomDb(seed: number): Promise<SQLiteDatabase> {
  const db = await openDb();
  const random = seeded(seed);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  let serial = 0;
  const uid = () => `uid-${seed}-${++serial}`;
  await db.runAsync(`INSERT INTO office (id, name, sort, created_at) VALUES (2, '上海', 1, '2026-01-01T00:00:00.000Z')`);
  // 时间只取少数几个值：同一时刻的进价、出库和进价同一时刻都会出现；跨 8 月到 12 月，四个时间段都有数
  const day = () => new Date(2026, between(7, 11), pick([1, 2, 8, 15, 16, 30, 31]), pick([0, 9, 23]), pick([0, 30])).toISOString();
  const products: { id: number; officeId: number; kind: StockKind }[] = [];
  for (let index = 0; index < 36; index++) {
    const kind: StockKind = random() < 0.55 ? 'food' : 'daily';
    const officeId = random() < 0.6 ? 1 : 2;
    const id = await insert(db, 'stock_product', {
      kind,
      name: `${pick(NAMES)}${index % 5 === 0 ? '' : ` ${index}`}`,
      category: pick(CATEGORIES[kind]),
      unit: pick(['瓶', '包', '个']),
      low_stock_threshold: random() < 0.4 ? between(1, 8) : null,
      expiry_lead_days: random() < 0.2 ? between(1, 20) : null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      office_id: officeId,
      uid: uid(),
    });
    products.push({ id, officeId, kind });
    for (let batch = between(0, 3); batch > 0; batch--) {
      await insert(db, 'stock_batch', {
        product_id: id,
        quantity: random() < 0.3 ? 0 : between(1, 9) + pick([0, 0.5, 0.25]),
        expiry_date: random() < 0.7 ? toDateStr(new Date(2026, 10, 18 + between(-20, 30))) : null,
        added_on: '2026-09-01',
        uid: uid(),
      });
    }
  }
  const movements: { uid: string; productId: number; type: 'in' | 'out'; delta: number; at: string }[] = [];
  for (let index = 0; index < 420; index++) {
    const product = pick(products);
    const at = day();
    const roll = random();
    const movementUid = uid();
    if (roll < 0.45) {
      const inputQty = between(1, 4);
      const size = pick([1, 1, 6, 12]);
      const priced = random();
      await insert(db, 'stock_movement', {
        product_id: product.id,
        type: 'in',
        delta: inputQty * size,
        happened_at: at,
        input_qty: size > 1 ? inputQty : null,
        input_unit: size > 1 ? '箱' : null,
        unit_price: priced < 0.3 ? between(100, 900) / 100 : null,
        total_price: priced < 0.3 ? null : priced < 0.75 ? between(100, 9000) / 100 : null,
        uid: movementUid,
      });
      movements.push({ uid: movementUid, productId: product.id, type: 'in', delta: inputQty * size, at });
    } else if (roll < 0.88) {
      const delta = -(between(1, 5) + pick([0, 0, 0.5]));
      await insert(db, 'stock_movement', {
        product_id: product.id,
        type: 'out',
        delta,
        happened_at: at,
        note: pick(['用掉', '用掉', '过期丢弃', ' 坏了 ', '坏了', '送人', '其他', '盘点少了', '', null]),
        uid: movementUid,
      });
      movements.push({ uid: movementUid, productId: product.id, type: 'out', delta, at });
    } else if (roll < 0.93) {
      await insert(db, 'stock_movement', { product_id: product.id, type: 'adjust', delta: between(-2, 2), happened_at: at, uid: movementUid });
    } else if (roll < 0.97) {
      // 调拨：两边各一条，同一张单
      const target = pick(products.filter((item) => item.officeId !== product.officeId));
      const order = uid();
      const quantity = between(1, 3);
      await insert(db, 'stock_movement', { product_id: product.id, type: 'out', delta: -quantity, happened_at: at, note: '调拨', uid: movementUid, order_id: order, order_kind: 'transfer' });
      await insert(db, 'stock_movement', { product_id: target.id, type: 'in', delta: quantity, happened_at: at, total_price: 9, uid: uid(), order_id: order, order_kind: 'transfer' });
    } else if (movements.length) {
      // 冲正前面的一条（被冲正的那条和冲正记录都不算）
      const original = movements.splice(Math.floor(random() * movements.length), 1)[0];
      await insert(db, 'stock_movement', {
        product_id: original.productId,
        type: original.type === 'in' ? 'out' : 'in',
        delta: -original.delta,
        happened_at: original.at,
        note: '冲正',
        uid: movementUid,
        order_id: uid(),
        order_kind: 'reversal',
        reverses_movement_uid: original.uid,
      });
    }
  }
  // 设备、领用、人员和部门（联网版才有人员名单的编号、部门）
  const departments = ['研发部', '行政部'];
  const people: string[] = [];
  const personColumns = await columnsOf(db, 'person');
  if (personColumns.has('uid')) {
    for (const [index, name] of departments.entries()) await insert(db, 'department', { uid: `dept-${index}`, name, sort: index });
    for (let index = 0; index < 6; index++) {
      const personUid = `person-${index}`;
      await insert(db, 'person', { uid: personUid, email: `p${index}@company.com`, nickname: `人${index}`, department_uid: index < 4 ? `dept-${index % 2}` : null });
      people.push(personUid);
    }
  }
  for (let index = 0; index < 14; index++) {
    const quantity = random() < 0.6 ? 1 : between(2, 6);
    const deviceId = await insert(db, 'device', {
      category: pick(['笔记本', '显示器', '手机', '台式机']),
      name: `${pick(['MacBook', 'ThinkPad', 'Dell', 'iPhone'])} ${index}`,
      model: random() < 0.5 ? `M${index}` : null,
      serial_no: random() < 0.5 ? `SN${index}` : null,
      quantity,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      office_id: random() < 0.6 ? 1 : 2,
      warranty_until: random() < 0.8 ? toDateStr(new Date(2026, 10, 18 + between(-40, 60))) : null,
      chip: random() < 0.5 ? 'M3' : null,
      memory: random() < 0.5 ? '16G' : null,
      uid: uid(),
    });
    for (let turn = between(0, 3); turn > 0; turn--) {
      const personUid = people.length && random() < 0.6 ? pick(people) : null;
      await insert(db, 'device_assignment', {
        device_id: deviceId,
        person: personUid ? `人${personUid.slice(-1)}` : pick(['张三', '李四']),
        quantity: between(1, Math.max(1, quantity)),
        issued_on: '2026-10-01',
        returned_on: random() < 0.4 ? '2026-11-01' : null,
        uid: uid(),
        person_uid: personUid,
      });
    }
  }
  return db;
}

const PERIODS: ReportPeriodKey[] = ['thisMonth', 'lastMonth', 'last3Months', 'thisYear'];

/** 一页一页取到底（每页 limit 条），检查条数和不重复 */
async function allPages(db: SQLiteDatabase, query: ReportDetailQuery, limit = 7): Promise<ReportDetailItem[]> {
  const items: ReportDetailItem[] = [];
  let offset: number | null = 0;
  let total: number | null = null;
  while (offset !== null) {
    const page = await loadDetailPage(db, query, offset, limit);
    if (offset === 0) total = page.total;
    else assert.equal(page.total, null, '只有第一页带条数');
    assert.ok(page.items.length <= limit);
    items.push(...page.items);
    offset = page.nextOffset;
  }
  assert.equal(items.length, total, `${query.kind} 条数`);
  const keys = items.map((item) => detailRowView(query.kind, item, TODAY, LEAD_DAYS).key);
  assert.equal(new Set(keys).size, keys.length, `${query.kind} 不重复`);
  return items;
}

function queryOf(kind: ReportDetailKind, officeId: number | null, key: ReportPeriodKey, extra: Partial<ReportDetailQuery> = {}): ReportDetailQuery {
  const period = periodRange(key, NOW);
  return {
    kind,
    officeId,
    startIso: period.startIso,
    endIso: period.endIso,
    today: TODAY,
    leadDays: LEAD_DAYS,
    stockKind: null,
    category: null,
    search: '',
    deviceStatus: 'all',
    ...extra,
  };
}

function productIds(items: readonly ReportDetailItem[]): number[] {
  return items.map((item) => (item as ProductDetailItem).productId);
}

describe('报表聚合和逐条算的一样', () => {
  for (const seed of [1, 2, 3]) {
    it(`随机数据 ${seed}：各办公点、各时间段的首页数字`, async () => {
      const db = await randomDb(seed);
      for (const officeId of [null, 1, 2]) {
        for (const key of PERIODS) {
          const period = periodRange(key, NOW);
          const buckets = periodBuckets(key, NOW);
          const label = `${officeId ?? '全部'} ${key}`;
          const source = await loadReportSource(db, officeId, period);
          const rows = await loadOverviewRows(db, officeId, period, buckets, TODAY, LEAD_DAYS);
          const overview = buildOverview(rows, buckets.map((bucket) => bucket.label));

          const inventory = summarizeInventory(source.products, TODAY, LEAD_DAYS);
          assert.deepEqual(overview.inventory.byKind, inventory.productCount, label);
          assert.deepEqual(
            [overview.inventory.lowStock, overview.inventory.expiring, overview.inventory.expired],
            [inventory.lowStock.length, inventory.expiringSoon.length, inventory.expired.length],
            label,
          );

          const purchases = summarizePurchases(source.movements);
          assert.deepEqual(
            [overview.purchases.count, overview.purchases.amount, overview.purchases.unpricedCount, overview.purchases.amountByKind],
            [purchases.stockInCount, purchases.pricedAmount, purchases.unpricedCount, purchases.amountByKind],
            label,
          );
          // 每根柱子：逐条按时间落到哪一根再加
          const expectedColumns = buckets.map((bucket) =>
            source.movements
              .filter((movement) => movement.happenedAt >= bucket.startIso && movement.happenedAt < bucket.endIso)
              .filter((movement) => movement.type === 'in' && movement.delta > 0 && !movement.orderKind && !movement.reversedAt && !movement.reverses)
              .reduce((sum, movement) => sum + (movement.totalPrice ?? 0), 0),
          );
          assert.deepEqual(
            overview.purchases.columns.map((column) => column.value),
            expectedColumns.map((value) => Math.round(value * 100) / 100),
            label,
          );
          assert.equal(
            overview.purchases.columns.reduce((sum, column) => sum + column.count, 0),
            purchases.stockInCount,
            label,
          );

          const consumption = summarizeConsumption(source.movements, source.priceHistory);
          assert.equal(overview.consumption.count, consumption.stockOutCount, label);
          assert.deepEqual(
            new Map(overview.consumption.reasons.map((reason) => [reason.label, reason.value])),
            new Map(consumption.reasons.map((reason) => [reason.reason, reason.count])),
            label,
          );
          assert.deepEqual(
            overview.consumption.top.map((row) => [row.productId, row.count, row.quantity]),
            consumption.topProducts.slice(0, 5).map((row) => [row.productId, row.count, row.quantity]),
            label,
          );
          assert.deepEqual(
            overview.consumption.losses,
            {
              count: consumption.losses.length,
              estimatedTotal: consumption.estimatedLossTotal,
              unestimatedCount: consumption.unestimatedLossCount,
            },
            label,
          );

          const devices = summarizeDevices(source.devices, source.assignments, TODAY);
          assert.deepEqual(
            [overview.devices.total, overview.devices.out, overview.devices.inStock, overview.devices.warrantySoon, overview.devices.warrantyExpired],
            [devices.total, devices.out, devices.inStock, devices.warrantySoonQty, devices.warrantyExpiredQty],
            label,
          );
          assert.deepEqual(
            overview.devices.holders.map((bar) => [bar.label, bar.value]),
            devices.holders.slice(0, 5).map((holder) => [holder.person, holder.quantity]),
            label,
          );
        }
      }
    });

    it(`随机数据 ${seed}：明细按页取，不重不漏，和逐条算的一样`, async () => {
      const db = await randomDb(seed);
      for (const officeId of [null, 2]) {
        for (const key of ['thisMonth', 'thisYear'] as const) {
          const label = `${officeId ?? '全部'} ${key}`;
          const source = await loadReportSource(db, officeId, periodRange(key, NOW));
          const expected = productDetails(source.products, source.movements);

          const products = (await allPages(db, queryOf('products', officeId, key))) as ProductDetailItem[];
          assert.deepEqual(
            products.map((item) => [item.productId, item.inQty, item.outQty, item.totalQty, item.purchaseAmount]),
            expected.map((row) => [row.productId, row.inQty, row.outQty, row.currentQty, row.purchaseAmount]),
            label,
          );

          const inventory = summarizeInventory(source.products, TODAY, LEAD_DAYS);
          const sorted = (ids: number[]) => [...ids].sort((left, right) => left - right);
          const lowStock = await allPages(db, queryOf('lowStock', officeId, key));
          assert.deepEqual(sorted(productIds(lowStock)), sorted(inventory.lowStock.map((item) => item.productId)), label);
          const lowNames = lowStock.map((item) => (item as ProductDetailItem).name);
          assert.deepEqual(lowNames, [...lowNames].sort(compareZh), '库存不足按名称');
          for (const [kind, list] of [
            ['expiring', inventory.expiringSoon],
            ['expired', inventory.expired],
          ] as const) {
            const items = (await allPages(db, queryOf(kind, officeId, key))) as ProductDetailItem[];
            assert.deepEqual(sorted(productIds(items)), sorted(list.map((item) => item.productId)), `${label} ${kind}`);
            const dates = items.map((item) => item.nearestExpiry ?? '');
            assert.deepEqual(dates, [...dates].sort(), '先到期的在前');
            // 右边写的天数和原来名单里的一样
            for (const item of items) {
              const view = detailRowView(kind, item, TODAY, LEAD_DAYS);
              assert.equal(view.value, list.find((ref) => ref.productId === item.productId)?.detail);
            }
          }

          const consumption = summarizeConsumption(source.movements, source.priceHistory);
          const losses = await allPages(db, queryOf('losses', officeId, key));
          assert.deepEqual(
            new Map(losses.map((item) => [(item as LossDetailItem).movementId, lossEstimate(item as LossDetailItem)])),
            new Map(consumption.losses.map((loss) => [loss.movementId, loss.estimatedLoss])),
            label,
          );
          const lossTimes = losses.map((item) => (item as LossDetailItem).happenedAt);
          assert.deepEqual(lossTimes, [...lossTimes].sort().reverse(), '损耗新的在前');

          const purchased = (await allPages(db, queryOf('purchases', officeId, key))) as ProductDetailItem[];
          const purchases = summarizePurchases(source.movements, 1000);
          assert.deepEqual(
            new Set(purchased.map((item) => item.productId)),
            new Set(source.movements.filter((movement) => movement.type === 'in' && movement.delta > 0 && !movement.orderKind && !movement.reversedAt && !movement.reverses).map((movement) => movement.productId)),
            label,
          );
          const amounts = purchased.map((item) => item.purchaseAmount ?? -1);
          assert.deepEqual(amounts, [...amounts].sort((left, right) => right - left), '进货金额高的在前');
          assert.deepEqual(
            new Map(purchased.filter((item) => (item.purchaseAmount ?? 0) > 0).map((item) => [item.productId, item.purchaseAmount])),
            new Map(purchases.topProducts.map((rank) => [rank.productId, rank.amount])),
            label,
          );

          const consumed = (await allPages(db, queryOf('consumption', officeId, key))) as ProductDetailItem[];
          const counts = consumed.map((item) => item.outCount);
          assert.deepEqual(counts, [...counts].sort((left, right) => right - left), '出库次数多的在前');
          assert.equal(counts.reduce((sum, count) => sum + count, 0), consumption.stockOutCount, label);

          const devices = await allPages(db, queryOf('devices', officeId, key));
          assert.equal(devices.length, source.devices.length, label);
          const summary = summarizeDevices(source.devices, source.assignments, TODAY);
          const soon = await allPages(db, queryOf('devices', officeId, key, { deviceStatus: 'warrantySoon' }));
          assert.deepEqual(sorted(soon.map((item) => (item as { deviceId: number }).deviceId)), sorted(summary.warrantySoon.map((ref) => ref.deviceId)));
          const expired = await allPages(db, queryOf('devices', officeId, key, { deviceStatus: 'warrantyExpired' }));
          assert.deepEqual(sorted(expired.map((item) => (item as { deviceId: number }).deviceId)), sorted(summary.warrantyExpired.map((ref) => ref.deviceId)));
          const out = await allPages(db, queryOf('devices', officeId, key, { deviceStatus: 'out' }));
          assert.deepEqual(sorted(out.map((item) => (item as { deviceId: number }).deviceId)), sorted(source.devices.filter((device) => device.outQty > 0).map((device) => device.id)));
        }
      }
    });
  }

  it('明细的大类、分类、搜索筛选；第一页带分类选项', async () => {
    const db = await randomDb(7);
    const source = await loadReportSource(db, null, periodRange('thisYear', NOW));
    const all = productDetails(source.products, source.movements);
    const categoryOf = new Map(source.products.map((product) => [product.id, product.category]));
    for (const stockKind of [null, 'food', 'daily'] as const) {
      const first = await loadDetailPage(db, queryOf('products', null, 'thisYear', { stockKind }), 0, 5);
      const expectedCategories = new Set(
        source.products.filter((product) => product.category && (!stockKind || product.kind === stockKind)).map((product) => product.category),
      );
      assert.deepEqual(new Set(first.categories), expectedCategories, `分类选项 ${stockKind}`);
      for (const category of [null, ...expectedCategories]) {
        for (const search of ['', 'apple', '可乐', '不存在']) {
          const items = await allPages(db, queryOf('products', null, 'thisYear', { stockKind, category, search }), 4);
          const expected = all.filter(
            (row) =>
              (!stockKind || row.kind === stockKind) &&
              (!category || categoryOf.get(row.productId) === category) &&
              row.name.toLowerCase().includes(search),
          );
          assert.deepEqual(productIds(items), expected.map((row) => row.productId), `${stockKind} ${category} ${search}`);
        }
      }
    }
  });
});
