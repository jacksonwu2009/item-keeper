/**
 * 使用场景（家庭 / 办公）：叫法、升级和新装的默认值、切到家庭时改默认地点名、备份里的 scene 字段。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import { createOffice, listOffices } from '../src/db/offices';
import { migrateDbIfNeeded } from '../src/db/schema';
import { getScene, saveScene, writeScene } from '../src/db/settings';
import { parseBackup } from '../src/lib/backup';
import { currentTerms, isScene, placeToRenameForHome, setActiveScene, termsFor } from '../src/lib/terms';
import { openDb } from './helpers/memoryDb';

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

  it('切到家庭：只有名字还是「默认办公点」、而且没有「家」时才改', () => {
    assert.equal(placeToRenameForHome(['默认办公点']), '默认办公点');
    assert.equal(placeToRenameForHome(['默认办公点', '家']), null);
    assert.equal(placeToRenameForHome(['上海办公室']), null);
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

  it('选家庭时「默认办公点」改叫「家」；换回办公不改回去', async () => {
    const db = await openDb();
    await saveScene(db, 'home');
    assert.equal(await getScene(db), 'home');
    assert.deepEqual(await officeNames(db), ['家']);
    await saveScene(db, 'office');
    assert.equal(await getScene(db), 'office');
    assert.deepEqual(await officeNames(db), ['家']);
  });

  it('用户改过名的、已经有「家」的都不动', async () => {
    const db = await openDb();
    await createOffice(db, '家');
    await saveScene(db, 'home');
    assert.deepEqual(await officeNames(db), ['默认办公点', '家']);
  });

  it('撤销导入时原样还原，不改名', async () => {
    const db = await openDb();
    await db.withTransactionAsync(() => writeScene(db, 'home', false));
    assert.equal(await getScene(db), 'home');
    assert.deepEqual(await officeNames(db), ['默认办公点']);
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

  it('导入设置时换场景，切到家庭也按规则改默认地点名；旧文件不动本机场景', async () => {
    const source = await openDb();
    await saveScene(source, 'home');
    const file = await collectBackup(source, ['settings']);

    const target = await openDb();
    await saveScene(target, 'office');
    await replaceData(target, file, { scope: ['settings'], offices: [] });
    assert.equal(await getScene(target), 'home');
    assert.deepEqual(await officeNames(target), ['家']);

    const { scene: _drop, ...old } = file;
    await saveScene(target, 'office');
    await replaceData(target, old, { scope: ['settings'], offices: [] });
    assert.equal(await getScene(target), 'office');
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
