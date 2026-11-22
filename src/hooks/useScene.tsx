import { useSQLiteContext } from 'expo-sqlite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { SceneChooser } from '../components/SceneOptions';
import { getScene, saveScene } from '../db/settings';
import { subscribeDataChanged } from '../lib/dataEvents';
import { rescheduleReminders } from '../lib/notifications';
import { setActiveScene, termsFor, type Scene, type Terms } from '../lib/terms';
import { useOffice } from './useOffice';

type SceneState = {
  /** 没选过为 null（新装的手机，正在显示首次选择） */
  scene: Scene | null;
  terms: Terms;
  /** 选了场景：存下来；切到家庭时「默认办公点」改叫「家」，所以顺带刷新办公点 */
  choose: (scene: Scene) => Promise<void>;
};

const SceneContext = createContext<SceneState | null>(null);

/** 读使用场景、提供当前叫法；新装的手机（没选过）在最上面盖一层首次选择。要放在 OfficeProvider 里面。 */
export function SceneProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const office = useOffice();
  const [loaded, setLoaded] = useState(false);
  const [scene, setScene] = useState<Scene | null>(null);

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
        if (active) setLoaded(true);
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

  const { reload: reloadOffices } = office;
  const choose = useCallback(
    async (next: Scene) => {
      await saveScene(db, next);
      setActiveScene(next);
      setScene(next);
      await reloadOffices();
      // 保修提醒只在家庭场景发，换了场景重新排
      rescheduleReminders(db).catch(() => undefined);
    },
    [db, reloadOffices],
  );

  const value = useMemo<SceneState>(() => ({ scene, terms: termsFor(scene ?? 'office'), choose }), [scene, choose]);

  return (
    <SceneContext.Provider value={value}>
      {children}
      {loaded && scene === null ? <SceneChooser onChoose={choose} /> : null}
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
