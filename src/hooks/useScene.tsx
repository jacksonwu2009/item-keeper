import * as SplashScreen from 'expo-splash-screen';
import { openDatabaseAsync, SQLiteProvider, type SQLiteDatabase } from 'expo-sqlite';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { SceneChooser } from '../components/SceneOptions';
import { migrateDbIfNeeded } from '../db/schema';
import { initSceneStore, resolveSceneSetup, SCENE_STORE_NAME, writeSceneSetup } from '../db/sceneStore';
import { getScene, prepareSceneDatabase } from '../db/settings';
import { withDatabaseLock } from '../lib/dbLock';
import {
  LEGACY_DATABASE_NAME,
  planSceneDatabases,
  setActiveSceneSetup,
  type SceneSetup,
} from '../lib/sceneDatabases';
import { termsFor, type Scene, type Terms } from '../lib/terms';

type SceneState = {
  scene: Scene;
  terms: Terms;
  /** 设置里换场景：记下新场景，换成另一个场景的库，整个界面按新库重新加载 */
  choose: (scene: Scene) => Promise<void>;
};

const SceneContext = createContext<SceneState | null>(null);

/** 升级时看现有的库（item-keeper.db）记的是哪个场景：先跑迁移（老版本升上来的会记成办公），读完就关 */
async function readLegacyScene(): Promise<Scene | null> {
  return withDatabaseLock(LEGACY_DATABASE_NAME, async () => {
    const db = await openDatabaseAsync(LEGACY_DATABASE_NAME, { useNewConnection: true });
    try {
      await migrateDbIfNeeded(db);
      return await getScene(db);
    } finally {
      await db.closeAsync().catch(() => undefined);
    }
  });
}

async function loadSetup(): Promise<{ store: SQLiteDatabase; setup: SceneSetup }> {
  const store = await openDatabaseAsync(SCENE_STORE_NAME);
  await initSceneStore(store);
  return { store, setup: await resolveSceneSetup(store, readLegacyScene) };
}

/**
 * 最外层：先读场景和「哪个场景用哪个库」（库外面的小库，db/sceneStore.ts），再用当前场景的库包住整个界面（SQLiteProvider）。
 * 换场景时换库名，SQLiteProvider 带着库名做 key，下面整棵树（办公点、各页面）按新库重新挂上、重新读数据；
 * 导航状态由 expo-router 全局保存，还停在原来的页面（设置页）。
 * 新装还没选过场景时不打开任何场景的库，盖一层首次选择，选了才打开那个场景的库。
 * 读出来之前什么都不渲染（开屏也就还盖着），免得家庭场景每次启动先闪一下办公的叫法。
 */
export function SceneProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<SQLiteDatabase | null>(null);
  const [setup, setSetup] = useState<SceneSetup | null>(null);
  /**
   * 读场景出错时按办公、用现有的库，不弹首次选择（老用户读不出来不该被当成新装），也不给库记场景：
   * 现有的库可能其实是家庭的，记成办公下次就认错了。这次不存，下次启动再定。
   */
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    loadSetup()
      .then(({ store, setup: loaded }) => {
        storeRef.current = store;
        if (!active) return;
        if (loaded.scene) setActiveSceneSetup(loaded.scene, loaded.databases);
        setSetup(loaded);
      })
      .catch(() => {
        if (!active) return;
        const fallback = planSceneDatabases('office');
        setActiveSceneSetup('office', fallback.databases);
        setReadFailed(true);
        setSetup(fallback);
      });
    return () => {
      active = false;
    };
  }, []);

  const scene = setup?.scene ?? null;
  const databaseName = scene && setup ? setup.databases[scene] : null;

  // 打开库时：迁移到最新，记上是哪个场景的；家庭场景的库第一次打开、还是空的时「默认办公点」改叫「家」
  const onInit = useMemo(() => {
    if (!scene || !databaseName) return undefined;
    return (db: SQLiteDatabase) =>
      withDatabaseLock(databaseName, async () => {
        await migrateDbIfNeeded(db);
        if (!readFailed) await prepareSceneDatabase(db, scene);
      });
  }, [scene, databaseName, readFailed]);

  const choose = useCallback(
    async (next: Scene) => {
      if (!setup || next === setup.scene) return;
      const store = storeRef.current;
      if (!store) throw new Error('场景没存上');
      const updated: SceneSetup = { ...setup, scene: next };
      await writeSceneSetup(store, updated);
      setActiveSceneSetup(next, updated.databases);
      setReadFailed(false);
      setSetup(updated);
    },
    [setup],
  );

  const value = useMemo<SceneState>(
    () => ({ scene: scene ?? 'office', terms: termsFor(scene ?? 'office'), choose }),
    [scene, choose],
  );

  const chooserVisible = setup !== null && scene === null;
  // 首次选择盖在最上面时没有打开任何库，收起开屏让用户选
  useEffect(() => {
    if (chooserVisible) SplashScreen.hideAsync().catch(() => undefined);
  }, [chooserVisible]);

  return (
    <SceneContext.Provider value={value}>
      {databaseName && onInit ? (
        <SQLiteProvider key={databaseName} databaseName={databaseName} onInit={onInit}>
          {children}
        </SQLiteProvider>
      ) : null}
      {/* 一直挂着、用 visible 控制：直接卸掉显示中的 Modal，iOS 上有过卸了还盖着的问题 */}
      <SceneChooser visible={chooserVisible} onChoose={choose} />
    </SceneContext.Provider>
  );
}

export function useScene(): SceneState {
  const value = useContext(SceneContext);
  if (!value) throw new Error('useScene 必须在 SceneProvider 里用');
  return value;
}

/** 当前场景的叫法（办公点 / 地点、领用 / 借出…） */
export function useTerms(): Terms {
  return useScene().terms;
}
