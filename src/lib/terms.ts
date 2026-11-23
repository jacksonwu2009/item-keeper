/**
 * 使用场景（家庭 / 办公）：决定界面上的叫法（办公点还是地点），以及设备按领用登记还是只记谁在用、保修（家庭）。
 * 两个场景的数据分开记：每个场景一个库（lib/sceneDatabases.ts），切场景就换一套数据，两边的提醒都照常发。
 * 家庭场景的库第一次打开、还是空的时，「默认办公点」改叫「家」（db/settings.ts 的 prepareSceneDatabase）。
 * 鸿蒙版单机模式用同一套叫法；备份里的 scene 字段两边一样（lib/backup.ts）。
 */
export type Scene = 'home' | 'office';

export const SCENES: readonly Scene[] = ['home', 'office'];

export type Terms = {
  /** 办公点 / 地点 */
  place: string;
  newPlacePlaceholder: string;
  /** 这个场景的库里第一个地点的名字（库里建的是「默认办公点」，家庭场景的库第一次打开时改成「家」） */
  defaultPlaceName: string;
  /** 人员名单：员工名单 / 家庭成员 */
  roster: string;
  /** 名单页上面那句说明 */
  rosterHint: string;
  /** 名单页加人时姓名、备注框的示例 */
  personNamePlaceholder: string;
  personNotePlaceholder: string;
  /** 设备上记的人：领用记录 / 「谁在用」记录（名单里改名时确认框里的说法） */
  assignmentRecords: string;
};

const OFFICE_TERMS: Terms = {
  place: '办公点',
  newPlacePlaceholder: '新办公点名称，如 上海办公室',
  defaultPlaceName: '默认办公点',
  roster: '员工名单',
  rosterHint: '领用设备时直接从名单里选；名单外的人也能手填。',
  personNamePlaceholder: '姓名',
  personNotePlaceholder: '备注（选填）',
  assignmentRecords: '领用记录',
};

const HOME_TERMS: Terms = {
  place: '地点',
  newPlacePlaceholder: '新地点名称，如 父母家',
  defaultPlaceName: '家',
  roster: '家庭成员',
  rosterHint: '记谁在用时直接从名单里选；名单外的人也能手填。',
  personNamePlaceholder: '名字，如 爸爸',
  personNotePlaceholder: '备注（选填），如 关系',
  assignmentRecords: '「谁在用」记录',
};

export function termsFor(scene: Scene): Terms {
  return scene === 'home' ? HOME_TERMS : OFFICE_TERMS;
}

export function isScene(value: unknown): value is Scene {
  return value === 'home' || value === 'office';
}

export const SCENE_LABELS: Record<Scene, string> = { home: '家庭', office: '办公' };

/** 两个场景同一时刻都有提醒、合成一条通知时，各自那部分前面加的字 */
export const SCENE_REMINDER_PREFIX: Record<Scene, string> = { home: '家里：', office: '公司：' };

/** 选场景时（首次打开、设置里）每一项下面的说明 */
export const SCENE_DESCRIPTIONS: Record<Scene, string> = {
  home: '地点叫「地点」，比如家、父母家；设备记谁在用、什么时候买的、保修到哪天。',
  office: '地点叫「办公点」，比如上海办公室；设备按领用、退还登记。',
};

/**
 * 当前场景，给不在组件里的代码用（数据库层抛的错误、导出的 CSV 表头和文件名）：调用时读一次。
 * 组件里用 useTerms()（hooks/useScene），换了场景整个界面按另一个库重新加载。选定场景前按办公。
 */
let activeScene: Scene = 'office';

export function setActiveScene(scene: Scene): void {
  activeScene = scene;
}

export function currentTerms(): Terms {
  return termsFor(activeScene);
}

export function currentScene(): Scene {
  return activeScene;
}

/** 系统起的地点名：库里建的「默认办公点」，家庭场景的库改成的「家」。导入时本机只有一个这样的空地点就直接换成文件里的 */
export const DEFAULT_PLACE_NAMES: readonly string[] = [OFFICE_TERMS.defaultPlaceName, HOME_TERMS.defaultPlaceName];
