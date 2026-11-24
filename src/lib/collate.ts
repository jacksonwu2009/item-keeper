/**
 * 按中文习惯比较两个名称（和 a.localeCompare(b, 'zh') 的顺序一样）。
 * 排序时每比一次都调 localeCompare 要现找一遍中文的排序规则；这里在模块里建好一个比较器，排几千个名称时反复用它。
 */
export const compareZh: (left: string, right: string) => number = new Intl.Collator('zh').compare;
