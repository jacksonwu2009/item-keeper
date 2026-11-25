import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useScrollToTop } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, View, type ListRenderItem } from 'react-native';
import { Text } from './Text';

import { DEFAULT_SETTINGS, getSettings } from '../db/settings';
import { deleteProduct, listAllPacks, listProducts, type StockProductSummary } from '../db/stock';
import { useFocusData } from '../hooks/useFocusData';
import { usePendingDelete } from '../hooks/usePendingDelete';
import { useOffice } from '../hooks/useOffice';
import { usedCategories } from '../lib/categories';
import { compareZh } from '../lib/collate';
import { todayStr } from '../lib/dates';
import { searchKeyword, stockSearchText } from '../lib/listSearch';
import { formatBreakdown, type PackUnit } from '../lib/packs';
import { rescheduleReminders } from '../lib/notifications';
import { expiryStatus, isLowStock, type ExpiryStatus } from '../lib/status';
import { formatQty, KIND_LABEL, type StockKind } from '../lib/stock';
import { makeStyles, useColors } from '../hooks/useTheme';
import { font, radius } from '../theme';
import { SwipeRow, UndoBar } from './SwipeRow';
import { Chip, ChoiceChips, Empty, LARGE_TITLE_SCROLL_INSET, ListActions, SearchField, Segmented } from './ui';

type Filter = 'all' | 'attention' | 'low';

/** 列表的一行要显示的：物品、到期状态、是否库存不足、包装折算（「2 箱 3 瓶」） */
type StockRowData = { product: StockProductSummary; expiry: ExpiryStatus | null; low: boolean; breakdown: string | null };

export function StockList({ kind }: { kind: StockKind }) {
  const listStyles = useListStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  // 已经在这个标签时再点一下底部标签，列表回到顶部（搜索框、筛选在最上面）
  const listRef = useRef<FlatList<StockRowData>>(null);
  useScrollToTop(listRef);
  const officeFilter = office.filterId;
  const showOffice = office.multiple && officeFilter === null;
  const loader = useCallback(async () => {
    const [products, settings, allPacks] = await Promise.all([
      listProducts(db, kind, officeFilter),
      getSettings(db),
      listAllPacks(db),
    ]);
    const packsByProduct = new Map<number, PackUnit[]>();
    for (const pack of allPacks) {
      const list = packsByProduct.get(pack.productId) ?? [];
      list.push(pack);
      packsByProduct.set(pack.productId, list);
    }
    return { products, settings, packsByProduct };
  }, [db, kind, officeFilter]);
  const [{ products, settings, packsByProduct }, reload, loaded] = useFocusData(loader, {
    products: [] as StockProductSummary[],
    settings: DEFAULT_SETTINGS,
    packsByProduct: new Map<number, PackUnit[]>(),
  });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // 分类筛选：'' 是全部分类
  const [categoryFilter, setCategoryFilter] = useState('');
  const deletion = usePendingDelete<number>(
    (id) => deleteProduct(db, id),
    () => {
      rescheduleReminders(db).catch(() => undefined);
      return reload();
    },
  );
  const today = todayStr();
  const label = KIND_LABEL[kind];
  // 这个列表里实际用到的分类；少于 2 个不显示分类那一排。选的分类已经没有物品用了（改了、删了）就当全部分类
  const categories = useMemo(() => usedCategories(kind, products), [kind, products]);
  const showCategories = categories.length >= 2;
  const activeCategory = showCategories && categories.includes(categoryFilter) ? categoryFilter : '';

  // 每样东西的状态只在数据变了时算；搜索、筛选只是从这些里面挑，挑出来的还是同一批对象，没变的行不用重画
  const decorated = useMemo<StockRowData[]>(
    () =>
      products.map((product) => ({
        product,
        expiry: expiryStatus(product.nearestExpiry, today, product.expiryLeadDays ?? settings.expiryLeadDays),
        low: isLowStock(product.totalQty, product.lowStockThreshold),
        breakdown: formatBreakdown(product.totalQty, product.unit, packsByProduct.get(product.id) ?? []),
      })),
    [products, today, settings.expiryLeadDays, packsByProduct],
  );

  const rows = useMemo(() => {
    const keyword = searchKeyword(query);
    return decorated
      .filter(({ product, expiry, low }) => {
        if (product.id === deletion.pending?.key) return false;
        if (keyword && !stockSearchText(product).includes(keyword)) return false;
        if (activeCategory && product.category !== activeCategory) return false;
        if (filter === 'attention') return expiry?.level === 'expired' || expiry?.level === 'soon';
        if (filter === 'low') return low;
        return true;
      })
      .sort((a, b) => {
        // 需要注意的排前面：过期 > 快到期 > 库存不足 > 其他
        const rank = (row: typeof a) =>
          row.expiry?.level === 'expired' ? 0 : row.expiry?.level === 'soon' ? 1 : row.low ? 2 : 3;
        return rank(a) - rank(b) || compareZh(a.product.name, b.product.name);
      });
  }, [decorated, query, filter, activeCategory, deletion.pending]);

  const removeRow = deletion.remove;
  const officeName = office.officeName;
  const renderItem = useCallback<ListRenderItem<StockRowData>>(
    ({ item }) => (
      <StockRow row={item} officeName={showOffice ? officeName(item.product.officeId) : null} onDelete={removeRow} />
    ),
    [showOffice, officeName, removeRow],
  );

  const scan = () => router.push({ pathname: '/scan', params: { kind } });
  const addManually = () => router.push({ pathname: '/stock/new', params: { kind } });

  const header = (
    <View style={listStyles.header}>
      <ListActions scanTitle="扫码入库" onScan={scan} onAdd={addManually} />
      {products.length > 0 ? (
        <>
          <SearchField
            placeholder={`搜索${label}名称、分类、位置或条码`}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          <Segmented
            options={[
              { value: 'all', label: `全部 ${products.length}` },
              { value: 'attention', label: '快到期/过期' },
              { value: 'low', label: '库存不足' },
            ]}
            value={filter}
            onChange={setFilter}
          />
          {showCategories ? (
            // 一排，放不下左右滑
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <ChoiceChips
                options={[{ value: '', label: '全部分类' }, ...categories.map((value) => ({ value, label: value }))]}
                value={activeCategory}
                onChange={setCategoryFilter}
              />
            </ScrollView>
          ) : null}
          <Text style={listStyles.gestureHint}>点开看详情，长按编辑，向左滑删除</Text>
        </>
      ) : null}
    </View>
  );

  return (
    <View style={listStyles.screen}>
      <FlatList
        ref={listRef}
        style={listStyles.list}
        contentContainerStyle={listStyles.content}
        data={rows}
        keyExtractor={rowKey}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior={LARGE_TITLE_SCROLL_INSET}
        ItemSeparatorComponent={RowSeparator}
        windowSize={11}
        ListEmptyComponent={
          !loaded ? undefined : products.length === 0 ? (
            <Empty
              icon={kind === 'food' ? 'nutrition-outline' : 'basket-outline'}
              title={`还没有${label}`}
              text={
                kind === 'food'
                  ? '扫一下包装上的条码就能录入，再填上过期日期和数量。快到期或库存不足时会按设置提醒你。'
                  : '纸巾、洗衣液、电池这类日用品，扫码或手动添加后记下数量，快用完时提醒你补货。'
              }
            />
          ) : (
            <Empty icon="search-outline" title="没有符合条件的" text="换个关键词或筛选条件试试。" />
          )
        }
        renderItem={renderItem}
      />
      {deletion.pending ? <UndoBar text={`已删除「${deletion.pending.label}」`} onUndo={deletion.undo} /> : null}
    </View>
  );
}

function rowKey(row: StockRowData): string {
  return String(row.product.id);
}

/** 行与行之间隔 8：放在模块里，不是每次渲染都新建一个组件（那样每次所有分隔线都要重建） */
function RowSeparator() {
  const listStyles = useListStyles();
  return <View style={listStyles.separator} />;
}

function openProduct(id: number) {
  router.push({ pathname: '/stock/[id]', params: { id: String(id) } });
}

function editProduct(id: number) {
  router.push({ pathname: '/stock/edit/[id]', params: { id: String(id) } });
}

/**
 * 列表的一行。memo：数据没变的行（参数还是同一个对象、同样的文字）不重画；
 * 点开、长按编辑是模块里的函数，删除是列表里不变的函数，都带着这一行的 id 调。
 */
const StockRow = memo(function StockRow({
  row: { product, expiry, low, breakdown },
  officeName,
  onDelete,
}: {
  row: StockRowData;
  /** 看全部办公点、又有不止一个办公点时写上是哪个办公点的；否则 null */
  officeName: string | null;
  onDelete: (id: number, name: string) => void;
}) {
  const colors = useColors();
  const listStyles = useListStyles();
  return (
    <SwipeRow
      accessibilityLabel={`${product.name}，${formatQty(product.totalQty)} ${product.unit}`}
      onPress={() => openProduct(product.id)}
      onLongPress={() => editProduct(product.id)}
      onDelete={() => onDelete(product.id, product.name)}
      style={listStyles.row}
      pressedStyle={listStyles.rowPressed}
    >
      <View style={listStyles.rowMain}>
        <Text style={listStyles.name} numberOfLines={1}>
          {product.name}
        </Text>
        {officeName !== null || product.category || product.spec || product.location ? (
          <Text style={listStyles.meta} numberOfLines={1}>
            {[officeName, product.category, product.spec, product.location && `放在 ${product.location}`]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ) : null}
        {expiry || low ? (
          <View style={listStyles.chips}>
            {expiry && expiry.level !== 'fine' ? <Chip text={expiry.text} tone={expiry.tone} /> : null}
            {expiry && expiry.level === 'fine' ? <Chip text={expiry.text} tone="neutral" /> : null}
            {low ? <Chip text="库存不足" tone="warn" /> : null}
          </View>
        ) : null}
      </View>
      <View style={listStyles.qtyBox}>
        <Text style={[listStyles.qty, product.totalQty <= 0 && { color: colors.danger }]}>{formatQty(product.totalQty)}</Text>
        <Text style={listStyles.unit}>{product.unit}</Text>
        {breakdown ? <Text style={listStyles.breakdown}>{breakdown}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.faint} />
    </SwipeRow>
  );
});

// 照鸿蒙版 StockTab.ets：每一行是一张白底圆角卡片，左边名称、说明和状态标签，右边大数字和单位
const useListStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  gestureHint: { fontSize: font.small, color: colors.faint, textAlign: 'center' },
  list: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  header: { gap: 12, marginBottom: 12 },
  separator: { height: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 72,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 12,
  },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rowMain: { flex: 1, gap: 4, minWidth: 0 },
  name: { fontSize: font.body + 1, fontWeight: '500', color: colors.ink },
  meta: { fontSize: font.small, color: colors.muted },
  chips: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  qtyBox: { alignItems: 'flex-end', minWidth: 44 },
  qty: { fontSize: font.title, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  unit: { fontSize: font.tiny, color: colors.muted },
  breakdown: { fontSize: font.tiny, color: colors.accent, fontWeight: '500' },
}));
