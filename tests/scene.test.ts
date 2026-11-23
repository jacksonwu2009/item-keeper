/**
 * 使用场景（家庭 / 办公）：叫法、两个场景各用哪个库（升级和新装怎么定）、库第一次以家庭打开时改默认地点名、备份里的 scene 字段。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import { createOffice, listOffices } from '../src/db/offices';
import { migrateDbIfNeeded } from '../src/db/schema';
import {
  initSceneStore,
  readSceneSetup,
  resolveSceneSetup,
  writeCurrentScene,
  writeSceneSetup,
} from '../src/db/sceneStore';
import { getScene, prepareSceneDatabase } from '../src/db/settings';
import { createProduct } from '../src/db/stock';
import { parseBackup } from '../src/lib/backup';
import {
  LEGACY_DATABASE_NAME,
  parseSceneSetup,
  planSceneDatabases,
  sceneOfDatabase,
  undoFileName,
} from '../src/lib/sceneDatabases';
import { currentTerms, isScene, setActiveScene, termsFor, type Scene } from '../src/lib/terms';
import { openDb, openRawDb } from './helpers/memoryDb';

type Db = Awaited<ReturnType<typeof openDb>>;

async function renameSole(db: Db, name: string): Promise<void> {
  await db.runAsync('UPDATE office SET name = ? WHERE id = 1', [name]);
}

async function officeNames(db: Db): Promise<string[]> {
  return (await listOffices(db)).map((office) => office.name);
}

async function addMilk(db: Db, officeId = 1): Promise<void> {
  await createProduct(
    db,
    { officeId, kind: 'food', barcode: null, name: '牛奶', category: null, spec: null, unit: '瓶', location: null, lowStockThreshold: null, expiryLeadDays: null, note: null, packs: [] },
    { quantity: 2, expiryDate: null },
  );
}

async function markScene(db: Db, scene: Scene): Promise<void> {
  await db.runAsync(
    "INSERT INTO setting (key, value) VALUES ('usage.scene', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(scene)],
  );
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

describe('库里记的场景', () => {
  it('新装的没记过（升级时当作新装，先让用户选）', async () => {
    const db = await openDb();
    assert.equal(await getScene(db), null);
  });

  it('从旧版本升级上来的记成办公', async () => {
    const db = await openDb();
    await db.runAsync("DELETE FROM setting WHERE key = 'usage.scene'");
    await db.execAsync('DROP TABLE person; DROP TABLE department; PRAGMA user_version = 8');
    await migrateDbIfNeeded(db);
    assert.equal(await getScene(db), 'office');
  });
});

describe('以某个场景打开库', () => {
  it('家庭场景的库第一次打开、还是空的：「默认办公点」改叫「家」，记上是家庭的', async () => {
    const db = await openDb();
    await prepareSceneDatabase(db, 'home');
    assert.equal(await getScene(db), 'home');
    assert.deepEqual(await officeNames(db), ['家']);
  });

  it('办公场景的库还是「默认办公点」', async () => {
    const db = await openDb();
    await prepareSceneDatabase(db, 'office');
    assert.equal(await getScene(db), 'office');
    assert.deepEqual(await officeNames(db), ['默认办公点']);
  });

  it('库里已经有东西、或者不止一个地点时，以家庭打开也不改名', async () => {
    const withData = await openDb();
    await addMilk(withData);
    await prepareSceneDatabase(withData, 'home');
    assert.deepEqual(await officeNames(withData), ['默认办公点']);
    const two = await openDb();
    await createOffice(two, '父母家');
    await prepareSceneDatabase(two, 'home');
    assert.deepEqual(await officeNames(two), ['默认办公点', '父母家']);
  });

  it('只在第一次以家庭打开时改：之后用户改回「默认办公点」也不再动', async () => {
    const db = await openDb();
    await prepareSceneDatabase(db, 'home');
    await renameSole(db, '默认办公点');
    await prepareSceneDatabase(db, 'home');
    assert.deepEqual(await officeNames(db), ['默认办公点']);
  });

  it('老版本里就是家庭的库（升级后归家庭）：原样打开，地点名不动', async () => {
    const db = await openDb();
    await markScene(db, 'home');
    await prepareSceneDatabase(db, 'home');
    assert.deepEqual(await officeNames(db), ['默认办公点']);
  });
});

describe('两个场景各用哪个库', () => {
  it('现有的库记着办公：办公继续用它，家庭用新的 item-keeper-home.db', () => {
    assert.deepEqual(planSceneDatabases('office'), {
      scene: 'office',
      databases: { office: 'item-keeper.db', home: 'item-keeper-home.db' },
    });
  });

  it('现有的库记着家庭：家庭继续用它，办公用新的 item-keeper-office.db', () => {
    assert.deepEqual(planSceneDatabases('home'), {
      scene: 'home',
      databases: { home: 'item-keeper.db', office: 'item-keeper-office.db' },
    });
  });

  it('新装（现有的库没记场景）：场景留空等用户选，办公 item-keeper.db、家庭 item-keeper-home.db', () => {
    assert.deepEqual(planSceneDatabases(null), {
      scene: null,
      databases: { office: LEGACY_DATABASE_NAME, home: 'item-keeper-home.db' },
    });
  });

  it('读存着的对应关系：两个库名都要有且不一样，场景不认得当作没选过', () => {
    assert.deepEqual(parseSceneSetup({ scene: 'home', 'db.home': 'item-keeper.db', 'db.office': 'item-keeper-office.db' }), {
      scene: 'home',
      databases: { home: 'item-keeper.db', office: 'item-keeper-office.db' },
    });
    assert.deepEqual(parseSceneSetup({ scene: 'family', 'db.home': 'a.db', 'db.office': 'b.db' })?.scene, null);
    assert.equal(parseSceneSetup({}), null);
    assert.equal(parseSceneSetup({ scene: 'home', 'db.home': 'item-keeper.db' }), null);
    assert.equal(parseSceneSetup({ 'db.home': 'same.db', 'db.office': 'same.db' }), null);
    assert.equal(parseSceneSetup({ 'db.home': '../x.db', 'db.office': 'b.db' }), null);
  });

  it('按库文件（或完整路径）认出是哪个场景的', () => {
    const databases = { home: 'item-keeper-home.db', office: 'item-keeper.db' };
    assert.equal(sceneOfDatabase(databases, '/data/files/SQLite/item-keeper-home.db'), 'home');
    assert.equal(sceneOfDatabase(databases, 'item-keeper.db'), 'office');
    assert.equal(sceneOfDatabase(databases, '/data/files/SQLite/other.db'), null);
  });

  it('撤销导入的留底每个库一份；item-keeper.db 还用以前的文件名', () => {
    assert.equal(undoFileName('/data/SQLite/item-keeper.db'), 'before-last-import.json');
    assert.equal(undoFileName('/data/SQLite/item-keeper-home.db'), 'before-last-import-item-keeper-home.json');
    assert.equal(undoFileName('item-keeper-office.db'), 'before-last-import-item-keeper-office.json');
  });
});

describe('记场景的小库', () => {
  async function openStore() {
    const store = openRawDb();
    await initSceneStore(store);
    return store;
  }

  it('第一次启动按现有库记的场景定下来并存好，以后直接读存的、不再看现有库', async () => {
    const store = await openStore();
    let reads = 0;
    const first = await resolveSceneSetup(store, async () => {
      reads++;
      return 'home';
    });
    assert.deepEqual(first, { scene: 'home', databases: { home: 'item-keeper.db', office: 'item-keeper-office.db' } });
    const again = await resolveSceneSetup(store, async () => {
      reads++;
      return 'office';
    });
    assert.deepEqual(again, first);
    assert.equal(reads, 1);
  });

  it('升级：现有库是老版本（迁移时记成办公）→ 办公用它', async () => {
    const legacy = await openDb();
    await addMilk(legacy);
    await legacy.runAsync("DELETE FROM setting WHERE key = 'usage.scene'");
    await legacy.execAsync('DROP TABLE person; DROP TABLE department; PRAGMA user_version = 8');
    const store = await openStore();
    const setup = await resolveSceneSetup(store, async () => {
      await migrateDbIfNeeded(legacy);
      return getScene(legacy);
    });
    assert.deepEqual(setup, { scene: 'office', databases: { office: 'item-keeper.db', home: 'item-keeper-home.db' } });
    // 数据一条没搬：还在现有的库里
    assert.equal((await listOffices(legacy))[0].productCount, 1);
  });

  it('新装：存下对应关系、场景留空；首次选了再记场景', async () => {
    const store = await openStore();
    const setup = await resolveSceneSetup(store, async () => null);
    assert.equal(setup.scene, null);
    assert.deepEqual(await readSceneSetup(store), setup);
    await writeCurrentScene(store, 'home');
    assert.deepEqual(await readSceneSetup(store), { ...setup, scene: 'home' });
  });

  it('切换只换当前场景，对应关系不变', async () => {
    const store = await openStore();
    const setup = await resolveSceneSetup(store, async () => 'office');
    await writeSceneSetup(store, { ...setup, scene: 'home' });
    assert.deepEqual(await readSceneSetup(store), { scene: 'home', databases: setup.databases });
    await writeSceneSetup(store, { ...setup, scene: 'office' });
    assert.equal((await readSceneSetup(store))?.scene, 'office');
  });

  it('读现有库出错：往外抛，什么都不存（下次启动再定，别把老用户当成新装）', async () => {
    const store = await openStore();
    await assert.rejects(
      resolveSceneSetup(store, async () => {
        throw new Error('打不开');
      }),
    );
    assert.equal(await readSceneSetup(store), null);
  });
});

describe('备份里的场景', () => {
  it('导出时总是写场景（不管选了哪些分类）', async () => {
    const db = await openDb();
    await prepareSceneDatabase(db, 'home');
    assert.equal((await collectBackup(db, ['food'])).scene, 'home');
    assert.equal((await collectBackup(db, ['food', 'settings'])).scene, 'home');
    // 库里没记过时按当前场景
    const unmarked = await openDb();
    setActiveScene('office');
    assert.equal((await collectBackup(unmarked, ['devices'])).scene, 'office');
  });

  it('读文件：认得的场景留下（不管有没有设置），不认得的丢掉，旧文件没有这个字段', async () => {
    const db = await openDb();
    await prepareSceneDatabase(db, 'home');
    const file = JSON.parse(JSON.stringify(await collectBackup(db, ['food'])));
    const read = parseBackup(JSON.stringify(file));
    assert.equal(read.ok && read.data.scene, 'home');
    const bad = parseBackup(JSON.stringify({ ...file, scene: 'family' }));
    assert.equal(bad.ok && 'scene' in bad.data, false);
    const { scene: _drop, ...old } = file;
    const oldRead = parseBackup(JSON.stringify(old));
    assert.equal(oldRead.ok && 'scene' in oldRead.data, false);
  });

  it('导入不按文件改场景：家庭导出的设置导进办公的库，库还是办公的，地点名不动', async () => {
    const source = await openDb();
    await prepareSceneDatabase(source, 'home');
    const file = await collectBackup(source, ['settings']);
    assert.equal(file.scene, 'home');

    const target = await openDb();
    await prepareSceneDatabase(target, 'office');
    await replaceData(target, file, { scope: ['settings'], offices: [] });
    assert.equal(await getScene(target), 'office');
    assert.deepEqual(await officeNames(target), ['默认办公点']);
  });

  it('新手机导入：本机只有一个空的系统地点、文件里没有它，就直接换成文件里的地点，不多出一个空的', async () => {
    const oldPhone = await openDb();
    await addMilk(oldPhone);
    const file = await collectBackup(oldPhone);

    const newPhone = await openDb();
    await prepareSceneDatabase(newPhone, 'home');
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
    await createProduct(used, { officeId: 1, kind: 'daily', barcode: null, name: '纸巾', category: null, spec: null, unit: '包', location: null, lowStockThreshold: null, expiryLeadDays: null, note: null, packs: [] }, { quantity: 1, expiryDate: null });
    await replaceData(used, file, { scope: ['food'], offices: ['北京'] });
    assert.deepEqual(await officeNames(used), ['默认办公点', '北京']);
  });

  it('撤销导入只换数据，库记的场景不变（留底里写的场景不管）', async () => {
    const db = await openDb();
    await prepareSceneDatabase(db, 'office');
    const snapshot = { ...(await collectBackup(db)), scene: 'home' as const };
    await restoreAll(db, snapshot);
    assert.equal(await getScene(db), 'office');
  });
});
