/**
 * 导出 / 导入备份文件（会碰文件系统、系统分享和文件选择器）。
 *
 * - 导出：在缓存目录生成 JSON 文件，调起系统分享，用户自己选「存储到文件」、网盘或发给自己。
 * - 导出、导入都可以只选部分分类（食品 / 日用品 / 设备 / 提醒设置）。
 * - 导入：用户选一个备份文件，先完整校验；确认后用它替换手机上所选分类的数据，没选的不动。
 *   替换前先把手机上的全部数据存一份在 App 自己的目录里，导错了可以撤销。
 * - 家庭、办公两个场景各一个库：导出、导入、撤销都只对当前场景的库，留底文件也是每个库一份。
 */

import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { SQLiteDatabase } from 'expo-sqlite';

import { collectBackup, replaceData, restoreAll, type ImportChoice } from '../db/backup';
import { setLastExportAt } from '../db/settings';
import {
  ALL_SCOPES,
  backupFileName,
  parseBackup,
  summarizeBackup,
  type BackupData,
  type BackupScope,
  type BackupSummary,
  type ParseResult,
} from './backup';
import { countsAsBackup } from './backupReminder';
import { rescheduleReminders } from './notifications';
import { undoFileName } from './sceneDatabases';

/** 这个库的撤销留底文件（每个场景的库一份） */
function undoFile(db: SQLiteDatabase): File {
  return new File(Paths.document, undoFileName(db.databasePath ?? ''));
}

/** officeIds 为 null 时导出所有办公点。 */
export async function exportBackup(
  db: SQLiteDatabase,
  scope: readonly BackupScope[],
  officeIds: readonly number[] | null,
): Promise<BackupSummary> {
  const data = await collectBackup(db, scope, officeIds);
  const file = new File(Paths.cache, backupFileName(new Date(), scope, officeIds === null ? null : data.offices));
  file.create({ overwrite: true });
  await file.write(JSON.stringify(data, null, 2));
  if (!(await Sharing.isAvailableAsync())) throw new Error('这台手机不支持系统分享，没法把备份文件存出去');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: '保存或发送备份文件',
  });
  // 分类、办公点都全选才算备份过，备份提醒从今天重新算（分享面板被取消也没法知道，按导出过算）
  if (countsAsBackup(scope, officeIds === null)) {
    await setLastExportAt(db, new Date().toISOString());
    rescheduleReminders(db).catch(() => undefined);
  }
  return summarizeBackup(data);
}

export type PickedBackup = { fileName: string; result: ParseResult };

/** 让用户选一个备份文件并校验。用户取消时返回 null。 */
export async function pickBackup(): Promise<PickedBackup | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  if (picked.canceled || !picked.assets?.length) return null;
  const asset = picked.assets[0];
  const file = new File(asset.uri);
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { fileName: asset.name, result: { ok: false, error: '读不了这个文件' } };
  }
  return { fileName: asset.name, result: parseBackup(text) };
}

/**
 * 用备份替换所选办公点、所选分类的数据；替换前先把手机上的全部数据留一份，用于撤销。
 * 返回留底有没有存上：数据已经换掉、但留底写盘失败（比如存储满了）时为 false，这次就撤销不了。
 */
export async function importBackup(
  db: SQLiteDatabase,
  data: BackupData,
  choice: ImportChoice,
): Promise<{ undoSaved: boolean }> {
  // 先在内存里留底，导入成功后才写盘：导入被拒（如条码冲突）时不会留下一份没意义的「撤销」
  const current = await collectBackup(db, ALL_SCOPES);
  await replaceData(db, data, choice);
  let undoSaved = true;
  try {
    const file = undoFile(db);
    file.create({ overwrite: true });
    await file.write(JSON.stringify(current));
  } catch {
    undoSaved = false;
    // 旧的留底是更早那次导入前的数据，留着会让「撤销」换回错的东西，删掉
    try {
      undoFile(db).delete();
    } catch {
      // 本来就没有
    }
  }
  await rescheduleReminders(db).catch(() => undefined);
  return { undoSaved };
}

/** 这个库上次导入前留下的数据（没有就返回 null）。 */
export async function readUndoSnapshot(db: SQLiteDatabase): Promise<{ data: BackupData; summary: BackupSummary } | null> {
  const file = undoFile(db);
  if (!file.exists) return null;
  const result = parseBackup(await file.text());
  return result.ok ? { data: result.data, summary: result.summary } : null;
}

/** 撤销上次导入：换回导入前的数据，然后删掉这份留底。 */
export async function undoLastImport(db: SQLiteDatabase): Promise<boolean> {
  const snapshot = await readUndoSnapshot(db);
  if (!snapshot) return false;
  await restoreAll(db, snapshot.data);
  undoFile(db).delete();
  await rescheduleReminders(db).catch(() => undefined);
  return true;
}
