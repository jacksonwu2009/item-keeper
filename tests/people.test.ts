/**
 * 人员名单（员工名单 / 家庭成员）：增删改、不重名、改名连领用记录一起改、删除不动领用记录、选人时的过滤、
 * 迁移建表，以及备份里的 people 字段（导出、合并导入、撤销、旧文件）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import { createDevice, issueDevice, listAssignments, setDeviceHolder } from '../src/db/devices';
import {
  addPerson,
  countAssignmentsNamed,
  countPersons,
  deletePerson,
  ensurePerson,
  filterPeople,
  findPersonByName,
  listPersons,
  updatePerson,
} from '../src/db/people';
import { migrateDbIfNeeded } from '../src/db/schema';
import { buildBackup, parseBackup, type BackupData } from '../src/lib/backup';
import { setActiveScene } from '../src/lib/terms';
import { openDb } from './helpers/memoryDb';

type Db = Awaited<ReturnType<typeof openDb>>;

async function names(db: Db): Promise<[string, string | null][]> {
  return (await listPersons(db)).map((person) => [person.name, person.note]);
}

async function laptop(db: Db, quantity = 3): Promise<number> {
  return createDevice(db, {
    officeId: 1,
    category: '笔记本',
    name: 'MacBook Air',
    model: null,
    serialNo: null,
    quantity,
    note: null,
    purchaseDate: null,
    warrantyUntil: null,
    invoiceNo: null,
    chip: null,
    memory: null,
    storage: null,
    accessories: [],
  });
}

async function issue(db: Db, deviceId: number, person: string, returnedOn: string | null = null): Promise<void> {
  await issueDevice(db, deviceId, { person, quantity: 1, issuedOn: '2026-11-01', returnedOn, note: null });
}

describe('人员名单：增删改', () => {
  it('加人：去掉首尾空格，按加的顺序排；备注选填', async () => {
    const db = await openDb();
    await addPerson(db, '  张三 ', ' 行政 ');
    await addPerson(db, '李四');
    await addPerson(db, '王五', '   ');
    assert.deepEqual(await names(db), [
      ['张三', '行政'],
      ['李四', null],
      ['王五', null],
    ]);
    assert.equal(await countPersons(db), 3);
  });

  it('姓名必填、最多 20 个字，备注最多 100 字', async () => {
    const db = await openDb();
    await assert.rejects(addPerson(db, '   '), /请填写姓名/);
    await assert.rejects(addPerson(db, '一'.repeat(21)), /姓名最多 20 个字/);
    await assert.rejects(addPerson(db, '张三', '注'.repeat(101)), /备注最多 100 个字/);
    await addPerson(db, '一'.repeat(20), '注'.repeat(100));
    assert.equal(await countPersons(db), 1);
  });

  it('同一个库里不能重名（不分大小写）', async () => {
    const db = await openDb();
    setActiveScene('office');
    await addPerson(db, 'Tom');
    await assert.rejects(addPerson(db, ' tom '), /员工名单里已经有「Tom」了/);
    setActiveScene('home');
    await assert.rejects(addPerson(db, 'TOM'), /家庭成员里已经有「Tom」了/);
    setActiveScene('office');
    await addPerson(db, 'Tommy');
    assert.equal(await countPersons(db), 2);
  });

  it('改名：领用记录里同名的（含已退还的）一起改成新名字，别人的不动', async () => {
    const db = await openDb();
    const deviceId = await laptop(db);
    const id = await addPerson(db, '张三');
    await issue(db, deviceId, '张三');
    await issue(db, deviceId, '张三', '2026-11-10');
    await issue(db, deviceId, '李四');
    assert.equal(await countAssignmentsNamed(db, '张三'), 2);

    const renamed = await updatePerson(db, id, '张三丰', '研发');
    assert.equal(renamed, 2);
    assert.deepEqual(await names(db), [['张三丰', '研发']]);
    const people = (await listAssignments(db, deviceId)).map((assignment) => assignment.person).sort();
    assert.deepEqual(people, ['张三丰', '张三丰', '李四'].sort());
    assert.equal(await countAssignmentsNamed(db, '张三'), 0);
  });

  it('只改备注、或者只改大小写也行；改成名单里别人的名字不行', async () => {
    const db = await openDb();
    const deviceId = await laptop(db);
    const tom = await addPerson(db, 'tom');
    await addPerson(db, '李四');
    await issue(db, deviceId, 'tom');
    assert.equal(await updatePerson(db, tom, 'tom', '新备注'), 0);
    assert.equal(await updatePerson(db, tom, 'Tom', '新备注'), 1);
    assert.deepEqual((await listAssignments(db, deviceId)).map((assignment) => assignment.person), ['Tom']);
    await assert.rejects(updatePerson(db, tom, '李四', null), /已经有「李四」了/);
    assert.deepEqual(await names(db), [
      ['Tom', '新备注'],
      ['李四', null],
    ]);
  });

  it('删除只从名单里删，已有的领用记录不动', async () => {
    const db = await openDb();
    const deviceId = await laptop(db);
    const id = await addPerson(db, '张三');
    await issue(db, deviceId, '张三');
    await deletePerson(db, id);
    assert.equal(await countPersons(db), 0);
    assert.deepEqual((await listAssignments(db, deviceId)).map((assignment) => assignment.person), ['张三']);
  });

  it('登记时勾了「同时加到名单」：没有才加，有了（不分大小写）什么都不做', async () => {
    const db = await openDb();
    await addPerson(db, 'Tom');
    await ensurePerson(db, ' tom ');
    await ensurePerson(db, '妈妈');
    assert.deepEqual(await names(db), [
      ['Tom', null],
      ['妈妈', null],
    ]);
    // 家庭场景的「谁在用」也是同一份名单：记了谁在用、再顺手加进家庭成员
    const deviceId = await laptop(db, 1);
    await setDeviceHolder(db, deviceId, '爸爸', '2026-11-20');
    await ensurePerson(db, '爸爸');
    assert.equal(await countPersons(db), 3);
  });
});

describe('选人时', () => {
  const roster = [
    { name: '张三', note: '行政' },
    { name: '李四', note: '研发' },
    { name: 'Tom', note: null },
  ];

  it('按输入的字过滤：姓名或备注包含，不分大小写；没输入全列', () => {
    assert.deepEqual(filterPeople(roster, '').map((person) => person.name), ['张三', '李四', 'Tom']);
    assert.deepEqual(filterPeople(roster, '研').map((person) => person.name), ['李四']);
    assert.deepEqual(filterPeople(roster, 'to').map((person) => person.name), ['Tom']);
    assert.deepEqual(filterPeople(roster, '王').map((person) => person.name), []);
  });

  it('名单里有没有这个名字：去首尾空格、不分大小写', () => {
    assert.equal(findPersonByName(roster, ' tom ')?.name, 'Tom');
    assert.equal(findPersonByName(roster, '王五'), undefined);
    assert.equal(findPersonByName(roster, '  '), undefined);
  });
});

describe('名单表的迁移', () => {
  it('从 v9 升上来建好空的名单表，原来的数据不动', async () => {
    const db = await openDb();
    const deviceId = await laptop(db);
    await issue(db, deviceId, '张三');
    await db.execAsync('DROP TABLE person; PRAGMA user_version = 9');
    await migrateDbIfNeeded(db);
    assert.equal(await countPersons(db), 0);
    assert.equal((await listAssignments(db, deviceId)).length, 1);
    await addPerson(db, '张三');
    assert.equal(await countPersons(db), 1);
  });
});

describe('备份里的人员名单', () => {
  it('含设备时带上名单（按名单顺序，{ name, note }）；不含设备时不带', async () => {
    const db = await openDb();
    await addPerson(db, '张三', '行政');
    await addPerson(db, '李四');
    const withDevices = JSON.parse(JSON.stringify(await collectBackup(db, ['devices'])));
    assert.deepEqual(withDevices.people, [
      { name: '张三', note: '行政' },
      { name: '李四', note: null },
    ]);
    const foodOnly = JSON.parse(JSON.stringify(await collectBackup(db, ['food', 'settings'])));
    assert.equal('people' in foodOnly, false);
  });

  it('读文件：导出再读回来一样；旧文件没有名单就不带；不含设备的忽略名单', async () => {
    const db = await openDb();
    await addPerson(db, '张三', '行政');
    const file = JSON.parse(JSON.stringify(await collectBackup(db)));
    const read = parseBackup(JSON.stringify(file));
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.deepEqual(read.data.people, [{ name: '张三', note: '行政' }]);
    assert.equal(read.summary.people, 1);
    const { people: _drop, ...old } = file;
    const oldRead = parseBackup(JSON.stringify(old));
    assert.equal(oldRead.ok && 'people' in oldRead.data, false);
    assert.equal(oldRead.ok && oldRead.summary.people, 0);
    const noDevices = parseBackup(JSON.stringify({ ...file, scope: ['food'], devices: [] }));
    assert.equal(noDevices.ok && 'people' in noDevices.data, false);
  });

  it('拒绝：名单里没写姓名、姓名太长、备注太长、重名', () => {
    const base = JSON.parse(
      JSON.stringify(
        buildBackup({
          settings: undefined as never,
          scene: 'office',
          offices: [{ id: 1, name: '北京' }],
          products: [],
          packs: [],
          batches: [],
          movements: [],
          devices: [],
          accessories: [],
          assignments: [],
          people: [],
        }, new Date('2026-11-23T00:00:00.000Z'), ['devices']),
      ),
    );
    const cases: [unknown, RegExp][] = [
      [[{ note: '行政' }], /人员名单第 1 个：缺少姓名/],
      [[{ name: '一'.repeat(21) }], /超过 20 个字/],
      [[{ name: '张三', note: '注'.repeat(101) }], /备注超过 100 个字/],
      [[{ name: 'Tom' }, { name: 'tom' }], /人员名单里「tom」重复了/],
      [{ name: '张三' }, /人员名单应该是列表/],
    ];
    for (const [people, error] of cases) {
      const result = parseBackup(JSON.stringify({ ...base, people }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, error);
    }
  });

  it('导入勾了设备：按姓名合并（没有的加上、有的更新备注，本机多出来的不删）', async () => {
    const source = await openDb();
    await addPerson(source, '张三', '行政部');
    await addPerson(source, 'Tom', null);
    await addPerson(source, '王五', '财务');
    const file = await collectBackup(source);

    const target = await openDb();
    await addPerson(target, '李四', '研发');
    await addPerson(target, '张三', '行政');
    await addPerson(target, 'tom', '老备注');
    await replaceData(target, file, { scope: ['devices'], offices: ['默认办公点'] });
    assert.deepEqual(await names(target), [
      ['李四', '研发'],
      ['张三', '行政部'],
      ['tom', null],
      ['王五', '财务'],
    ]);
  });

  it('导入没勾设备、或者旧文件没有名单：名单不动', async () => {
    const source = await openDb();
    await addPerson(source, '张三', '行政');
    const file = await collectBackup(source);

    const target = await openDb();
    await addPerson(target, '李四');
    await replaceData(target, file, { scope: ['food'], offices: ['默认办公点'] });
    assert.deepEqual(await names(target), [['李四', null]]);

    const old: BackupData = { ...file };
    delete old.people;
    await replaceData(target, old, { scope: ['devices'], offices: ['默认办公点'] });
    assert.deepEqual(await names(target), [['李四', null]]);
  });

  it('撤销导入：名单换回留底的那份；留底里没有名单（老版本留的）就不动', async () => {
    const db = await openDb();
    await addPerson(db, '李四', '研发');
    const snapshot = await collectBackup(db);
    await addPerson(db, '张三');
    await addPerson(db, '王五');
    await restoreAll(db, snapshot);
    assert.deepEqual(await names(db), [['李四', '研发']]);

    const oldSnapshot: BackupData = { ...snapshot };
    delete oldSnapshot.people;
    await addPerson(db, '赵六');
    await restoreAll(db, oldSnapshot);
    assert.deepEqual(await names(db), [
      ['李四', '研发'],
      ['赵六', null],
    ]);
  });
});
