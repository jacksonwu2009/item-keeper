import type { SQLiteDatabase } from 'expo-sqlite';

import { currentTerms } from '../lib/terms';

/**
 * 人员名单（办公场景叫员工名单，家庭场景叫家庭成员；每个场景的库各一份）。
 * 登记领用、记谁在用时从名单里选，领用记录里存的还是名字（device_assignment.person），名单外的人也能直接填。
 * 姓名去掉首尾空格后在同一个库里不能重名（不分大小写）。
 * 办公场景的员工还可以分部门（department 表，人员只存部门编号）、记邮箱；家庭场景的界面不显示这两项。
 */
export const PERSON_NAME_MAX = 20;
export const PERSON_NOTE_MAX = 100;
export const PERSON_EMAIL_MAX = 100;
export const DEPARTMENT_NAME_MAX = 20;
/** 名单页里没有部门的人那一组的标题（放在最后） */
export const NO_DEPARTMENT_LABEL = '未分部门';

export type Person = {
  id: number;
  name: string;
  /** 选填 */
  note: string | null;
  /** 邮箱（办公场景填），存的是小写 */
  email: string | null;
  departmentId: number | null;
  /** 部门名，没有部门为 null */
  departmentName: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
};

export type Department = {
  id: number;
  name: string;
  sort: number;
  createdAt: string;
  /** 这个部门有几个人 */
  personCount: number;
};

/**
 * 备份文件里的写法（lib/backup.ts 的 people，鸿蒙版一样）。导出时四项都写（没有的写 null）；
 * 读文件时缺了的项是 undefined：合并进名单时不动本机这一项，明确写 null 的清空。
 */
export type PersonEntry = { name: string; email?: string | null; department?: string | null; note?: string | null };

/** 加人、改人时的部门和邮箱：不给（undefined）就不动——家庭场景不显示这两项，改名、改备注时不会把它们清掉 */
export type PersonDetails = { departmentId?: number | null; email?: string | null };

type PersonRow = { name: string; note: string | null; email: string | null; departmentId: number | null };

const COLUMNS = `p.id, p.name, p.note, p.email, p.department_id AS departmentId, d.name AS departmentName, p.sort,
  p.created_at AS createdAt, p.updated_at AS updatedAt`;

function nowIso(): string {
  return new Date().toISOString();
}

/** 比较姓名、部门名用：去首尾空格、不分大小写 */
export function personKey(name: string): string {
  return name.trim().toLowerCase();
}

/** 名单里叫这个名字的人（不分大小写）；没有返回 undefined。部门按名称找也用它 */
export function findPersonByName<T extends { name: string }>(people: readonly T[], name: string): T | undefined {
  const key = personKey(name);
  return key ? people.find((person) => personKey(person.name) === key) : undefined;
}

/** 选人时按输入的字过滤：姓名、部门名、邮箱、备注里包含（不分大小写）；没输入时全列出 */
export function filterPeople<T extends { name: string; note: string | null; email?: string | null; departmentName?: string | null }>(
  people: readonly T[],
  query: string,
): T[] {
  const key = personKey(query);
  if (!key) return [...people];
  return people.filter((person) =>
    [person.name, person.departmentName, person.email, person.note].some((text) => !!text?.toLowerCase().includes(key)),
  );
}

export type DepartmentGroup = {
  /** 部门编号；最后那组「未分部门」为 null */
  departmentId: number | null;
  title: string;
  people: Person[];
};

/** 名单页按部门分组：按部门的顺序，没人的部门不列；没有部门的放最后一组「未分部门」 */
export function groupPeopleByDepartment(
  people: readonly Person[],
  departments: readonly { id: number; name: string }[],
): DepartmentGroup[] {
  const known = new Set(departments.map((department) => department.id));
  const groups: DepartmentGroup[] = departments
    .map((department) => ({
      departmentId: department.id,
      title: department.name,
      people: people.filter((person) => person.departmentId === department.id),
    }))
    .filter((group) => group.people.length > 0);
  const unassigned = people.filter((person) => person.departmentId === null || !known.has(person.departmentId));
  if (unassigned.length) groups.push({ departmentId: null, title: NO_DEPARTMENT_LABEL, people: unassigned });
  return groups;
}

/** 列表里姓名下面那行灰字：办公场景「邮箱 · 备注」（有哪个写哪个），家庭场景只有备注 */
export function personSubtitle(person: Pick<Person, 'note' | 'email'>, withEmail: boolean): string | null {
  const parts = withEmail ? [person.email, person.note] : [person.note];
  return parts.filter((part): part is string => !!part).join(' · ') || null;
}

/** 校验并整理姓名、备注；不对时抛错，错误信息直接给用户看 */
export function cleanPerson(name: string, note: string | null | undefined): { name: string; note: string | null } {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('请填写姓名');
  if (cleanName.length > PERSON_NAME_MAX) throw new Error(`姓名最多 ${PERSON_NAME_MAX} 个字`);
  const cleanNote = note?.trim() ? note.trim() : null;
  if (cleanNote && cleanNote.length > PERSON_NOTE_MAX) throw new Error(`备注最多 ${PERSON_NOTE_MAX} 个字`);
  return { name: cleanName, note: cleanNote };
}

/** 像不像邮箱：@ 前后都有字、@ 后面有点、没有空格 */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/** 校验并整理邮箱：去首尾空格、转小写，空的为 null；不像邮箱、太长时抛错 */
export function cleanEmail(email: string | null | undefined): string | null {
  const clean = email?.trim().toLowerCase() ?? '';
  if (!clean) return null;
  if (clean.length > PERSON_EMAIL_MAX) throw new Error(`邮箱最多 ${PERSON_EMAIL_MAX} 个字`);
  if (!looksLikeEmail(clean)) throw new Error('邮箱格式不对，应该像 name@example.com');
  return clean;
}

export async function listPersons(db: SQLiteDatabase): Promise<Person[]> {
  return db.getAllAsync<Person>(
    `SELECT ${COLUMNS} FROM person p LEFT JOIN department d ON d.id = p.department_id ORDER BY p.sort, p.id`,
  );
}

export async function countPersons(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM person');
  return row?.n ?? 0;
}

async function assertNameFree(db: SQLiteDatabase, name: string, exceptId?: number): Promise<void> {
  const rows = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM person');
  const existing = findPersonByName(
    rows.filter((row) => row.id !== exceptId),
    name,
  );
  if (existing) throw new Error(`${currentTerms().roster}里已经有「${existing.name}」了`);
}

/** 邮箱不要求唯一，但名单里别人已经用了这个邮箱时拦下（多半是同一个人加了两次） */
async function assertEmailFree(db: SQLiteDatabase, email: string | null, exceptId?: number): Promise<void> {
  if (!email) return;
  const owner = await db.getFirstAsync<{ name: string }>(
    'SELECT name FROM person WHERE email = ? COLLATE NOCASE AND id != ? ORDER BY sort, id',
    [email, exceptId ?? -1],
  );
  if (owner) throw new Error(`这个邮箱已经是「${owner.name}」的了`);
}

async function assertDepartmentExists(db: SQLiteDatabase, departmentId: number | null): Promise<void> {
  if (departmentId === null) return;
  const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM department WHERE id = ?', [departmentId]);
  if (!row) throw new Error('这个部门已经删掉了，请重新选');
}

async function insertPerson(db: SQLiteDatabase, entry: PersonRow): Promise<number> {
  const now = nowIso();
  const result = await db.runAsync(
    `INSERT INTO person (name, note, email, department_id, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM person), ?, ?)`,
    [entry.name, entry.note, entry.email, entry.departmentId, now, now],
  );
  return result.lastInsertRowId;
}

/** 加到名单最后面。重名、太长、邮箱不对或者已经是别人的时抛错 */
export async function addPerson(
  db: SQLiteDatabase,
  name: string,
  note: string | null = null,
  details: PersonDetails = {},
): Promise<number> {
  const entry = cleanPerson(name, note);
  const email = cleanEmail(details.email);
  const departmentId = details.departmentId ?? null;
  await assertNameFree(db, entry.name);
  await assertEmailFree(db, email);
  await assertDepartmentExists(db, departmentId);
  return insertPerson(db, { ...entry, email, departmentId });
}

/** 领用记录（家庭场景是「谁在用」记录）里写着这个名字的有几条（不分大小写），改名前告诉用户会一起改几条 */
export async function countAssignmentsNamed(db: SQLiteDatabase, name: string): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM device_assignment WHERE person = ? COLLATE NOCASE',
    [name.trim()],
  );
  return row?.n ?? 0;
}

/**
 * 改姓名、备注（办公场景还有部门、邮箱；details 里不给的不动）。
 * 改了名字时，领用记录里写着原来名字的（不分大小写）也一起改成新名字。返回一起改了几条领用记录。
 * 邮箱改了、而且名单里别人已经用了时拦下；没改的不查（导入进来的重复邮箱不妨碍改备注）。
 */
export async function updatePerson(
  db: SQLiteDatabase,
  id: number,
  name: string,
  note: string | null,
  details: PersonDetails = {},
): Promise<number> {
  const existing = await db.getFirstAsync<Person>(
    `SELECT ${COLUMNS} FROM person p LEFT JOIN department d ON d.id = p.department_id WHERE p.id = ?`,
    [id],
  );
  if (!existing) throw new Error(`这个人已经不在${currentTerms().roster}里了`);
  const entry = cleanPerson(name, note);
  const email = details.email === undefined ? existing.email : cleanEmail(details.email);
  const departmentId = details.departmentId === undefined ? existing.departmentId : details.departmentId;
  await assertNameFree(db, entry.name, id);
  if (email !== existing.email) await assertEmailFree(db, email, id);
  if (departmentId !== existing.departmentId) await assertDepartmentExists(db, departmentId);
  let renamed = 0;
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE person SET name = ?, note = ?, email = ?, department_id = ?, updated_at = ? WHERE id = ?', [
      entry.name,
      entry.note,
      email,
      departmentId,
      nowIso(),
      id,
    ]);
    if (entry.name !== existing.name) {
      const result = await db.runAsync('UPDATE device_assignment SET person = ? WHERE person = ? COLLATE NOCASE', [
        entry.name,
        existing.name,
      ]);
      renamed = result.changes;
    }
  });
  return renamed;
}

/** 只从名单里删，已有的领用记录不动 */
export async function deletePerson(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM person WHERE id = ?', [id]);
}

/**
 * 登记领用、记谁在用时勾了「同时加到名单」：名单里还没有（不分大小写）就加上（没有部门、邮箱，以后在名单里补），
 * 有了什么都不做。名字太长（超过 20 个字）时抛错。
 */
export async function ensurePerson(db: SQLiteDatabase, name: string): Promise<void> {
  const entry = cleanPerson(name, null);
  const rows = await db.getAllAsync<{ name: string }>('SELECT name FROM person');
  if (findPersonByName(rows, entry.name)) return;
  await insertPerson(db, { ...entry, email: null, departmentId: null });
}

// ---------- 部门（办公场景的员工名单用） ----------

/** 校验并整理部门名称；不对时抛错，错误信息直接给用户看 */
export function cleanDepartmentName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error('请填写部门名称');
  if (clean.length > DEPARTMENT_NAME_MAX) throw new Error(`部门名称最多 ${DEPARTMENT_NAME_MAX} 个字`);
  return clean;
}

/** 全部部门（按排序）和各自的人数 */
export async function listDepartments(db: SQLiteDatabase): Promise<Department[]> {
  return db.getAllAsync<Department>(
    `SELECT d.id, d.name, d.sort, d.created_at AS createdAt,
            (SELECT COUNT(*) FROM person p WHERE p.department_id = d.id) AS personCount
       FROM department d ORDER BY d.sort, d.id`,
  );
}

async function assertDepartmentNameFree(db: SQLiteDatabase, name: string, exceptId?: number): Promise<void> {
  const rows = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM department');
  const existing = findPersonByName(
    rows.filter((row) => row.id !== exceptId),
    name,
  );
  if (existing) throw new Error(`已经有「${existing.name}」这个部门了`);
}

async function insertDepartment(db: SQLiteDatabase, name: string): Promise<number> {
  const result = await db.runAsync(
    `INSERT INTO department (name, sort, created_at)
     VALUES (?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM department), ?)`,
    [name, nowIso()],
  );
  return result.lastInsertRowId;
}

/** 新建部门（排在最后面），返回编号。重名（不分大小写）、太长时抛错 */
export async function addDepartment(db: SQLiteDatabase, name: string): Promise<number> {
  const clean = cleanDepartmentName(name);
  await assertDepartmentNameFree(db, clean);
  return insertDepartment(db, clean);
}

/** 部门改名：人员只存部门编号，不用改人员 */
export async function renameDepartment(db: SQLiteDatabase, id: number, name: string): Promise<void> {
  const clean = cleanDepartmentName(name);
  const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM department WHERE id = ?', [id]);
  if (!existing) throw new Error('这个部门已经删掉了');
  await assertDepartmentNameFree(db, clean, id);
  await db.runAsync('UPDATE department SET name = ? WHERE id = ?', [clean, id]);
}

/** 删除部门：这个部门的人改成未分部门（人员、领用记录都不删）。返回有几个人变成了未分部门 */
export async function deleteDepartment(db: SQLiteDatabase, id: number): Promise<number> {
  let unassigned = 0;
  await db.withTransactionAsync(async () => {
    const result = await db.runAsync('UPDATE person SET department_id = NULL, updated_at = ? WHERE department_id = ?', [
      nowIso(),
      id,
    ]);
    unassigned = result.changes;
    await db.runAsync('DELETE FROM department WHERE id = ?', [id]);
  });
  return unassigned;
}

// ---------- 备份：导入时合并、撤销时换回 ----------

/** 部门名（不分大小写）→ 编号 */
async function departmentIdsByName(db: SQLiteDatabase): Promise<Map<string, number>> {
  const rows = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM department');
  return new Map(rows.map((row) => [personKey(row.name), row.id]));
}

/** 按名称找部门，没有就建在最后面；ids 是 departmentIdsByName 的结果，建了的补进去 */
async function departmentIdFor(db: SQLiteDatabase, name: string, ids: Map<string, number>): Promise<number> {
  const key = personKey(name);
  const known = ids.get(key);
  if (known !== undefined) return known;
  const id = await insertDepartment(db, name.trim());
  ids.set(key, id);
  return id;
}

/** 文件里的邮箱：缺了还是 undefined（不动），其余去空格、转小写，空的为 null */
function importedEmail(email: string | null | undefined): string | null | undefined {
  if (email === undefined) return undefined;
  return email?.trim().toLowerCase() || null;
}

/**
 * 导入备份（勾了设备）时合并部门和名单，本机多出来的部门、人都不删：
 * 先按名称合并部门（没有的加上）；再按姓名合并人员（没有的加上，有的用文件里的邮箱、部门、备注覆盖——
 * 文件里缺了的项不动，明确为 null 的清空）。人员的部门按名称对上，文件的部门列表里没有的也照样按名字建。
 * 不开事务：在导入的事务里调。
 */
export async function mergeRoster(
  db: SQLiteDatabase,
  departments: readonly string[] | undefined,
  people: readonly PersonEntry[] | undefined,
): Promise<void> {
  const ids = await departmentIdsByName(db);
  for (const name of departments ?? []) await departmentIdFor(db, name, ids);
  if (!people) return;
  const rows = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM person');
  for (const person of people) {
    const email = importedEmail(person.email);
    const departmentId =
      person.department === undefined
        ? undefined
        : person.department === null
          ? null
          : await departmentIdFor(db, person.department, ids);
    const existing = findPersonByName(rows, person.name);
    if (!existing) {
      const name = person.name.trim();
      const id = await insertPerson(db, { name, note: person.note ?? null, email: email ?? null, departmentId: departmentId ?? null });
      rows.push({ id, name });
      continue;
    }
    const changes: [string, string | number | null][] = [];
    if (person.note !== undefined) changes.push(['note', person.note]);
    if (email !== undefined) changes.push(['email', email]);
    if (departmentId !== undefined) changes.push(['department_id', departmentId]);
    if (!changes.length) continue;
    await db.runAsync(`UPDATE person SET ${changes.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
      ...changes.map(([, value]) => value),
      nowIso(),
      existing.id,
    ]);
  }
}

/**
 * 撤销导入：部门和名单整个换回留底的那份（按留底里的顺序）。留底里没有的（老版本留的）不动：
 * 没有部门列表就不动部门；人员缺了哪一项（老版本的留底没有部门、邮箱）就保留本机同名的人现在的。
 * 不开事务：在撤销的事务里调。
 */
export async function replaceRoster(
  db: SQLiteDatabase,
  departments: readonly string[] | undefined,
  people: readonly PersonEntry[] | undefined,
): Promise<void> {
  if (departments === undefined && people === undefined) return;
  const before = await listPersons(db);
  if (departments !== undefined) {
    await db.runAsync('UPDATE person SET department_id = NULL');
    await db.runAsync('DELETE FROM department');
  }
  const ids = await departmentIdsByName(db);
  for (const name of departments ?? []) await departmentIdFor(db, name, ids);
  if (people === undefined) {
    // 只换了部门：本机的人按原来的部门名重新挂上，留底里没有的部门就成了未分部门
    for (const person of before) {
      const id = person.departmentName === null ? undefined : ids.get(personKey(person.departmentName));
      if (id !== undefined) await db.runAsync('UPDATE person SET department_id = ? WHERE id = ?', [id, person.id]);
    }
    return;
  }
  await db.runAsync('DELETE FROM person');
  for (const person of people) {
    const previous = findPersonByName(before, person.name);
    const departmentName = person.department === undefined ? (previous?.departmentName ?? null) : person.department;
    await insertPerson(db, {
      name: person.name.trim(),
      note: person.note === undefined ? (previous?.note ?? null) : person.note,
      email: person.email === undefined ? (previous?.email ?? null) : (importedEmail(person.email) ?? null),
      departmentId: departmentName === null ? null : await departmentIdFor(db, departmentName, ids),
    });
  }
}
