import type { StockKind } from './stock';

/** 物品分类：固定选项，食品、日用品各一套；单选，可以不选，存分类名 */
export const CATEGORIES: Record<StockKind, readonly string[]> = {
  food: ['粮油米面', '调味品', '零食', '饮料冲调', '乳品', '生鲜', '速食冻品', '其他'],
  daily: ['纸品', '清洁用品', '洗护用品', '厨房用品', '药品', '办公用品', '其他'],
};

export function isCategoryOf(kind: StockKind, category: string | null | undefined): category is string {
  return !!category && CATEGORIES[kind].includes(category);
}

/** 换了食品 / 日用品：选过的分类还属于新的那类就留着，不属于就清空 */
export function categoryForKind(kind: StockKind, category: string | null | undefined): string | null {
  return isCategoryOf(kind, category) ? category : null;
}

/**
 * 列表上的分类筛选：这些物品实际用到的分类。固定列表里的按列表顺序，
 * 不在列表里的（换过食品 / 日用品前留下的等）按名称排在后面。
 */
export function usedCategories(kind: StockKind, products: readonly { category: string | null }[]): string[] {
  const used = new Set(products.map((product) => product.category).filter((category): category is string => !!category));
  const fixed = CATEGORIES[kind].filter((category) => used.has(category));
  const others = [...used].filter((category) => !CATEGORIES[kind].includes(category)).sort((left, right) => left.localeCompare(right, 'zh'));
  return [...fixed, ...others];
}
