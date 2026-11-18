import { useSQLiteContext } from 'expo-sqlite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ALL_OFFICES, getCurrentOfficeId, listOffices, setCurrentOfficeId, type Office } from '../db/offices';

type OfficeState = {
  offices: Office[];
  /** 当前选中的办公点 id，ALL_OFFICES（0）表示全部 */
  currentId: number;
  /** 查询用：null 表示不按办公点过滤 */
  filterId: number | null;
  /** 新建物品、设备时默认放进哪个办公点 */
  defaultId: number;
  /** 当前选中的办公点名称；全部时为 null */
  currentName: string | null;
  /** 不止一个办公点时才需要显示办公点相关的界面 */
  multiple: boolean;
  officeName: (id: number) => string;
  select: (id: number) => Promise<void>;
  reload: () => Promise<void>;
};

const OfficeContext = createContext<OfficeState | null>(null);

/** 读出办公点和本机选中的办公点（只读，不改状态）。 */
async function loadOffices(db: ReturnType<typeof useSQLiteContext>): Promise<{ list: Office[]; currentId: number }> {
  const [list, saved] = await Promise.all([listOffices(db), getCurrentOfficeId(db)]);
  // 只有一个办公点时就是它；选中的办公点被删了就回到全部
  if (list.length === 1) return { list, currentId: list[0].id };
  return { list, currentId: list.some((office) => office.id === saved) ? saved : ALL_OFFICES };
}

export function OfficeProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [offices, setOffices] = useState<Office[]>([]);
  const [currentId, setCurrentId] = useState(ALL_OFFICES);

  const reload = useCallback(async () => {
    const result = await loadOffices(db);
    setOffices(result.list);
    setCurrentId(result.currentId);
  }, [db]);

  useEffect(() => {
    let active = true;
    loadOffices(db)
      .then((result) => {
        if (!active) return;
        setOffices(result.list);
        setCurrentId(result.currentId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [db]);

  const select = useCallback(
    async (id: number) => {
      setCurrentId(id);
      await setCurrentOfficeId(db, id);
    },
    [db],
  );

  const value = useMemo<OfficeState>(() => {
    const current = offices.find((office) => office.id === currentId) ?? null;
    return {
      offices,
      currentId,
      filterId: current ? current.id : null,
      defaultId: current?.id ?? offices[0]?.id ?? 1,
      currentName: current?.name ?? null,
      multiple: offices.length > 1,
      officeName: (id: number) => offices.find((office) => office.id === id)?.name ?? '',
      select,
      reload,
    };
  }, [offices, currentId, select, reload]);

  return <OfficeContext.Provider value={value}>{children}</OfficeContext.Provider>;
}

export function useOffice(): OfficeState {
  const value = useContext(OfficeContext);
  if (!value) throw new Error('useOffice 必须在 OfficeProvider 里用');
  return value;
}
