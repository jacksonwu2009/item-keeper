/**
 * 测试用：Node 自带的 SQLite（内存库）包成 expo-sqlite 的异步接口，跑真实的建表迁移。
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { SQLiteDatabase } from 'expo-sqlite';

import { migrateDbIfNeeded } from '../../src/db/schema';

export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 只包一层、不建表的内存库（测场景对应关系那个小库用） */
export function openRawDb(): SQLiteDatabase {
  const raw = new DatabaseSync(':memory:');
  const params = (values: unknown[] = []) => values as SQLInputValue[];
  const db = {
    async execAsync(sql: string) {
      raw.exec(sql);
    },
    async runAsync(sql: string, values?: unknown[]) {
      const result = raw.prepare(sql).run(...params(values));
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async getAllAsync(sql: string, values?: unknown[]) {
      return plain(raw.prepare(sql).all(...params(values)));
    },
    async getFirstAsync(sql: string, values?: unknown[]) {
      const row = raw.prepare(sql).get(...params(values));
      return row ? plain(row) : null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as SQLiteDatabase;
  return db;
}

export async function openDb(): Promise<SQLiteDatabase> {
  const db = openRawDb();
  await migrateDbIfNeeded(db);
  return db;
}
