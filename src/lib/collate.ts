/**
 * 排序用的比较器，在模块里建好一次反复用：
 * - compareZh：按中文习惯比较（和 a.localeCompare(b, 'zh') 的顺序一样）；
 * - compareDefault：按手机默认语言比较（和不带语言的 a.localeCompare(b) 一样）。
 * 手机上（Hermes）每调一次 localeCompare 都要现建一个比较器，排几千个名称、时间要好几秒（实测 3400 个名称约 8 秒）；
 * 用建好的比较器只要十几毫秒，顺序完全一样（单测里随机比对）。
 */
export const compareZh: (left: string, right: string) => number = new Intl.Collator('zh').compare;

export const compareDefault: (left: string, right: string) => number = new Intl.Collator().compare;
