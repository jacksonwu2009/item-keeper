/**
 * 人员名单（员工名单 / 家庭成员）：增删改、不重名、改名连领用记录一起改、删除不动领用记录、选人时的过滤、
 * 迁移建表，以及备份里的 people 字段（导出、合并导入、撤销、旧文件）。
 * 办公场景的部门和邮箱：部门增删改（不重名、删了人变成未分部门）、人员的部门和邮箱、按部门分组、v10 升上来，
 * 以及备份里的 departments 和 people[].department / email。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectBackup, replaceData, restoreAll } from '../src/db/backup';
import { createDevice, issueDevice, listAssignments, setDeviceHolder } from '../src/db/devices';
import {
  addDepartment,
  addPerson,
  countAssignmentsNamed,
  countPersons,
  deleteDepartment,
  deletePerson,
  ensurePerson,
  filterPeople,
  findPersonByName,
  groupPeopleByDepartment,
  listDepartments,
  listPersons,
  personSubtitle,
  renameDepartment,
  updatePerson,
  type Person,
} from '../src/db/people';
import { migrateDbIfNeeded } from '../src/db/schema';
import { buildBackup, parseBackup, type BackupData } from '../src/lib/backup';
import { setActiveScene } from '../src/lib/terms';
import { openDb } from './helpers/memoryDb';

type Db = Awaited<ReturnType<typeof openDb>>;

async function names(db: Db): Promise<[string, string | null][]> {
  return (await listPersons(db)).map((person) => [person.name, person.note]);
}

/** 名单里每人的 [姓名, 部门, 邮箱, 备注] */
async function roster(db: Db): Promise<[string, string | null, string | null, string | null][]> {
  return (await listPersons(db)).map((person) => [person.name, person.departmentName, person.email, person.note]);
}

/** 部门和人数 [名称, 人数] */
async function departments(db: Db): Promise<[string, number][]> {
  return (await listDepartments(db)).map((department) => [department.name, department.personCount]);
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
    await db.execAsync('DROP TABLE person; DROP TABLE department; PRAGMA user_version = 9');
    await migrateDbIfNeeded(db);
    assert.equal(await countPersons(db), 0);
    assert.equal((await listAssignments(db, deviceId)).length, 1);
    await addPerson(db, '张三');
    assert.equal(await countPersons(db), 1);
  });
});

describe('备份里的人员名单', () => {
  it('含设备时带上名单（按名单顺序，{ name, email, department, note }）；不含设备时不带', async () => {
    const db = await openDb();
    await addPerson(db, '张三', '行政');
    await addPerson(db, '李四');
    const withDevices = JSON.parse(JSON.stringify(await collectBackup(db, ['devices'])));
    assert.deepEqual(withDevices.people, [
      { name: '张三', email: null, department: null, note: '行政' },
      { name: '李四', email: null, department: null, note: null },
    ]);
    assert.deepEqual(withDevices.departments, []);
    const foodOnly = JSON.parse(JSON.stringify(await collectBackup(db, ['food', 'settings'])));
    assert.equal('people' in foodOnly, false);
    assert.equal('departments' in foodOnly, false);
  });

  it('读文件：导出再读回来一样；旧文件没有名单就不带；不含设备的忽略名单', async () => {
    const db = await openDb();
    await addPerson(db, '张三', '行政');
    const file = JSON.parse(JSON.stringify(await collectBackup(db)));
    const read = parseBackup(JSON.stringify(file));
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.deepEqual(read.data.people, [{ name: '张三', email: null, department: null, note: '行政' }]);
    assert.equal(read.summary.people, 1);
    const { people: _drop, departments: _dropDepartments, ...old } = file;
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
          departments: [],
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

describe('部门', () => {
  it('新建：去首尾空格，按建的顺序排；名称必填、最多 20 个字', async () => {
    const db = await openDb();
    await addDepartment(db, ' 行政部 ');
    await addDepartment(db, 'IT');
    await assert.rejects(addDepartment(db, '   '), /请填写部门名称/);
    await assert.rejects(addDepartment(db, '部'.repeat(21)), /部门名称最多 20 个字/);
    await addDepartment(db, '部'.repeat(20));
    assert.deepEqual(await departments(db), [
      ['行政部', 0],
      ['IT', 0],
      ['部'.repeat(20), 0],
    ]);
  });

  it('同一个库里不重名（去首尾空格、不分大小写），新建、改名都查', async () => {
    const db = await openDb();
    await addDepartment(db, 'IT');
    const hr = await addDepartment(db, '人事部');
    await assert.rejects(addDepartment(db, ' it '), /已经有「IT」这个部门了/);
    await assert.rejects(renameDepartment(db, hr, 'It'), /已经有「IT」这个部门了/);
    await assert.rejects(renameDepartment(db, hr, ' '), /请填写部门名称/);
    // 改自己的大小写可以
    const it = (await listDepartments(db))[0].id;
    await renameDepartment(db, it, 'it');
    assert.deepEqual(await departments(db), [
      ['it', 0],
      ['人事部', 0],
    ]);
  });

  it('改名：人员只存部门编号，跟着显示新名字', async () => {
    const db = await openDb();
    const id = await addDepartment(db, '行政');
    await addPerson(db, '张三', null, { departmentId: id });
    await renameDepartment(db, id, ' 行政部 ');
    assert.deepEqual(await roster(db), [['张三', '行政部', null, null]]);
    assert.deepEqual(await departments(db), [['行政部', 1]]);
  });

  it('删除：这个部门的人变成未分部门，人员和领用记录都不删；返回几个人变了', async () => {
    const db = await openDb();
    const deviceId = await laptop(db);
    const admin = await addDepartment(db, '行政部');
    const it = await addDepartment(db, 'IT');
    await addPerson(db, '张三', '老员工', { departmentId: admin });
    await addPerson(db, '李四', null, { departmentId: admin });
    await addPerson(db, '王五', null, { departmentId: it });
    await issue(db, deviceId, '张三');
    assert.equal(await deleteDepartment(db, admin), 2);
    assert.deepEqual(await departments(db), [['IT', 1]]);
    assert.deepEqual(await roster(db), [
      ['张三', null, null, '老员工'],
      ['李四', null, null, null],
      ['王五', 'IT', null, null],
    ]);
    assert.deepEqual((await listAssignments(db, deviceId)).map((assignment) => assignment.person), ['张三']);
    assert.equal(await deleteDepartment(db, it), 1);
    assert.deepEqual(await departments(db), []);
  });
});

describe('人员的部门和邮箱', () => {
  it('加人时带部门、邮箱：邮箱去首尾空格、存小写；选了已经删掉的部门报错', async () => {
    const db = await openDb();
    const id = await addDepartment(db, '行政部');
    await addPerson(db, '张三', null, { departmentId: id, email: '  ZhangSan@Example.COM ' });
    await addPerson(db, '李四', '实习', { email: '   ' });
    assert.deepEqual(await roster(db), [
      ['张三', '行政部', 'zhangsan@example.com', null],
      ['李四', null, null, '实习'],
    ]);
    await assert.rejects(addPerson(db, '王五', null, { departmentId: 999 }), /这个部门已经删掉了/);
    assert.equal(await countPersons(db), 2);
  });

  it('邮箱要像邮箱（有 @ 和点、没有空格），最多 100 个字', async () => {
    const db = await openDb();
    for (const bad of ['zhangsan', 'zhangsan@example', '@example.com', 'zhang san@example.com', 'a@b@c.com', 'a@b.']) {
      await assert.rejects(addPerson(db, '张三', null, { email: bad }), /邮箱格式不对/, bad);
    }
    await assert.rejects(addPerson(db, '张三', null, { email: `${'a'.repeat(89)}@example.com` }), /邮箱最多 100 个字/);
    await addPerson(db, '张三', null, { email: `${'a'.repeat(88)}@example.com` });
    await addPerson(db, '李四', null, { email: 'li.si@mail.example.cn' });
    assert.equal(await countPersons(db), 2);
  });

  it('邮箱已经是名单里别人的：拦下并说是谁的；自己保存原来的邮箱、改大小写没事', async () => {
    const db = await openDb();
    const zhang = await addPerson(db, '张三', null, { email: 'zhangsan@example.com' });
    const li = await addPerson(db, '李四');
    await assert.rejects(addPerson(db, '王五', null, { email: 'ZhangSan@example.com' }), /这个邮箱已经是「张三」的了/);
    await assert.rejects(updatePerson(db, li, '李四', null, { email: 'zhangsan@example.com' }), /这个邮箱已经是「张三」的了/);
    assert.equal(await updatePerson(db, zhang, '张三', '改备注', { email: 'ZHANGSAN@example.com' }), 0);
    assert.deepEqual(await roster(db), [
      ['张三', null, 'zhangsan@example.com', '改备注'],
      ['李四', null, null, null],
    ]);
  });

  it('改人：换部门、清部门、清邮箱；不传部门、邮箱（家庭场景）就不动', async () => {
    const db = await openDb();
    const admin = await addDepartment(db, '行政部');
    const it = await addDepartment(db, 'IT');
    const id = await addPerson(db, '张三', null, { departmentId: admin, email: 'zs@example.com' });
    await updatePerson(db, id, '张三', null, { departmentId: it });
    assert.deepEqual(await roster(db), [['张三', 'IT', 'zs@example.com', null]]);
    await updatePerson(db, id, '张三丰', '换了名字');
    assert.deepEqual(await roster(db), [['张三丰', 'IT', 'zs@example.com', '换了名字']]);
    await updatePerson(db, id, '张三丰', null, { departmentId: null, email: '' });
    assert.deepEqual(await roster(db), [['张三丰', null, null, null]]);
    await assert.rejects(updatePerson(db, id, '张三丰', null, { departmentId: 999 }), /这个部门已经删掉了/);
  });

  it('登记时勾了「同时加到名单」：加进去的人没有部门、邮箱', async () => {
    const db = await openDb();
    await addDepartment(db, '行政部');
    await ensurePerson(db, '赵六');
    assert.deepEqual(await roster(db), [['赵六', null, null, null]]);
  });

  it('名单页按部门分组：按部门的顺序，没人的部门不列，「未分部门」放最后', async () => {
    const db = await openDb();
    const admin = await addDepartment(db, '行政部');
    await addDepartment(db, '空部门');
    const it = await addDepartment(db, 'IT');
    await addPerson(db, '张三');
    await addPerson(db, '李四', null, { departmentId: it });
    await addPerson(db, '王五', null, { departmentId: admin });
    await addPerson(db, '赵六', null, { departmentId: it });
    const groups = groupPeopleByDepartment(await listPersons(db), await listDepartments(db));
    assert.deepEqual(
      groups.map((group) => [group.title, group.people.map((person) => person.name)]),
      [
        ['行政部', ['王五']],
        ['IT', ['李四', '赵六']],
        ['未分部门', ['张三']],
      ],
    );
    assert.deepEqual(groupPeopleByDepartment([], await listDepartments(db)), []);
  });

  it('列表里姓名下面的灰字：办公「邮箱 · 备注」有哪个写哪个，家庭只有备注', () => {
    assert.equal(personSubtitle({ email: 'zs@example.com', note: '实习' }, true), 'zs@example.com · 实习');
    assert.equal(personSubtitle({ email: 'zs@example.com', note: null }, true), 'zs@example.com');
    assert.equal(personSubtitle({ email: null, note: '实习' }, true), '实习');
    assert.equal(personSubtitle({ email: null, note: null }, true), null);
    assert.equal(personSubtitle({ email: 'zs@example.com', note: '爸爸' }, false), '爸爸');
  });

  it('选人时过滤：姓名、部门名、邮箱、备注都能搜到（不分大小写）', () => {
    const people: Pick<Person, 'name' | 'note' | 'email' | 'departmentName'>[] = [
      { name: '张三', note: null, email: 'zhangsan@example.com', departmentName: '行政部' },
      { name: '李四', note: '研发', email: null, departmentName: 'IT' },
      { name: 'Tom', note: null, email: 'tom@corp.example', departmentName: null },
    ];
    assert.deepEqual(filterPeople(people, '行政').map((person) => person.name), ['张三']);
    assert.deepEqual(filterPeople(people, 'it').map((person) => person.name), ['李四']);
    assert.deepEqual(filterPeople(people, 'ZHANGSAN').map((person) => person.name), ['张三']);
    assert.deepEqual(filterPeople(people, 'example').map((person) => person.name), ['张三', 'Tom']);
    assert.deepEqual(filterPeople(people, '研发').map((person) => person.name), ['李四']);
  });
});

describe('部门的迁移', () => {
  it('从 v10 升上来：原来的人照旧能用，没有部门、邮箱，备注里写的部门不拆出来', async () => {
    const db = await openDb();
    const deviceId = await laptop(db);
    await issue(db, deviceId, '张三');
    // 做一个 v10 的库：person 还没有部门、邮箱两列，也没有部门表
    await db.execAsync(`
      DROP TABLE person;
      DROP TABLE department;
      CREATE TABLE person (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        note TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ux_person_name ON person(name COLLATE NOCASE);
      INSERT INTO person (name, note, sort, created_at, updated_at) VALUES
        ('张三', '行政部', 0, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z'),
        ('李四', NULL, 1, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z');
      PRAGMA user_version = 10;
    `);
    await migrateDbIfNeeded(db);
    assert.deepEqual(await db.getFirstAsync('PRAGMA user_version'), { user_version: 15 });
    assert.deepEqual(await roster(db), [
      ['张三', null, null, '行政部'],
      ['李四', null, null, null],
    ]);
    assert.deepEqual(await departments(db), []);
    // 升上来以后照常用：建部门、分进去、改名连领用记录、删部门
    const admin = await addDepartment(db, '行政部');
    const zhang = (await listPersons(db))[0].id;
    assert.equal(await updatePerson(db, zhang, '张三丰', '行政部', { departmentId: admin, email: 'zs@example.com' }), 1);
    assert.deepEqual(await roster(db), [
      ['张三丰', '行政部', 'zs@example.com', '行政部'],
      ['李四', null, null, null],
    ]);
    assert.equal(await deleteDepartment(db, admin), 1);
    assert.deepEqual((await listAssignments(db, deviceId)).map((assignment) => assignment.person), ['张三丰']);
  });
});

describe('备份里的部门和邮箱', () => {
  async function officeWithDepartments(): Promise<Db> {
    const db = await openDb();
    const admin = await addDepartment(db, '行政部');
    await addDepartment(db, 'IT');
    await addDepartment(db, '还没人的部门');
    await addPerson(db, '张三', null, { departmentId: admin, email: 'zhangsan@example.com' });
    await addPerson(db, '李四', '实习');
    return db;
  }

  it('含设备时带上全部部门（按排序，含还没有人的）和每人的 email、department', async () => {
    const db = await officeWithDepartments();
    const file = JSON.parse(JSON.stringify(await collectBackup(db, ['devices'])));
    assert.deepEqual(file.departments, ['行政部', 'IT', '还没人的部门']);
    assert.deepEqual(file.people, [
      { name: '张三', email: 'zhangsan@example.com', department: '行政部', note: null },
      { name: '李四', email: null, department: null, note: '实习' },
    ]);
  });

  it('读文件：部门、邮箱读回来（邮箱转小写）；旧文件没有 departments、人员没有 email / department 就不带', async () => {
    const db = await officeWithDepartments();
    const file = JSON.parse(JSON.stringify(await collectBackup(db)));
    const read = parseBackup(JSON.stringify(file));
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.deepEqual(read.data.departments, ['行政部', 'IT', '还没人的部门']);
    assert.deepEqual(read.data.people, file.people);
    assert.equal(read.summary.departments, 3);

    const upper = parseBackup(JSON.stringify({ ...file, people: [{ name: '王五', email: ' WangWu@Example.com ' }] }));
    assert.deepEqual(upper.ok && upper.data.people, [{ name: '王五', email: 'wangwu@example.com' }]);

    const { departments: _drop, ...old } = file;
    old.people = [{ name: '张三', note: '行政' }];
    const oldRead = parseBackup(JSON.stringify(old));
    assert.ok(oldRead.ok);
    if (!oldRead.ok) return;
    assert.equal('departments' in oldRead.data, false);
    assert.equal(oldRead.summary.departments, 0);
    assert.deepEqual(oldRead.data.people, [{ name: '张三', note: '行政' }]);

    const noDevices = parseBackup(JSON.stringify({ ...file, scope: ['food'], devices: [] }));
    assert.equal(noDevices.ok && 'departments' in noDevices.data, false);
  });

  it('拒绝：部门重复（不分大小写）、太长、不是文字；人员的部门太长、邮箱不对', async () => {
    const db = await officeWithDepartments();
    const base = JSON.parse(JSON.stringify(await collectBackup(db, ['devices'])));
    const cases: [object, RegExp][] = [
      [{ departments: ['IT', 'it'] }, /部门「it」重复了/],
      [{ departments: ['部'.repeat(21)] }, /部门名称「部+」超过 20 个字/],
      [{ departments: [''] }, /第 1 个部门：缺少名称/],
      [{ departments: 'IT' }, /部门应该是列表/],
      [{ people: [{ name: '张三', department: '部'.repeat(21) }] }, /人员名单第 1 个「张三」：部门「部+」超过 20 个字/],
      [{ people: [{ name: '张三', email: 'zhangsan' }] }, /人员名单第 1 个「张三」：邮箱「zhangsan」格式不对/],
      [{ people: [{ name: '张三', email: `${'a'.repeat(89)}@example.com` }] }, /邮箱超过 100 个字/],
    ];
    for (const [patch, error] of cases) {
      const result = parseBackup(JSON.stringify({ ...base, ...patch }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, error);
    }
  });

  it('导入勾了设备：先按名称合并部门（含没人的，本机多出来的不删），再按姓名合并人员、按部门名对上', async () => {
    const source = await officeWithDepartments();
    await addPerson(source, '王五', null, { email: 'wangwu@example.com' });
    const file = await collectBackup(source);
    // 文件里人员的部门不在 departments 里也照样按名字建
    file.people = [...(file.people ?? []), { name: '赵六', email: null, department: '市场部', note: null }];

    const target = await openDb();
    const it = await addDepartment(target, 'it');
    await addDepartment(target, '财务部');
    await addPerson(target, '李四', '老备注', { departmentId: it, email: 'lisi@example.com' });
    await addPerson(target, '张三', null);
    await addPerson(target, '本机的人', null, { departmentId: it });
    await replaceData(target, file, { scope: ['devices'], offices: ['默认办公点'] });
    assert.deepEqual(await departments(target), [
      ['it', 1],
      ['财务部', 0],
      ['行政部', 1],
      ['还没人的部门', 0],
      ['市场部', 1],
    ]);
    assert.deepEqual(await roster(target), [
      // 文件里写明了 null：部门、邮箱清掉，备注换成文件里的
      ['李四', null, null, '实习'],
      ['张三', '行政部', 'zhangsan@example.com', null],
      ['本机的人', 'it', null, null],
      ['王五', null, 'wangwu@example.com', null],
      ['赵六', '市场部', null, null],
    ]);
  });

  it('导入旧文件：没有 departments 不动部门；人员缺了 department、email 就不改本机的，备注照常更新', async () => {
    const target = await openDb();
    const admin = await addDepartment(target, '行政部');
    await addPerson(target, '张三', '旧备注', { departmentId: admin, email: 'zhangsan@example.com' });
    const source = await openDb();
    const file = await collectBackup(source);
    delete file.departments;
    file.people = [
      { name: '张三', note: '行政' },
      { name: '李四', note: null },
    ];
    await replaceData(target, file, { scope: ['devices'], offices: ['默认办公点'] });
    assert.deepEqual(await departments(target), [['行政部', 1]]);
    assert.deepEqual(await roster(target), [
      ['张三', '行政部', 'zhangsan@example.com', '行政'],
      ['李四', null, null, null],
    ]);
    // 只有部门、没有人员的文件：只合并部门
    const onlyDepartments = await collectBackup(source);
    delete onlyDepartments.people;
    onlyDepartments.departments = ['IT'];
    await replaceData(target, onlyDepartments, { scope: ['devices'], offices: ['默认办公点'] });
    assert.deepEqual(await departments(target), [
      ['行政部', 1],
      ['IT', 0],
    ]);
  });

  it('导入没勾设备：部门、名单都不动', async () => {
    const source = await officeWithDepartments();
    const file = await collectBackup(source);
    const target = await openDb();
    await replaceData(target, file, { scope: ['food'], offices: ['默认办公点'] });
    assert.deepEqual(await departments(target), []);
    assert.equal(await countPersons(target), 0);
  });

  it('撤销导入：部门和名单一起换回留底的那份（含没人的部门，之后建的部门去掉）', async () => {
    const db = await officeWithDepartments();
    const snapshot = await collectBackup(db);
    const extra = await addDepartment(db, '后来建的');
    await renameDepartment(db, (await listDepartments(db))[0].id, '行政中心');
    await addPerson(db, '王五', null, { departmentId: extra });
    const zhang = (await listPersons(db))[0].id;
    await updatePerson(db, zhang, '张三', '改过', { departmentId: null, email: 'other@example.com' });
    await restoreAll(db, snapshot);
    assert.deepEqual(await departments(db), [
      ['行政部', 1],
      ['IT', 0],
      ['还没人的部门', 0],
    ]);
    assert.deepEqual(await roster(db), [
      ['张三', '行政部', 'zhangsan@example.com', null],
      ['李四', null, null, '实习'],
    ]);
  });

  it('撤销导入：留底是老版本的（没有部门、人员没有 department / email）：部门不动，同名的人保留现在的部门和邮箱', async () => {
    const db = await officeWithDepartments();
    const snapshot: BackupData = await collectBackup(db);
    delete snapshot.departments;
    snapshot.people = [
      { name: '张三', note: '老备注' },
      { name: '王五', note: null },
    ];
    await restoreAll(db, snapshot);
    assert.deepEqual(await departments(db), [
      ['行政部', 1],
      ['IT', 0],
      ['还没人的部门', 0],
    ]);
    assert.deepEqual(await roster(db), [
      ['张三', '行政部', 'zhangsan@example.com', '老备注'],
      ['王五', null, null, null],
    ]);
  });
});
