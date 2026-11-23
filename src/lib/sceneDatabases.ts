/**
 * 家庭、办公两套数据：每个场景一个数据库文件（同一套表结构和迁移）。
 * 当前场景和「哪个场景用哪个库」记在这些库外面的一个小库里（db/sceneStore.ts），要先知道场景才能打开对应的库。
 *
 * 升级（第一次以分开记的版本启动、还没有对应关系时）：现有的库 item-keeper.db 里记着场景 S（usage.scene），
 * 就让 S 继续用它，另一个场景用新的库文件（item-keeper-home.db 或 item-keeper-office.db），数据一条不搬；
 * 现有的库没记场景（新装）时办公用 item-keeper.db、家庭用 item-keeper-home.db，照旧先让用户选。
 * 这里是纯函数（有单测）和一份「当前用的是哪套」的登记，给不在组件里的代码用（排通知、撤销导入的留底文件名）。
 */
import { isScene, setActiveScene, type Scene } from './terms';

/** 以前只有一个库时的文件名；升级后归记在里面的那个场景用 */
export const LEGACY_DATABASE_NAME = 'item-keeper.db';

export type SceneDatabases = Record<Scene, string>;

export type SceneSetup = {
  /** 当前场景；新装还没选过为 null */
  scene: Scene | null;
  databases: SceneDatabases;
};

export function otherScene(scene: Scene): Scene {
  return scene === 'home' ? 'office' : 'home';
}

/** 新建的库按场景起名：item-keeper-home.db、item-keeper-office.db */
export function sceneDatabaseName(scene: Scene): string {
  return `item-keeper-${scene}.db`;
}

/**
 * 还没有对应关系时怎么定：existingScene 是现有库（item-keeper.db）里记的场景，没有为 null（新装）。
 * 现有库归它记着的场景，另一个场景用新库；新装时办公用现有库、家庭用 item-keeper-home.db，场景留空等用户选。
 */
export function planSceneDatabases(existingScene: Scene | null): SceneSetup {
  if (!existingScene) {
    return { scene: null, databases: { office: LEGACY_DATABASE_NAME, home: sceneDatabaseName('home') } };
  }
  const other = otherScene(existingScene);
  return {
    scene: existingScene,
    databases: { [existingScene]: LEGACY_DATABASE_NAME, [other]: sceneDatabaseName(other) } as SceneDatabases,
  };
}

/** 存对应关系用的键 */
export const SCENE_STORE_KEYS = { scene: 'scene', home: 'db.home', office: 'db.office' } as const;

function isDatabaseName(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.-]+\.db$/.test(value);
}

/** 读存着的对应关系：两个库名都要有、合法且不一样，否则当作没有（重新按升级规则定）。场景不认得当作没选过。 */
export function parseSceneSetup(values: Readonly<Record<string, string | undefined>>): SceneSetup | null {
  const home = values[SCENE_STORE_KEYS.home];
  const office = values[SCENE_STORE_KEYS.office];
  if (!isDatabaseName(home) || !isDatabaseName(office) || home === office) return null;
  const scene = values[SCENE_STORE_KEYS.scene];
  return { scene: isScene(scene) ? scene : null, databases: { home, office } };
}

/** 库文件名（或完整路径）对应的是哪个场景；都不是返回 null */
export function sceneOfDatabase(databases: SceneDatabases, databasePath: string): Scene | null {
  const name = databasePath.slice(databasePath.lastIndexOf('/') + 1);
  if (databases.home === name) return 'home';
  if (databases.office === name) return 'office';
  return null;
}

/**
 * 撤销导入用的留底文件，每个库一份：撤销只换当前场景的数据。
 * 以前只有一个库，留底叫 before-last-import.json，升级后还是 item-keeper.db 的。
 */
export function undoFileName(databasePath: string): string {
  const name = databasePath.slice(databasePath.lastIndexOf('/') + 1);
  if (!name || name === LEGACY_DATABASE_NAME) return 'before-last-import.json';
  return `before-last-import-${name.replace(/\.db$/, '')}.json`;
}

let activeDatabases: SceneDatabases | null = null;

/** 选定（或切换）场景后登记一下：当前叫法跟着换，排通知时知道另一个场景用哪个库 */
export function setActiveSceneSetup(scene: Scene, databases: SceneDatabases): void {
  setActiveScene(scene);
  activeDatabases = databases;
}

/** 当前登记的两个库；还没选场景时为 null */
export function getActiveDatabases(): SceneDatabases | null {
  return activeDatabases;
}
