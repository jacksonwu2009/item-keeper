import type { SQLiteDatabase } from 'expo-sqlite';

import { currentTerms } from '../lib/terms';

/**
 * 人员名单（办公场景叫员工名单，家庭场景叫家庭成员；每个场景的库各一份）。
 * 登记领用、记谁在用时从名单里选，领用记录里存的还是名字（device_assignment.person），名单外的人也能直接填。
 * 姓名去掉首尾空格后在同一个库里不能重名（不分大小写）。
 */
export const PERSON_NAME_MAX = 20;
export const PERSON_NOTE_MAX = 100;

export type Person = {
  id: number;
  name: string;
  /** 部门、关系等，选填 */
  note: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
};

/** 备份文件里的写法（lib/backup.ts 的 people，鸿蒙版一样） */
export type PersonEntry = { name: string; note: string | null };

const COLUMNS = 'id, name, note, sort, created_at AS createdAt, updated_at AS updatedAt';

function nowIso(): string {
  return new Date().toISOString();
}

/** 比较姓名用：去首尾空格、不分大小写 */
export function personKey(name: string): string {
  return name.trim().toLowerCase();
}

/** 名单里叫这个名字的人（不分大小写）；没有返回 undefined */
export function findPersonByName<T extends { name: string }>(people: readonly T[], name: string): T | undefined {
  const key = personKey(name);
  return key ? people.find((person) => personKey(person.name) === key) : undefined;
}

/** 选人时按输入的字过滤：姓名或备注里包含（不分大小写）；没输入时全列出 */
export function filterPeople<T extends { name: string; note: string | null }>(people: readonly T[], query: string): T[] {
  const key = personKey(query);
  if (!key) return [...people];
  return people.filter((person) => person.name.toLowerCase().includes(key) || !!person.note?.toLowerCase().includes(key));
}

/** 校验并整理姓名、备注；不对时抛错，错误信息直接给用户看 */
export function cleanPerson(name: string, note: string | null | undefined): PersonEntry {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('请填写姓名');
  if (cleanName.length > PERSON_NAME_MAX) throw new Error(`姓名最多 ${PERSON_NAME_MAX} 个字`);
  const cleanNote = note?.trim() ? note.trim() : null;
  if (cleanNote && cleanNote.length > PERSON_NOTE_MAX) throw new Error(`备注最多 ${PERSON_NOTE_MAX} 个字`);
  return { name: cleanName, note: cleanNote };
}

export async function listPersons(db: SQLiteDatabase): Promise<Person[]> {
  return db.getAllAsync<Person>(`SELECT ${COLUMNS} FROM person ORDER BY sort, id`);
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

async function insertPerson(db: SQLiteDatabase, entry: PersonEntry): Promise<number> {
  const now = nowIso();
  const result = await db.runAsync(
    `INSERT INTO person (name, note, sort, created_at, updated_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM person), ?, ?)`,
    [entry.name, entry.note, now, now],
  );
  return result.lastInsertRowId;
}

/** 加到名单最后面。重名、太长时抛错 */
export async function addPerson(db: SQLiteDatabase, name: string, note: string | null = null): Promise<number> {
  const entry = cleanPerson(name, note);
  await assertNameFree(db, entry.name);
  return insertPerson(db, entry);
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
 * 改名、改备注。改了名字时，领用记录里写着原来名字的（不分大小写）也一起改成新名字。
 * 返回一起改了几条领用记录。
 */
export async function updatePerson(db: SQLiteDatabase, id: number, name: string, note: string | null): Promise<number> {
  const existing = await db.getFirstAsync<Person>(`SELECT ${COLUMNS} FROM person WHERE id = ?`, [id]);
  if (!existing) throw new Error(`这个人已经不在${currentTerms().roster}里了`);
  const entry = cleanPerson(name, note);
  await assertNameFree(db, entry.name, id);
  let renamed = 0;
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE person SET name = ?, note = ?, updated_at = ? WHERE id = ?', [entry.name, entry.note, nowIso(), id]);
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
 * 登记领用、记谁在用时勾了「同时加到名单」：名单里还没有（不分大小写）就加上，有了什么都不做。
 * 名字太长（超过 20 个字）时抛错。
 */
export async function ensurePerson(db: SQLiteDatabase, name: string): Promise<void> {
  const entry = cleanPerson(name, null);
  const rows = await db.getAllAsync<{ name: string }>('SELECT name FROM person');
  if (findPersonByName(rows, entry.name)) return;
  await insertPerson(db, entry);
}

/**
 * 导入备份（勾了设备）时按姓名合并进名单：没有的加上、有的更新备注，名单里多出来的不删。
 * 不开事务：在导入的事务里调。
 */
export async function mergePersons(db: SQLiteDatabase, people: readonly PersonEntry[]): Promise<void> {
  const rows = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM person');
  for (const person of people) {
    const existing = findPersonByName(rows, person.name);
    if (existing) {
      await db.runAsync('UPDATE person SET note = ?, updated_at = ? WHERE id = ?', [person.note, nowIso(), existing.id]);
    } else {
      const id = await insertPerson(db, { name: person.name.trim(), note: person.note });
      rows.push({ id, name: person.name.trim() });
    }
  }
}

/** 撤销导入：名单整个换回留底的那份（按留底里的顺序）。不开事务：在撤销的事务里调 */
export async function replacePersons(db: SQLiteDatabase, people: readonly PersonEntry[]): Promise<void> {
  await db.runAsync('DELETE FROM person');
  for (const person of people) await insertPerson(db, { name: person.name.trim(), note: person.note });
}
