import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import { createDevice, issueDevice, listDevices, type DeviceInput } from '../src/db/devices';
import { createOffice, deleteOffice } from '../src/db/offices';
import { createProduct, listBatches, listMovements, stockIn, stockOut, type StockProductInput } from '../src/db/stock';
import {
  cancelStocktake,
  clearCount,
  finishStocktake,
  findStocktakeItemByCode,
  getOpenStocktake,
  getStocktake,
  listOpenStocktakeScopes,
  listStocktakeItems,
  listStocktakes,
  recordCount,
  startStocktake,
  type StocktakeItem,
} from '../src/db/stocktake';
import {
  adjustmentNote,
  buildStocktakeCsv,
  countDifference,
  countState,
  describeDifference,
  matchesFilter,
  matchesKeyword,
  parseKinds,
  planAdjustment,
  previewFinish,
  serializeKinds,
  stocktakesClearedByImport,
  summarizeCounts,
} from '../src/lib/stocktake';
import { openDb, plain } from './helpers/memoryDb';

function product(overrides: Partial<StockProductInput>): StockProductInput {
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

function device(overrides: Partial<DeviceInput>): DeviceInput {
  return {
    officeId: 1,
    category: '显示器',
    name: 'U2723QE',
    model: null,
    serialNo: null,
    quantity: 3,
    note: null,
    purchaseDate: null,
    warrantyUntil: null,
    invoiceNo: null,
    accessories: [],
    ...overrides,
  };
}

function itemNamed(items: StocktakeItem[], name: string): StocktakeItem {
  const found = items.find((item) => item.name === name);
  assert.ok(found, `盘点单里没有「${name}」`);
  return found;
}

describe('盘点纯函数', () => {
  it('分类存取按固定顺序、去重、丢掉不认识的', () => {
    assert.equal(serializeKinds(['devices', 'food', 'food']), 'food,devices');
    assert.deepEqual(parseKinds('daily, devices,xx'), ['daily', 'devices']);
    assert.deepEqual(parseKinds(null), []);
  });

  it('差异、状态、统计', () => {
    const items = [
      { expectedQty: 10, countedQty: 8 },
      { expectedQty: 2, countedQty: 5 },
      { expectedQty: 4, countedQty: 4 },
      { expectedQty: null, countedQty: null },
    ];
    assert.deepEqual(items.map(countDifference), [-2, 3, 0, null]);
    assert.deepEqual(items.map(countState), ['deficit', 'surplus', 'match', 'uncounted']);
    assert.deepEqual(summarizeCounts(items), { total: 4, counted: 3, uncounted: 1, match: 1, surplus: 1, deficit: 1 });
    assert.equal(describeDifference(items[0], '瓶'), '盘亏 -2 瓶');
    assert.equal(describeDifference(items[1], '瓶'), '盘盈 +3 瓶');
    assert.equal(describeDifference(items[2], '瓶'), '相符');
    assert.equal(describeDifference(items[3], '瓶'), '未盘');
    assert.equal(countDifference({ expectedQty: 0.3, countedQty: 0.1 }), -0.2);
  });

  it('筛选和搜索', () => {
    const counted = { expectedQty: 3, countedQty: 1 };
    const matched = { expectedQty: 3, countedQty: 3 };
    const open = { expectedQty: null, countedQty: null };
    assert.deepEqual([counted, matched, open].map((item) => matchesFilter(item, 'different')), [true, false, false]);
    assert.deepEqual([counted, matched, open].map((item) => matchesFilter(item, 'uncounted')), [false, false, true]);
    assert.ok(matchesKeyword({ name: 'Coca 可乐', code: '690' }, 'coca'));
    assert.ok(matchesKeyword({ name: '雪碧', code: '6901234' }, '6901'));
    assert.ok(!matchesKeyword({ name: '雪碧', code: null }, '可乐'));
  });

  it('盘亏从最早到期的批次扣，不够扣只扣到 0', () => {
    const batches = [
      { id: 1, quantity: 5, expiryDate: '2027-03-01' },
      { id: 2, quantity: 3, expiryDate: '2026-12-01' },
      { id: 3, quantity: 4, expiryDate: null },
    ];
    assert.deepEqual(planAdjustment(batches, -4), {
      updates: [
        { id: 2, quantity: 0 },
        { id: 1, quantity: 4 },
      ],
      newBatchQty: 0,
      targetExpiry: null,
      applied: -4,
    });
    assert.equal(planAdjustment([{ id: 1, quantity: 2, expiryDate: null }], -5).applied, -2);
  });

  it('盘盈加到最早到期的那一批，没有批次就新建', () => {
    const batches = [
      { id: 1, quantity: 5, expiryDate: null },
      { id: 2, quantity: 3, expiryDate: '2026-12-01' },
    ];
    assert.deepEqual(planAdjustment(batches, 2), {
      updates: [{ id: 2, quantity: 5 }],
      newBatchQty: 0,
      targetExpiry: '2026-12-01',
      applied: 2,
    });
    assert.deepEqual(planAdjustment([], 3), { updates: [], newBatchQty: 3, targetExpiry: null, applied: 3 });
    assert.deepEqual(planAdjustment(batches, 0), { updates: [], newBatchQty: 0, targetExpiry: null, applied: 0 });
  });

  it('出入库记录备注；库存不够扣时注明', () => {
    assert.equal(adjustmentNote(10, 8, -2), '盘点：账面 10，实盘 8');
    assert.equal(adjustmentNote(10, 2, -3), '盘点：账面 10，实盘 2（库存只够扣 3）');
  });

  it('导出 CSV', () => {
    const text = buildStocktakeCsv(
      [
        { kind: 'food', name: '可乐', unit: '瓶', itemType: 'product', expectedQty: 10, countedQty: 8, adjustedQty: -2 },
        { kind: 'devices', name: '显示器', unit: '件', itemType: 'device', expectedQty: 3, countedQty: 2, adjustedQty: null },
        { kind: 'daily', name: '抽纸', unit: '包', itemType: 'product', expectedQty: null, countedQty: null, adjustedQty: null },
      ],
      'done',
    );
    const lines = text.replace('﻿', '').trim().split('\r\n');
    assert.equal(lines[0], '大类,名称,单位,账面数量,实盘数量,差异,结果,是否已调整库存');
    assert.equal(lines[1], '食品,可乐,瓶,10,8,-2,盘亏,是（-2）');
    assert.equal(lines[2], '设备,显示器,件,3,2,-1,盘亏,否（设备要手动处理）');
    assert.equal(lines[3], '日用品,抽纸,包,,,,未盘,否');
  });

  it('导出 CSV：相符的设备写「不需要」；物品被删跳过、库存为 0 扣不了的注明', () => {
    const text = buildStocktakeCsv(
      [
        { kind: 'devices', name: '键盘', unit: '件', itemType: 'device', expectedQty: 3, countedQty: 3, adjustedQty: null },
        { kind: 'food', name: '面包', unit: '袋', itemType: 'product', expectedQty: 2, countedQty: 5, adjustedQty: null },
        { kind: 'food', name: '牛奶', unit: '盒', itemType: 'product', expectedQty: 2, countedQty: 0, adjustedQty: 0 },
      ],
      'done',
    );
    const lines = text.replace('﻿', '').trim().split('\r\n');
    assert.equal(lines[1], '设备,键盘,件,3,3,0,相符,不需要');
    assert.equal(lines[2], '食品,面包,袋,2,5,3,盘盈,否（物品已删除或移走）');
    assert.equal(lines[3], '食品,牛奶,盒,2,0,-2,盘亏,否（库存已经是 0，没法再扣）');
  });

  it('完成前的计数：已删除、移走的单独算，不计入盘盈盘亏和设备差异', () => {
    const preview = previewFinish([
      { itemType: 'product', expectedQty: 10, countedQty: 8, absence: null },
      { itemType: 'product', expectedQty: 2, countedQty: 5, absence: 'deleted' },
      { itemType: 'device', expectedQty: 3, countedQty: 2, absence: null },
      { itemType: 'device', expectedQty: 1, countedQty: 0, absence: 'moved' },
      { itemType: 'product', expectedQty: null, countedQty: null, absence: null },
    ]);
    assert.deepEqual(preview, { surplus: 0, deficit: 2, match: 0, uncounted: 1, absent: 2, deviceDifferences: 1 });
  });

  it('导入会清掉哪些办公点的进行中盘点：办公点在导入里、分类有交集', () => {
    const open = [
      { officeName: '北京', kinds: ['food' as const, 'daily' as const] },
      { officeName: '上海', kinds: ['devices' as const] },
      { officeName: null, kinds: ['food' as const] },
    ];
    assert.deepEqual(stocktakesClearedByImport(open, { offices: ['北京', '上海'], scope: ['daily', 'settings'] }), ['北京']);
    assert.deepEqual(stocktakesClearedByImport(open, { offices: ['北京', '上海'], scope: ['devices'] }), ['上海']);
    assert.deepEqual(stocktakesClearedByImport(open, { offices: ['广州'], scope: ['food'] }), []);
    assert.deepEqual(stocktakesClearedByImport(open, { offices: ['北京'], scope: ['settings'] }), []);
  });
});

describe('盘点（真实 SQLite）', () => {
  async function officeWithStock() {
    const db = await openDb();
    const colaId = await createProduct(
      db,
      product({ barcode: '6901234567892', packs: [{ unit: '箱', size: 12, barcode: '16901234567899' }] }),
      { quantity: 10, expiryDate: '2027-03-01' },
    );
    await stockIn(db, colaId, { quantity: 4, expiryDate: '2026-12-01' });
    const tissueId = await createProduct(db, product({ kind: 'daily', name: '抽纸', unit: '包' }), {
      quantity: 6,
      expiryDate: null,
    });
    const breadId = await createProduct(db, product({ name: '面包', unit: '袋' }), null);
    const monitorId = await createDevice(db, device({ serialNo: 'SN-1' }));
    await issueDevice(db, monitorId, { person: '张三', quantity: 1, issuedOn: '2026-11-01', returnedOn: null, note: null });
    return { db, colaId, tissueId, breadId, monitorId };
  }

  it('开始盘点：按分类建明细，账面数实时算；同一办公点不能开两个', async () => {
    const { db } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food', 'devices']);
    const items = await listStocktakeItems(db, id);
    assert.deepEqual(
      items.map((item) => [item.kind, item.name, item.unit, item.bookQty, item.countedQty]),
      [
        ['food', '可乐', '瓶', 14, null],
        ['food', '面包', '袋', 0, null],
        ['devices', 'U2723QE', '件', 2, null],
      ],
    );
    assert.equal((await getOpenStocktake(db, 1))?.id, id);
    await assert.rejects(startStocktake(db, 1, ['daily']), /还没完成/);
    await assert.rejects(startStocktake(db, 1, []), /至少选一个分类/);

    // 别的办公点可以同时盘；空办公点不用盘
    const shanghai = await createOffice(db, '上海');
    await assert.rejects(startStocktake(db, shanghai, ['food']), /还没有东西/);
    await createProduct(db, product({ officeId: shanghai, name: '咖啡' }), { quantity: 1, expiryDate: null });
    const other = await startStocktake(db, shanghai, ['food']);
    assert.deepEqual(
      (await listStocktakes(db, null)).map((entry) => [entry.id, entry.status, entry.summary.total]),
      [
        [other, 'open', 1],
        [id, 'open', 3],
      ],
    );
    assert.deepEqual(
      (await listStocktakes(db, shanghai)).map((entry) => entry.officeName),
      ['上海'],
    );
  });

  it('扫码：物品条码、包装条码（带单位）、设备序列号，不在盘点里的返回 null', async () => {
    const { db } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food', 'devices']);
    const items = await listStocktakeItems(db, id);
    assert.deepEqual(await findStocktakeItemByCode(db, id, '6901234567892'), { itemId: itemNamed(items, '可乐').id, packUnit: null });
    assert.deepEqual(await findStocktakeItemByCode(db, id, ' 16901234567899 '), { itemId: itemNamed(items, '可乐').id, packUnit: '箱' });
    assert.deepEqual(await findStocktakeItemByCode(db, id, 'SN-1'), { itemId: itemNamed(items, 'U2723QE').id, packUnit: null });
    assert.equal(await findStocktakeItemByCode(db, id, '999'), null);
  });

  it('完成：盘亏从最早到期的批次扣；清点后又出库，按清点时的账面算；未盘不调整；设备不改', async () => {
    const { db, colaId, breadId, monitorId } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food', 'devices']);
    let items = await listStocktakeItems(db, id);

    // 可乐账面 14，数出来 11：少 3
    await recordCount(db, itemNamed(items, '可乐').id, 11);
    // 清点之后又用掉 2 瓶，账面变 12，但盘点差异仍是 11 − 14 = −3
    await stockOut(db, colaId, 2, '用掉');
    // 设备在库 2，数到 1
    await recordCount(db, itemNamed(items, 'U2723QE').id, 1);
    await assert.rejects(recordCount(db, itemNamed(items, 'U2723QE').id, 1.5), /整数/);
    await assert.rejects(recordCount(db, itemNamed(items, '可乐').id, -1), /不能小于 0/);
    // 面包没盘

    items = await listStocktakeItems(db, id);
    assert.deepEqual(
      [itemNamed(items, '可乐').expectedQty, itemNamed(items, '可乐').countedQty, itemNamed(items, '可乐').bookQty],
      [14, 11, 12],
    );

    const result = await finishStocktake(db, id);
    assert.deepEqual(result, {
      total: 3,
      counted: 2,
      uncounted: 1,
      match: 0,
      surplus: 0,
      deficit: 2,
      adjustedProducts: 1,
      deviceDifferences: 1,
    });
    // 原来 12-01 到期 4 瓶、03-01 到期 10 瓶；出库 2 先扣 12-01 → 2；盘亏 3 再扣：12-01 剩的 2 扣光，03-01 扣 1 → 9
    assert.deepEqual(
      (await listBatches(db, colaId)).map((batch) => [batch.expiryDate, batch.quantity]),
      [['2027-03-01', 9]],
    );
    const [latest] = await listMovements(db, colaId);
    assert.deepEqual([latest.type, latest.delta, latest.note], ['adjust', -3, '盘点：账面 14，实盘 11']);
    assert.equal((await listMovements(db, breadId)).length, 0);
    // 设备数量不变
    const [monitor] = await listDevices(db, 1);
    assert.equal(monitor.id, monitorId);
    assert.equal(monitor.quantity, 3);

    const done = await getStocktake(db, id);
    assert.equal(done?.status, 'done');
    assert.ok(done?.finishedAt);
    items = await listStocktakeItems(db, id);
    assert.deepEqual(
      items.map((item) => [item.name, item.adjustedQty]),
      [
        ['可乐', -3],
        ['面包', null],
        ['U2723QE', null],
      ],
    );
    await assert.rejects(recordCount(db, itemNamed(items, '面包').id, 1), /已经结束/);
    await assert.rejects(finishStocktake(db, id), /已经结束/);
  });

  it('完成：盘盈加到最早到期的批次，没有批次就新建；相符记 0', async () => {
    const { db, colaId, tissueId, breadId } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food', 'daily']);
    const items = await listStocktakeItems(db, id);
    await recordCount(db, itemNamed(items, '可乐').id, 16);
    await recordCount(db, itemNamed(items, '面包').id, 3);
    await recordCount(db, itemNamed(items, '抽纸').id, 6);
    await finishStocktake(db, id);

    assert.deepEqual(
      (await listBatches(db, colaId)).map((batch) => [batch.expiryDate, batch.quantity]),
      [
        ['2026-12-01', 6],
        ['2027-03-01', 10],
      ],
    );
    const [colaMovement] = await listMovements(db, colaId);
    assert.deepEqual([colaMovement.delta, colaMovement.expiryDate], [2, '2026-12-01']);
    assert.deepEqual(
      (await listBatches(db, breadId)).map((batch) => [batch.expiryDate, batch.quantity, batch.note]),
      [[null, 3, '盘点多出']],
    );
    assert.equal((await listMovements(db, tissueId)).filter((movement) => movement.type === 'adjust').length, 0);
    assert.equal(itemNamed(await listStocktakeItems(db, id), '抽纸').adjustedQty, 0);
  });

  it('改回未盘；盘点期间物品被删了，完成时跳过', async () => {
    const { db, breadId } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food']);
    const items = await listStocktakeItems(db, id);
    await recordCount(db, itemNamed(items, '可乐').id, 1);
    await clearCount(db, itemNamed(items, '可乐').id);
    await recordCount(db, itemNamed(items, '面包').id, 2);
    await db.runAsync('DELETE FROM stock_product WHERE id = ?', [breadId]);
    const after = await listStocktakeItems(db, id);
    assert.deepEqual(
      after.map((item) => [item.name, item.countedQty, item.present]),
      [
        ['可乐', null, true],
        ['面包', 2, false],
      ],
    );
    const result = await finishStocktake(db, id);
    assert.equal(result.adjustedProducts, 0);
    assert.equal((await db.getAllAsync('SELECT id FROM stock_batch WHERE product_id = ?', [breadId])).length, 0);
  });

  it('完成时物品被移到别的办公点或改了分类：视为已移走，跳过，不动别处的库存', async () => {
    const { db, colaId, monitorId } = await officeWithStock();
    const shanghai = await createOffice(db, '上海');
    const id = await startStocktake(db, 1, ['food', 'devices']);
    const items = await listStocktakeItems(db, id);
    await recordCount(db, itemNamed(items, '可乐').id, 4);
    await recordCount(db, itemNamed(items, '面包').id, 3);
    await recordCount(db, itemNamed(items, 'U2723QE').id, 0);
    // 清点后：可乐移到上海，面包改成日用品（这次没盘日用品），显示器也移到上海
    await db.runAsync('UPDATE stock_product SET office_id = ? WHERE id = ?', [shanghai, colaId]);
    await db.runAsync("UPDATE stock_product SET kind = 'daily' WHERE name = '面包'");
    await db.runAsync('UPDATE device SET office_id = ? WHERE id = ?', [shanghai, monitorId]);

    const after = await listStocktakeItems(db, id);
    assert.deepEqual(
      after.map((item) => [item.name, item.absence, item.present]),
      [
        ['可乐', 'moved', false],
        ['面包', 'moved', false],
        ['U2723QE', 'moved', false],
      ],
    );
    await assert.rejects(recordCount(db, itemNamed(after, '可乐').id, 5), /移到别的办公点/);
    // 扫序列号也找不到已经移走的设备
    assert.equal(await findStocktakeItemByCode(db, id, 'SN-1'), null);

    const result = await finishStocktake(db, id);
    assert.equal(result.adjustedProducts, 0);
    assert.equal(result.deviceDifferences, 0);
    assert.equal((await listBatches(db, colaId)).reduce((sum, batch) => sum + batch.quantity, 0), 14);
    assert.equal((await listMovements(db, colaId)).filter((movement) => movement.type === 'adjust').length, 0);
  });

  it('两次「完成」同时点：库存只调一次，第二次报「已经结束」', async () => {
    const { db, colaId } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food']);
    const items = await listStocktakeItems(db, id);
    await recordCount(db, itemNamed(items, '可乐').id, 11);
    const [first, second] = await Promise.allSettled([finishStocktake(db, id), finishStocktake(db, id)]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    if (second.status === 'rejected') assert.match(String(second.reason), /已经结束/);
    assert.equal((await listBatches(db, colaId)).reduce((sum, batch) => sum + batch.quantity, 0), 11);
    assert.equal((await listMovements(db, colaId)).filter((movement) => movement.type === 'adjust').length, 1);
    assert.equal((await getStocktake(db, id))?.status, 'done');
  });

  it('完成进行中点了放弃：放弃报错，盘点单是已完成，库存按完成调整', async () => {
    const { db, colaId } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food']);
    const items = await listStocktakeItems(db, id);
    await recordCount(db, itemNamed(items, '可乐').id, 11);
    const finishing = finishStocktake(db, id);
    const cancelling = cancelStocktake(db, id);
    const [finished, cancelled] = await Promise.allSettled([finishing, cancelling]);
    assert.equal(finished.status, 'fulfilled');
    assert.equal(cancelled.status, 'rejected');
    if (cancelled.status === 'rejected') assert.match(String(cancelled.reason), /已经结束/);
    assert.equal((await getStocktake(db, id))?.status, 'done');
    assert.equal((await listBatches(db, colaId)).reduce((sum, batch) => sum + batch.quantity, 0), 11);
    // 已经结束的再放弃、再完成都报错；找不到的盘点单报「找不到」
    await assert.rejects(cancelStocktake(db, id), /已经结束/);
    await assert.rejects(finishStocktake(db, 999), /找不到/);
  });

  it('列出进行中盘点的办公点和分类（导入前提示用）', async () => {
    const { db } = await officeWithStock();
    const shanghai = await createOffice(db, '上海');
    await createProduct(db, product({ officeId: shanghai, name: '上海的可乐' }), { quantity: 1, expiryDate: null });
    await startStocktake(db, 1, ['food', 'daily']);
    const finished = await startStocktake(db, shanghai, ['food']);
    await finishStocktake(db, finished);
    assert.deepEqual(plain(await listOpenStocktakeScopes(db)), [{ officeName: '默认办公点', kinds: ['food', 'daily'] }]);
  });

  it('放弃盘点不改库存', async () => {
    const { db, colaId } = await officeWithStock();
    const id = await startStocktake(db, 1, ['food']);
    const items = await listStocktakeItems(db, id);
    await recordCount(db, itemNamed(items, '可乐').id, 1);
    await cancelStocktake(db, id);
    assert.equal((await getStocktake(db, id))?.status, 'cancelled');
    assert.equal((await listBatches(db, colaId)).reduce((sum, batch) => sum + batch.quantity, 0), 14);
    assert.equal(await getOpenStocktake(db, 1), null);
    // 放弃后可以重新开一次
    assert.ok(await startStocktake(db, 1, ['food']));
  });

  it('导入替换了盘点涉及的分类：进行中的盘点删掉，已结束的保留；不涉及的分类不受影响', async () => {
    const { db } = await officeWithStock();
    const finished = await startStocktake(db, 1, ['food']);
    await finishStocktake(db, finished);
    const openFood = await startStocktake(db, 1, ['food']);

    const source = await openDb();
    await createProduct(source, product({ name: '别处的可乐' }), { quantity: 1, expiryDate: null });
    const file = await collectBackup(source, ['daily', 'devices'], null);
    // 只替换日用品：盘点只涉及食品，保留
    await replaceData(db, file, { scope: ['daily'], offices: ['默认办公点'] });
    assert.equal((await getOpenStocktake(db, 1))?.id, openFood);
    // 替换食品：删掉
    const foodFile = await collectBackup(source, ['food'], null);
    await replaceData(db, foodFile, { scope: ['food'], offices: ['默认办公点'] });
    assert.equal(await getOpenStocktake(db, 1), null);
    assert.equal((await db.getAllAsync('SELECT id FROM stocktake_item WHERE stocktake_id = ?', [openFood])).length, 0);
    assert.equal((await getStocktake(db, finished))?.status, 'done');
  });

  it('撤销导入：进行中的盘点删掉，已结束的挂到重建的同名办公点上', async () => {
    const { db } = await officeWithStock();
    const finished = await startStocktake(db, 1, ['food']);
    await finishStocktake(db, finished);
    await startStocktake(db, 1, ['daily']);
    const snapshot = plain(await collectBackup(db));

    await restoreAll(db, snapshot);
    const [office] = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM office');
    assert.equal(office.name, '默认办公点');
    assert.notEqual(office.id, 1);
    const entries = await listStocktakes(db, office.id);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.status, entry.officeName]),
      [[finished, 'done', '默认办公点']],
    );
  });

  it('删除办公点时一起删掉它的盘点', async () => {
    const db = await openDb();
    const shanghai = await createOffice(db, '上海');
    const productId = await createProduct(db, product({ officeId: shanghai }), { quantity: 1, expiryDate: null });
    const id = await startStocktake(db, shanghai, ['food']);
    await cancelStocktake(db, id);
    await db.runAsync('DELETE FROM stock_batch WHERE product_id = ?', [productId]);
    await db.runAsync('DELETE FROM stock_product WHERE id = ?', [productId]);
    await deleteOffice(db, shanghai);
    assert.equal((await db.getAllAsync('SELECT id FROM stocktake')).length, 0);
    assert.equal((await db.getAllAsync('SELECT id FROM stocktake_item')).length, 0);
  });
});
