/**
 * 使用场景（家庭 / 办公）：叫法、升级和新装的默认值、切到家庭时改默认地点名、备份里的 scene 字段。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import { createOffice, listOffices } from '../src/db/offices';
import { migrateDbIfNeeded } from '../src/db/schema';
import { chooseInitialScene, getScene, saveScene } from '../src/db/settings';
import { createProduct } from '../src/db/stock';
import { parseBackup } from '../src/lib/backup';
import { currentTerms, isScene, setActiveScene, termsFor } from '../src/lib/terms';
import { openDb } from './helpers/memoryDb';

async function renameSole(db: Awaited<ReturnType<typeof openDb>>, name: string): Promise<void> {
  await db.runAsync('UPDATE office SET name = ? WHERE id = 1', [name]);
}

async function officeNames(db: Awaited<ReturnType<typeof openDb>>): Promise<string[]> {
  return (await listOffices(db)).map((office) => office.name);
}

describe('叫法', () => {
  it('办公叫办公点，家庭叫地点', () => {
    assert.equal(termsFor('office').place, '办公点');
    assert.equal(termsFor('home').place, '地点');
    assert.equal(termsFor('home').defaultPlaceName, '家');
  });

  it('不在组件里的代码按当前场景取叫法，没设过按办公', () => {
    assert.equal(currentTerms().place, '办公点');
    setActiveScene('home');
    assert.equal(currentTerms().place, '地点');
    setActiveScene('office');
    assert.equal(currentTerms().place, '办公点');
  });

  it('只认 home 和 office', () => {
    assert.equal(isScene('home'), true);
    assert.equal(isScene('office'), true);
    assert.equal(isScene('family'), false);
    assert.equal(isScene(null), false);
  });
});

describe('存场景', () => {
  it('新装的没选过（打开时让用户选）', async () => {
    const db = await openDb();
    assert.equal(await getScene(db), null);
  });

  it('从旧版本升级上来的记成办公，界面和以前一样', async () => {
    const db = await openDb();
    await db.runAsync("DELETE FROM setting WHERE key = 'usage.scene'");
    await db.execAsync('PRAGMA user_version = 8');
    await migrateDbIfNeeded(db);
    assert.equal(await getScene(db), 'office');
  });

  it('新装第一次选家庭：空的「默认办公点」改叫「家」；选办公不改', async () => {
    const home = await openDb();
    await chooseInitialScene(home, 'home');
    assert.equal(await getScene(home), 'home');
    assert.deepEqual(await officeNames(home), ['家']);
    const office = await openDb();
    await chooseInitialScene(office, 'office');
    assert.deepEqual(await officeNames(office), ['默认办公点']);
  });

  it('手机上已经有东西、或者不止一个地点时，第一次选家庭也不改名', async () => {
    const withData = await openDb();
    await createProduct(withData, { officeId: 1, kind: 'food', barcode: null, name: '牛奶', brand: null, spec: null, unit: '瓶', location: null, lowStockThreshold: null, expiryLeadDays: null, note: null, packs: [] }, { quantity: 1, expiryDate: null });
    await chooseInitialScene(withData, 'home');
    assert.deepEqual(await officeNames(withData), ['默认办公点']);
    const two = await openDb();
    await createOffice(two, '父母家');
    await chooseInitialScene(two, 'home');
    assert.deepEqual(await officeNames(two), ['默认办公点', '父母家']);
  });

  it('设置里切场景只记场景，地点名一个字都不改', async () => {
    const db = await openDb();
    await saveScene(db, 'home');
    assert.equal(await getScene(db), 'home');
    assert.deepEqual(await officeNames(db), ['默认办公点']);
    await saveScene(db, 'office');
    assert.equal(await getScene(db), 'office');
  });
});

describe('备份里的场景', () => {
  it('导出含设置时带上场景；不含设置、没选过场景时不带', async () => {
    const db = await openDb();
    assert.equal('scene' in (await collectBackup(db, ['food', 'settings'])), false);
    await saveScene(db, 'home');
    assert.equal((await collectBackup(db, ['food', 'settings'])).scene, 'home');
    assert.equal('scene' in (await collectBackup(db, ['food'])), false);
  });

  it('读文件：认得的场景留下，不认得的丢掉，旧文件没有这个字段', async () => {
    const db = await openDb();
    await saveScene(db, 'home');
    const file = JSON.parse(JSON.stringify(await collectBackup(db, ['food', 'settings'])));
    const read = parseBackup(JSON.stringify(file));
    assert.equal(read.ok && read.data.scene, 'home');
    const bad = parseBackup(JSON.stringify({ ...file, scene: 'family' }));
    assert.equal(bad.ok && 'scene' in bad.data, false);
    const { scene: _drop, ...old } = file;
    const oldRead = parseBackup(JSON.stringify(old));
    assert.equal(oldRead.ok && 'scene' in oldRead.data, false);
  });

  it('导入设置时换场景（不改地点名）；旧文件不动本机场景', async () => {
    const source = await openDb();
    await saveScene(source, 'home');
    const file = await collectBackup(source, ['settings']);

    const target = await openDb();
    await saveScene(target, 'office');
    await replaceData(target, file, { scope: ['settings'], offices: [] });
    assert.equal(await getScene(target), 'home');
    assert.deepEqual(await officeNames(target), ['默认办公点']);

    const { scene: _drop, ...old } = file;
    await saveScene(target, 'office');
    await replaceData(target, old, { scope: ['settings'], offices: [] });
    assert.equal(await getScene(target), 'office');
  });

  it('新手机导入：本机只有一个空的系统地点、文件里没有它，就直接换成文件里的地点，不多出一个空的', async () => {
    const oldPhone = await openDb();
    await createProduct(oldPhone, { officeId: 1, kind: 'food', barcode: null, name: '牛奶', brand: null, spec: null, unit: '瓶', location: null, lowStockThreshold: null, expiryLeadDays: null, note: null, packs: [] }, { quantity: 2, expiryDate: null });
    const file = await collectBackup(oldPhone);

    const newPhone = await openDb();
    await chooseInitialScene(newPhone, 'home');
    assert.deepEqual(await officeNames(newPhone), ['家']);
    await replaceData(newPhone, file, { scope: ['food', 'daily', 'devices', 'settings'], offices: ['默认办公点'] });
    const offices = await listOffices(newPhone);
    assert.deepEqual(offices.map((office) => [office.name, office.productCount]), [['默认办公点', 1]]);
  });

  it('本机的地点有东西、或者是自己起的名字，导入时照旧另建', async () => {
    const source = await openDb();
    await createOffice(source, '北京');
    const file = await collectBackup(source, ['food'], [2]);

    const named = await openDb();
    await renameSole(named, '上海');
    await replaceData(named, file, { scope: ['food'], offices: ['北京'] });
    assert.deepEqual(await officeNames(named), ['上海', '北京']);

    const used = await openDb();
    await createProduct(used, { officeId: 1, kind: 'daily', barcode: null, name: '纸巾', brand: null, spec: null, unit: '包', location: null, lowStockThreshold: null, expiryLeadDays: null, note: null, packs: [] }, { quantity: 1, expiryDate: null });
    await replaceData(used, file, { scope: ['food'], offices: ['北京'] });
    assert.deepEqual(await officeNames(used), ['默认办公点', '北京']);
  });

  it('撤销导入换回留底时的场景', async () => {
    const db = await openDb();
    await saveScene(db, 'office');
    const snapshot = await collectBackup(db);
    await saveScene(db, 'home');
    await restoreAll(db, snapshot);
    assert.equal(await getScene(db), 'office');
  });
});
