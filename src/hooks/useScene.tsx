import { useSQLiteContext } from 'expo-sqlite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { SceneChooser } from '../components/SceneOptions';
import { chooseInitialScene, getScene, saveScene } from '../db/settings';
import { subscribeDataChanged } from '../lib/dataEvents';
import { rescheduleReminders } from '../lib/notifications';
import { setActiveScene, termsFor, type Scene, type Terms } from '../lib/terms';
import { useOffice } from './useOffice';

type SceneState = {
  /** 没选过为 null（新装的手机，正在显示首次选择） */
  scene: Scene | null;
  terms: Terms;
  /** 设置里换场景：只记场景，不改数据 */
  choose: (scene: Scene) => Promise<void>;
};

const SceneContext = createContext<SceneState | null>(null);

/**
 * 读使用场景、提供当前叫法；新装的手机（没选过）在最上面盖一层首次选择。要放在 OfficeProvider 里面。
 * 读出来之前不渲染里面的页面（开屏也就还盖着），免得家庭场景每次启动先闪一下办公的叫法。
 */
export function SceneProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const office = useOffice();
  const [loaded, setLoaded] = useState(false);
  const [scene, setScene] = useState<Scene | null>(null);
  /** 读场景出错时按办公显示、不弹首次选择（老用户读不出来不该被当成新装） */
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const apply = (saved: Scene | null) => {
      if (!active) return;
      setActiveScene(saved ?? 'office');
      setScene(saved);
      setLoaded(true);
    };
    getScene(db)
      .then(apply)
      .catch(() => {
        if (!active) return;
        setActiveScene('office');
        setReadFailed(true);
        setLoaded(true);
      });
    // 导入备份、撤销导入可能换了场景
    const unsubscribe = subscribeDataChanged(() => {
      getScene(db)
        .then(apply)
        .catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [db]);

  const apply = useCallback(
    (next: Scene) => {
      setActiveScene(next);
      setScene(next);
      setReadFailed(false);
      // 保修提醒只在家庭场景发，换了场景重新排
      rescheduleReminders(db).catch(() => undefined);
    },
    [db],
  );
  const choose = useCallback(
    async (next: Scene) => {
      await saveScene(db, next);
      apply(next);
    },
    [db, apply],
  );
  const { reload: reloadOffices } = office;
  // 新装第一次打开选：选家庭时空的「默认办公点」改叫「家」，所以刷新一下地点
  const chooseInitial = useCallback(
    async (next: Scene) => {
      await chooseInitialScene(db, next);
      apply(next);
      await reloadOffices();
    },
    [db, apply, reloadOffices],
  );

  const value = useMemo<SceneState>(() => ({ scene, terms: termsFor(scene ?? 'office'), choose }), [scene, choose]);

  return (
    <SceneContext.Provider value={value}>
      {loaded ? children : null}
      {/* 一直挂着、用 visible 控制：直接卸掉显示中的 Modal，iOS 上有过卸了还盖着的问题 */}
      <SceneChooser visible={loaded && scene === null && !readFailed} onChoose={chooseInitial} />
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
