import type { SQLiteDatabase } from 'expo-sqlite';

import {
  parseSceneSetup,
  planSceneDatabases,
  SCENE_STORE_KEYS,
  type SceneSetup,
} from '../lib/sceneDatabases';
import type { Scene } from '../lib/terms';

/**
 * 记当前场景和「哪个场景用哪个库」的小库（lib/sceneDatabases.ts）。和两个场景的库分开放：要先读它才知道打开哪个库。
 * 只有一张键值表：scene（当前场景，新装没选过时没有）、db.home、db.office（两个场景各用哪个库文件）。
 */
export const SCENE_STORE_NAME = 'item-keeper-scene.db';

export async function initSceneStore(store: SQLiteDatabase): Promise<void> {
  await store.execAsync('CREATE TABLE IF NOT EXISTS scene_store (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

async function upsert(store: SQLiteDatabase, key: string, value: string): Promise<void> {
  await store.runAsync(
    'INSERT INTO scene_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/** 读存着的对应关系；没有（第一次以分开记的版本启动）或不完整返回 null */
export async function readSceneSetup(store: SQLiteDatabase): Promise<SceneSetup | null> {
  const rows = await store.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM scene_store');
  return parseSceneSetup(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

export async function writeSceneSetup(store: SQLiteDatabase, setup: SceneSetup): Promise<void> {
  await store.withTransactionAsync(async () => {
    await upsert(store, SCENE_STORE_KEYS.home, setup.databases.home);
    await upsert(store, SCENE_STORE_KEYS.office, setup.databases.office);
    if (setup.scene) await upsert(store, SCENE_STORE_KEYS.scene, setup.scene);
    else await store.runAsync('DELETE FROM scene_store WHERE key = ?', [SCENE_STORE_KEYS.scene]);
  });
}

/** 首次选择、设置里切换：只记当前场景，对应关系不变 */
export async function writeCurrentScene(store: SQLiteDatabase, scene: Scene): Promise<void> {
  await upsert(store, SCENE_STORE_KEYS.scene, scene);
}

/**
 * 启动时定下用哪套：存过就照存的；没存过就按现有库里记的场景定（readLegacyScene 打开 item-keeper.db、跑迁移、读 usage.scene），
 * 定好马上存下，以后不再看现有库。readLegacyScene 出错时往外抛，不存：下次启动再定，别把老用户当成新装。
 */
export async function resolveSceneSetup(
  store: SQLiteDatabase,
  readLegacyScene: () => Promise<Scene | null>,
): Promise<SceneSetup> {
  const stored = await readSceneSetup(store);
  if (stored) return stored;
  const setup = planSceneDatabases(await readLegacyScene());
  await writeSceneSetup(store, setup);
  return setup;
}
