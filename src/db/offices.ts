import type { SQLiteDatabase } from 'expo-sqlite';

import { deleteStocktakesOfOffice } from './stocktake';

export type Office = {
  id: number;
  name: string;
  productCount: number;
  deviceCount: number;
};

/** 本机界面上当前选中的办公点，0 表示「全部办公点」。只存在本机，不进备份。 */
const CURRENT_OFFICE_KEY = 'ui.currentOfficeId';
export const ALL_OFFICES = 0;
export const OFFICE_NAME_MAX = 20;

export async function listOffices(db: SQLiteDatabase): Promise<Office[]> {
  return db.getAllAsync<Office>(
    `SELECT o.id, o.name,
            (SELECT COUNT(*) FROM stock_product p WHERE p.office_id = o.id) AS productCount,
            (SELECT COUNT(*) FROM device d WHERE d.office_id = o.id) AS deviceCount
       FROM office o
      ORDER BY o.sort, o.id`,
  );
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('请填办公点名称');
  if (trimmed.length > OFFICE_NAME_MAX) throw new Error(`办公点名称最多 ${OFFICE_NAME_MAX} 个字`);
  return trimmed;
}

async function assertNameFree(db: SQLiteDatabase, name: string, selfId: number | null): Promise<void> {
  const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM office WHERE name = ?', [name]);
  if (existing && existing.id !== selfId) throw new Error(`已经有叫「${name}」的办公点了`);
}

export async function createOffice(db: SQLiteDatabase, name: string): Promise<number> {
  const clean = cleanName(name);
  await assertNameFree(db, clean, null);
  const next = await db.getFirstAsync<{ sort: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS sort FROM office');
  const result = await db.runAsync('INSERT INTO office (name, sort, created_at) VALUES (?, ?, ?)', [
    clean,
    next?.sort ?? 0,
    new Date().toISOString(),
  ]);
  return result.lastInsertRowId;
}

export async function renameOffice(db: SQLiteDatabase, id: number, name: string): Promise<void> {
  const clean = cleanName(name);
  await assertNameFree(db, clean, id);
  await db.runAsync('UPDATE office SET name = ? WHERE id = ?', [clean, id]);
}

/** 只能删空的办公点，且至少留一个。 */
export async function deleteOffice(db: SQLiteDatabase, id: number): Promise<void> {
  const offices = await listOffices(db);
  const office = offices.find((item) => item.id === id);
  if (!office) return;
  if (offices.length <= 1) throw new Error('至少要留一个办公点');
  if (office.productCount > 0 || office.deviceCount > 0) {
    throw new Error(`「${office.name}」里还有 ${office.productCount} 样物品、${office.deviceCount} 种设备，先移走或删掉再删办公点`);
  }
  await db.withTransactionAsync(async () => {
    // 盘点记录跟着办公点走，办公点没了就一起删
    await deleteStocktakesOfOffice(db, id);
    await db.runAsync('DELETE FROM office WHERE id = ?', [id]);
  });
}

/** 按名字找办公点，没有就新建；导入别的手机的数据时用。 */
export async function ensureOfficeByName(db: SQLiteDatabase, name: string): Promise<number> {
  const clean = cleanName(name);
  const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM office WHERE name = ?', [clean]);
  return existing ? existing.id : createOffice(db, clean);
}

export async function getCurrentOfficeId(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM setting WHERE key = ?', [CURRENT_OFFICE_KEY]);
  const id = row ? Number(JSON.parse(row.value)) : ALL_OFFICES;
  return Number.isInteger(id) ? id : ALL_OFFICES;
}

export async function setCurrentOfficeId(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [CURRENT_OFFICE_KEY, JSON.stringify(id)],
  );
}
