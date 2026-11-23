import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDevice, issueDevice } from '../src/db/devices';
import { createOffice } from '../src/db/offices';
import { loadReportSource } from '../src/db/report';
import { createProduct, stockIn, stockOut, type StockProductInput } from '../src/db/stock';
import {
  deviceTable,
  formatLocalTimestamp,
  movementTable,
  periodRange,
  priceBefore,
  productDetails,
  reportFileName,
  stockTable,
  summarizeConsumption,
  summarizeDevices,
  summarizeInventory,
  summarizePurchases,
  type PricedStockIn,
  type ReportDevice,
  type ReportMovement,
  type ReportProduct,
} from '../src/lib/report';
import { openDb } from './helpers/memoryDb';

function localParts(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${date.getMinutes()}`;
}

function product(overrides: Partial<ReportProduct> & { id: number; name: string }): ReportProduct {
  return {
    officeId: 1,
    kind: 'food',
    category: null,
    barcode: null,
    unit: '瓶',
    location: null,
    lowStockThreshold: null,
    expiryLeadDays: null,
    totalQty: 10,
    nearestExpiry: null,
    ...overrides,
  };
}

let movementId = 0;
function movement(overrides: Partial<ReportMovement> & Pick<ReportMovement, 'productId' | 'type' | 'delta'>): ReportMovement {
  movementId += 1;
  return {
    id: movementId,
    officeId: 1,
    kind: 'food',
    category: null,
    productName: `物品${overrides.productId}`,
    unit: '瓶',
    happenedAt: '2026-11-10T02:00:00.000Z',
    note: null,
    inputQty: null,
    inputUnit: null,
    unitPrice: null,
    totalPrice: null,
    ...overrides,
  };
}

function device(overrides: Partial<ReportDevice> & { id: number; name: string }): ReportDevice {
  return {
    officeId: 1,
    category: '笔记本',
    model: null,
    serialNo: null,
    invoiceNo: null,
    chip: null,
    memory: null,
    storage: null,
    quantity: 1,
    outQty: 0,
    holders: null,
    purchaseDate: null,
    warrantyUntil: null,
    ...overrides,
  };
}

describe('报表时间段', () => {
  const now = new Date(2026, 10, 18, 10, 30);

  it('本月、上月、近 3 个月、今年，按本地时间起止', () => {
    const thisMonth = periodRange('thisMonth', now);
    assert.equal(thisMonth.label, '2026年11月');
    assert.equal(localParts(thisMonth.startIso), '2026-11-1 0:0');
    assert.equal(localParts(thisMonth.endIso), '2026-12-1 0:0');

    const lastMonth = periodRange('lastMonth', now);
    assert.equal(lastMonth.label, '2026年10月');
    assert.equal(localParts(lastMonth.startIso), '2026-10-1 0:0');
    assert.equal(lastMonth.endIso, thisMonth.startIso);

    const recent = periodRange('last3Months', now);
    assert.equal(recent.label, '2026年9月–11月');
    assert.equal(localParts(recent.startIso), '2026-9-1 0:0');

    const year = periodRange('thisYear', now);
    assert.equal(year.label, '2026年');
    assert.equal(localParts(year.startIso), '2026-1-1 0:0');
    assert.equal(localParts(year.endIso), '2027-1-1 0:0');
  });

  it('跨年：1 月的上月是去年 12 月，近 3 个月带两个年份', () => {
    const january = new Date(2027, 0, 5);
    assert.equal(periodRange('lastMonth', january).label, '2026年12月');
    assert.equal(periodRange('last3Months', january).label, '2026年11月–2027年1月');
  });
});

describe('库存概况', () => {
  it('分类计数、库存不足、快到期（各物品提前天数或默认）、已过期', () => {
    const summary = summarizeInventory(
      [
        product({ id: 1, name: '牛奶', totalQty: 1, lowStockThreshold: 2, nearestExpiry: '2026-11-20' }),
        product({ id: 2, name: '面包', nearestExpiry: '2026-11-15' }),
        product({ id: 3, name: '饼干', nearestExpiry: '2026-11-28', expiryLeadDays: 14 }),
        product({ id: 4, name: '罐头', nearestExpiry: '2026-12-30' }),
        product({ id: 5, name: '纸巾', kind: 'daily', totalQty: 0, lowStockThreshold: 0 }),
        product({ id: 6, name: '酸奶', nearestExpiry: '2026-11-10' }),
      ],
      '2026-11-18',
      7,
    );
    assert.deepEqual(summary.productCount, { food: 5, daily: 1 });
    assert.deepEqual(
      summary.lowStock.map((item) => item.name),
      ['牛奶', '纸巾'],
    );
    assert.deepEqual(
      summary.expiringSoon.map((item) => item.name),
      ['牛奶', '饼干'],
    );
    // 最早过期的排前面
    assert.deepEqual(
      summary.expired.map((item) => item.name),
      ['酸奶', '面包'],
    );
    assert.equal(summary.lowStock[0].detail, '剩 1 瓶');
  });
});

describe('进货汇总', () => {
  it('只把填了总价的入库算进金额，没填的单独计数；按分类和物品排行', () => {
    const summary = summarizePurchases([
      movement({ productId: 1, type: 'in', delta: 24, totalPrice: 48 }),
      movement({ productId: 1, type: 'in', delta: 12, totalPrice: 30.5 }),
      movement({ productId: 2, type: 'in', delta: 5, kind: 'daily', totalPrice: 100 }),
      movement({ productId: 3, type: 'in', delta: 3 }),
      movement({ productId: 1, type: 'out', delta: -2, note: '用掉' }),
      movement({ productId: 1, type: 'adjust', delta: 1 }),
    ]);
    assert.equal(summary.stockInCount, 4);
    assert.equal(summary.unpricedCount, 1);
    assert.equal(summary.pricedAmount, 178.5);
    assert.deepEqual(summary.amountByKind, { food: 78.5, daily: 100 });
    assert.deepEqual(
      summary.topProducts.map((rank) => [rank.productId, rank.count, rank.amount]),
      [
        [2, 1, 100],
        [1, 2, 78.5],
      ],
    );
  });

  it('前 N 名', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      movement({ productId: index + 1, type: 'in', delta: 1, totalPrice: index + 1 }),
    );
    const summary = summarizePurchases(many);
    assert.equal(summary.topProducts.length, 10);
    assert.equal(summary.topProducts[0].amount, 12);
  });
});

describe('消耗汇总', () => {
  const history: PricedStockIn[] = [
    // 10 月按箱进：2 箱 = 48 瓶，总价 96 → 每瓶 2
    { productId: 1, delta: 48, inputQty: 2, unitPrice: 48, totalPrice: 96, happenedAt: '2026-10-01T00:00:00.000Z' },
    // 11 月 12 日涨价，每瓶 3（只在这之后的出库用）
    { productId: 1, delta: 10, inputQty: 10, unitPrice: 3, totalPrice: 30, happenedAt: '2026-11-12T00:00:00.000Z' },
  ];

  it('出库前最近一次进价', () => {
    assert.equal(priceBefore(history, 1, '2026-11-05T00:00:00.000Z'), 2);
    assert.equal(priceBefore(history, 1, '2026-11-20T00:00:00.000Z'), 3);
    assert.equal(priceBefore(history, 1, '2026-09-01T00:00:00.000Z'), null);
    assert.equal(priceBefore(history, 2, '2026-11-20T00:00:00.000Z'), null);
  });

  it('按原因计次、按数量排行、过期丢弃和坏了估算损失', () => {
    const summary = summarizeConsumption(
      [
        movement({ productId: 1, type: 'out', delta: -5, note: '用掉' }),
        movement({ productId: 1, type: 'out', delta: -4, note: '过期丢弃', happenedAt: '2026-11-05T00:00:00.000Z' }),
        movement({ productId: 1, type: 'out', delta: -2, note: '坏了', happenedAt: '2026-11-15T00:00:00.000Z' }),
        movement({ productId: 2, type: 'out', delta: -20, note: '送人', unit: '包', productName: '纸巾' }),
        movement({ productId: 3, type: 'out', delta: -1, note: '过期丢弃', happenedAt: '2026-11-16T00:00:00.000Z' }),
        movement({ productId: 4, type: 'out', delta: -1 }),
        movement({ productId: 1, type: 'in', delta: 10 }),
      ],
      history,
    );
    assert.equal(summary.stockOutCount, 6);
    assert.deepEqual(
      summary.reasons.map((item) => [item.reason, item.count]),
      [
        ['用掉', 1],
        ['过期丢弃', 2],
        ['坏了', 1],
        ['送人', 1],
        ['没写原因', 1],
      ],
    );
    // 按出库次数排，同次数再按数量；不同单位的数量不放在一起比
    assert.deepEqual(
      summary.topProducts.map((rank) => [rank.name, rank.count, rank.quantity, rank.unit]),
      [
        ['物品1', 3, 11, '瓶'],
        ['纸巾', 1, 20, '包'],
        ['物品3', 1, 1, '瓶'],
        ['物品4', 1, 1, '瓶'],
      ],
    );
    // 最近的排前面；11-05 的按每瓶 2，11-15 的按每瓶 3，物品 3 没有进价
    assert.deepEqual(
      summary.losses.map((loss) => [loss.productId, loss.reason, loss.quantity, loss.estimatedLoss]),
      [
        [3, '过期丢弃', 1, null],
        [1, '坏了', 2, 6],
        [1, '过期丢弃', 4, 8],
      ],
    );
    assert.equal(summary.estimatedLossTotal, 14);
    assert.equal(summary.unestimatedLossCount, 1);
  });
});

describe('物品明细', () => {
  it('每个物品一行，食品在前，时间段内没进出的也列出', () => {
    const rows = productDetails(
      [
        product({ id: 1, name: '牛奶', totalQty: 30 }),
        product({ id: 2, name: '纸巾', kind: 'daily', unit: '包', totalQty: 8 }),
        product({ id: 3, name: '面包', totalQty: 0 }),
      ],
      [
        movement({ productId: 1, type: 'in', delta: 24, totalPrice: 48 }),
        movement({ productId: 1, type: 'in', delta: 12 }),
        movement({ productId: 1, type: 'out', delta: -6, note: '用掉' }),
        movement({ productId: 2, type: 'out', delta: -2, note: '用掉' }),
        movement({ productId: 99, type: 'in', delta: 1, totalPrice: 5 }),
      ],
    );
    assert.deepEqual(
      rows.map((row) => [row.name, row.inQty, row.outQty, row.currentQty, row.purchaseAmount]),
      [
        ['面包', 0, 0, 0, null],
        ['牛奶', 36, 6, 30, 48],
        ['纸巾', 0, 2, 8, null],
      ],
    );
  });
});

describe('设备汇总', () => {
  it('按类别统计总数、借出、在库；保修按件数；领用排行', () => {
    const summary = summarizeDevices(
      [
        device({
          id: 1,
          name: 'MacBook',
          chip: 'M1',
          memory: '8G',
          storage: '256G',
          quantity: 3,
          outQty: 2,
          warrantyUntil: '2026-12-01',
        }),
        device({ id: 2, name: 'ThinkPad', quantity: 2, outQty: 0, warrantyUntil: '2026-10-01' }),
        device({ id: 3, name: 'U2723QE', category: '显示器', quantity: 4, outQty: 1, warrantyUntil: '2028-01-01' }),
      ],
      [
        { person: '张三', quantity: 1 },
        { person: '李四', quantity: 1 },
        { person: '张三', quantity: 1 },
      ],
      '2026-11-18',
    );
    assert.deepEqual([summary.total, summary.out, summary.inStock], [9, 3, 6]);
    assert.deepEqual(
      summary.byCategory.map((row) => [row.category, row.total, row.out, row.inStock]),
      [
        ['笔记本', 5, 2, 3],
        ['显示器', 4, 1, 3],
      ],
    );
    // 电脑按配置：显示器不算，没记配置的排最后
    assert.deepEqual(
      summary.byConfig.map((row) => [row.config, row.total, row.out, row.inStock]),
      [
        ['M1 8G/256G', 3, 2, 1],
        ['没记配置', 2, 0, 2],
      ],
    );
    assert.equal(summary.warrantySoonQty, 3);
    assert.equal(summary.warrantyExpiredQty, 2);
    assert.deepEqual(summary.warrantySoon.map((item) => item.name), ['MacBook']);
    assert.deepEqual(
      summary.holders.map((holder) => [holder.person, holder.quantity]),
      [
        ['张三', 2],
        ['李四', 1],
      ],
    );
  });
});

describe('导出表格', () => {
  const officeName = (officeId: number) => (officeId === 1 ? '北京' : '上海');

  it('出入库明细：本地时间、类型中文、按什么单位输入', () => {
    const table = movementTable(
      [
        movement({
          productId: 1,
          productName: '可乐',
          type: 'in',
          delta: 48,
          inputQty: 2,
          inputUnit: '箱',
          unitPrice: 48,
          totalPrice: 96,
          category: '饮料冲调',
        }),
        movement({ productId: 1, productName: '可乐', type: 'out', delta: -3, note: '用掉', officeId: 2 }),
      ],
      officeName,
    );
    assert.equal(table.header.length, 12);
    assert.deepEqual(table.header.slice(1, 5), ['办公点', '大类', '分类', '物品']);
    assert.deepEqual(table.rows[0].slice(1), ['北京', '食品', '饮料冲调', '可乐', '入库', 48, '瓶', '2 箱', 48, 96, null]);
    assert.deepEqual(table.rows[1].slice(1), ['上海', '食品', null, '可乐', '出库', -3, '瓶', null, null, null, '用掉']);
    assert.equal(table.rows[0][0], formatLocalTimestamp('2026-11-10T02:00:00.000Z'));
  });

  it('当前库存：每批一行，没有批次的物品也列一行', () => {
    const table = stockTable(
      [
        product({ id: 1, name: '牛奶', barcode: '690', location: '冰箱', category: '乳品' }),
        product({ id: 2, name: '面包', totalQty: 0 }),
      ],
      [
        { productId: 1, quantity: 6, expiryDate: '2026-11-25', addedOn: '2026-11-18' },
        { productId: 1, quantity: 4, expiryDate: null, addedOn: '2026-11-10' },
      ],
      officeName,
    );
    assert.deepEqual(table.header.slice(0, 4), ['办公点', '大类', '分类', '物品']);
    assert.deepEqual(table.rows, [
      ['北京', '食品', '乳品', '牛奶', { text: '690' }, 6, '瓶', '2026-11-25', '2026-11-18', '冰箱'],
      ['北京', '食品', '乳品', '牛奶', { text: '690' }, 4, '瓶', null, '2026-11-10', '冰箱'],
      ['北京', '食品', null, '面包', null, 0, '瓶', null, null, null],
    ]);
  });

  it('设备清单：使用人去重、配件、发票号', () => {
    const table = deviceTable(
      [
        device({
          id: 7,
          name: 'MacBook',
          invoiceNo: 'FP-001',
          chip: 'M3 Pro',
          memory: '18G',
          storage: '512G',
          quantity: 3,
          outQty: 2,
          holders: '张三、张三',
          warrantyUntil: '2027-09-30',
        }),
      ],
      new Map([[7, [{ name: '充电器', quantity: 1 }]]]),
      officeName,
    );
    assert.deepEqual(table.rows[0], [
      '北京',
      '笔记本',
      'MacBook',
      null,
      'M3 Pro',
      '18G',
      '512G',
      null,
      { text: 'FP-001' },
      3,
      2,
      1,
      '张三',
      null,
      '2027-09-30',
      '充电器 ×1',
    ]);
  });

  it('文件名和本地时间', () => {
    assert.equal(reportFileName('出入库明细', '北京', '2026年11月'), '出入库明细-北京-2026年11月.csv');
    assert.equal(reportFileName('设备清单', null, '2026-11-18'), '设备清单-全部办公点-2026-11-18.csv');
    const local = new Date(2026, 10, 18, 9, 5);
    assert.equal(formatLocalTimestamp(local.toISOString()), '2026-11-18 09:05');
    assert.equal(formatLocalTimestamp('不是时间'), '不是时间');
  });
});

describe('报表取数（真实 SQLite）', () => {
  function stockProduct(overrides: Partial<StockProductInput> = {}): StockProductInput {
    return {
      officeId: 1,
      kind: 'food',
      barcode: null,
      name: '可乐',
      category: null,
      spec: null,
      unit: '瓶',
      location: null,
      lowStockThreshold: null,
      expiryLeadDays: null,
      note: null,
      packs: [],
      ...overrides,
    };
  }

  it('按办公点和时间段取数，汇总出进货、损失、设备', async () => {
    const db = await openDb();
    const shanghai = await createOffice(db, '上海');
    const cola = await createProduct(db, stockProduct({ packs: [{ unit: '箱', size: 24, barcode: null }] }), {
      quantity: 48,
      expiryDate: '2027-01-31',
      entry: { qty: 2, unit: '箱' },
      price: { unitPrice: 48, totalPrice: 96 },
    });
    await stockIn(db, cola, { quantity: 6, expiryDate: null, entry: { qty: 6, unit: '瓶' } });
    await stockOut(db, cola, 4, '过期丢弃', { qty: 4, unit: '瓶' });
    // 上个月的一条入库，不在本月里
    await db.runAsync(
      `INSERT INTO stock_movement (product_id, type, delta, expiry_date, happened_at, note, total_price)
       VALUES (?, 'in', 10, NULL, '2000-01-01T00:00:00.000Z', NULL, 20)`,
      [cola],
    );
    // 别的办公点的物品不应算进北京
    await createProduct(db, stockProduct({ officeId: shanghai, name: '雪碧' }), {
      quantity: 5,
      expiryDate: null,
      price: { unitPrice: 1, totalPrice: 5 },
    });
    const deviceId = await createDevice(db, {
      officeId: 1,
      category: '笔记本',
      name: 'MacBook',
      model: null,
      serialNo: null,
      invoiceNo: 'FP-001',
      quantity: 2,
      note: null,
      purchaseDate: null,
      warrantyUntil: null,
      accessories: [{ name: '充电器', quantity: 1 }],
    });
    await issueDevice(db, deviceId, { person: '张三', quantity: 1, issuedOn: '2026-11-01', returnedOn: null, note: null });

    const source = await loadReportSource(db, 1, periodRange('thisMonth'));
    assert.deepEqual(
      source.products.map((item) => [item.name, item.totalQty]),
      [['可乐', 50]],
    );
    assert.equal(source.movements.length, 3);
    assert.equal(source.priceHistory.length, 2);
    const purchases = summarizePurchases(source.movements);
    assert.deepEqual([purchases.stockInCount, purchases.pricedAmount, purchases.unpricedCount], [2, 96, 1]);
    const consumption = summarizeConsumption(source.movements, source.priceHistory);
    // 每瓶 2（96 ÷ 48），丢了 4 瓶
    assert.deepEqual(
      consumption.losses.map((loss) => [loss.quantity, loss.estimatedLoss]),
      [[4, 8]],
    );
    assert.equal(source.batches.reduce((sum, batch) => sum + batch.quantity, 0), 50);
    assert.equal(source.officeNames.get(shanghai), '上海');
    const devices = summarizeDevices(source.devices, source.assignments, '2026-11-18');
    assert.deepEqual([devices.total, devices.out, devices.inStock], [2, 1, 1]);
    const table = deviceTable(source.devices, source.accessoriesByDevice, (officeId) => source.officeNames.get(officeId) ?? '');
    assert.deepEqual(table.rows[0][8], { text: 'FP-001' });
    assert.equal(table.rows[0][15], '充电器 ×1');

    const everywhere = await loadReportSource(db, null, periodRange('thisMonth'));
    assert.equal(everywhere.products.length, 2);
    assert.equal(summarizePurchases(everywhere.movements).pricedAmount, 101);
  });
});
