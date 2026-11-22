/**
 * 使用场景（家庭 / 办公）：决定界面上的叫法（办公点还是地点），以及设备按领用登记还是只记谁在用、保修（家庭）。
 * 只改界面，不改数据：家庭的「谁在用」也存成领用记录，切回办公时显示成领用中。
 * 鸿蒙版单机模式用同一套叫法；备份里的 scene 字段两边一样（lib/backup.ts）。
 */
export type Scene = 'home' | 'office';

export const SCENES: readonly Scene[] = ['home', 'office'];

export type Terms = {
  /** 办公点 / 地点 */
  place: string;
  newPlacePlaceholder: string;
  /** 新装时第一个地点的名字（库里建的是「默认办公点」，选家庭时改成「家」） */
  defaultPlaceName: string;
};

const OFFICE_TERMS: Terms = {
  place: '办公点',
  newPlacePlaceholder: '新办公点名称，如 上海办公室',
  defaultPlaceName: '默认办公点',
};

const HOME_TERMS: Terms = {
  place: '地点',
  newPlacePlaceholder: '新地点名称，如 父母家',
  defaultPlaceName: '家',
};

export function termsFor(scene: Scene): Terms {
  return scene === 'home' ? HOME_TERMS : OFFICE_TERMS;
}

export function isScene(value: unknown): value is Scene {
  return value === 'home' || value === 'office';
}

export const SCENE_LABELS: Record<Scene, string> = { home: '家庭', office: '办公' };

/** 选场景时（首次打开、设置里）每一项下面的说明 */
export const SCENE_DESCRIPTIONS: Record<Scene, string> = {
  home: '地点叫「地点」，比如家、父母家；设备记谁在用、什么时候买的、保修到哪天，不用领用、退还。',
  office: '地点叫「办公点」，比如上海办公室；设备按领用、退还登记。',
};

/**
 * 当前场景，给不在组件里的代码用（数据库层抛的错误、导出的 CSV 表头和文件名）：调用时读一次。
 * 组件里用 useTerms()（hooks/useScene），换了场景会重新渲染。没选过场景时按办公（和以前一样）。
 */
let activeScene: Scene = 'office';

export function setActiveScene(scene: Scene): void {
  activeScene = scene;
}

export function currentTerms(): Terms {
  return termsFor(activeScene);
}

/** 切到家庭时，名字还是系统默认的「默认办公点」的那个地点改叫「家」；已经有叫「家」的就不改。反方向不改。 */
export function placeToRenameForHome(names: readonly string[]): string | null {
  if (!names.includes(OFFICE_TERMS.defaultPlaceName)) return null;
  if (names.includes(HOME_TERMS.defaultPlaceName)) return null;
  return OFFICE_TERMS.defaultPlaceName;
}
