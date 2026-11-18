import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { DEFAULT_SETTINGS, getSettings } from '../db/settings';
import { deleteProduct, listAllPacks, listProducts, type StockProductSummary } from '../db/stock';
import { useFocusData } from '../hooks/useFocusData';
import { usePendingDelete } from '../hooks/usePendingDelete';
import { useOffice } from '../hooks/useOffice';
import { todayStr } from '../lib/dates';
import { formatBreakdown, type PackUnit } from '../lib/packs';
import { rescheduleReminders } from '../lib/notifications';
import { expiryStatus, isLowStock } from '../lib/status';
import { formatQty, KIND_LABEL, type StockKind } from '../lib/stock';
import { colors, font, radius } from '../theme';
import { SwipeRow, UndoBar } from './SwipeRow';
import { Button, Chip, Empty, Field, Segmented } from './ui';

type Filter = 'all' | 'attention' | 'low';

export function StockList({ kind }: { kind: StockKind }) {
  const db = useSQLiteContext();
  const office = useOffice();
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
  const deletion = usePendingDelete<number>(
    (id) => deleteProduct(db, id),
    () => {
      reload().catch(() => undefined);
      rescheduleReminders(db).catch(() => undefined);
    },
  );
  const today = todayStr();
  const label = KIND_LABEL[kind];

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return products
      .map((product) => ({
        product,
        expiry: expiryStatus(product.nearestExpiry, today, product.expiryLeadDays ?? settings.expiryLeadDays),
        low: isLowStock(product.totalQty, product.lowStockThreshold),
        breakdown: formatBreakdown(product.totalQty, product.unit, packsByProduct.get(product.id) ?? []),
      }))
      .filter(({ product, expiry, low }) => {
        if (product.id === deletion.pending?.key) return false;
        if (keyword) {
          const haystack = [product.name, product.brand, product.spec, product.location, product.barcode]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(keyword)) return false;
        }
        if (filter === 'attention') return expiry?.level === 'expired' || expiry?.level === 'soon';
        if (filter === 'low') return low;
        return true;
      })
      .sort((a, b) => {
        // 需要注意的排前面：过期 > 快到期 > 库存不足 > 其他
        const rank = (row: typeof a) =>
          row.expiry?.level === 'expired' ? 0 : row.expiry?.level === 'soon' ? 1 : row.low ? 2 : 3;
        return rank(a) - rank(b) || a.product.name.localeCompare(b.product.name, 'zh');
      });
  }, [products, query, filter, today, settings.expiryLeadDays, packsByProduct, deletion.pending]);

  const scan = () => router.push({ pathname: '/scan', params: { kind } });
  const addManually = () => router.push({ pathname: '/stock/new', params: { kind } });

  const header = (
    <View style={listStyles.header}>
      <View style={listStyles.actions}>
        <Button title="扫码入库" icon="barcode-outline" onPress={scan} style={listStyles.actionMain} />
        <Button title="手动添加" icon="add" variant="secondary" onPress={addManually} style={listStyles.actionSide} />
      </View>
      {products.length > 0 ? (
        <>
          <Field
            placeholder={`搜索${label}名称、品牌、位置或条码`}
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
          <Text style={listStyles.gestureHint}>点开看详情，长按编辑，向左滑删除</Text>
        </>
      ) : null}
    </View>
  );

  return (
    <View style={listStyles.screen}>
      <FlatList
        style={listStyles.list}
        contentContainerStyle={listStyles.content}
        data={rows}
        keyExtractor={(row) => String(row.product.id)}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={listStyles.separator} />}
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
        renderItem={({ item: { product, expiry, low, breakdown } }) => (
          <SwipeRow
            accessibilityLabel={`${product.name}，${formatQty(product.totalQty)} ${product.unit}`}
            onPress={() => router.push({ pathname: '/stock/[id]', params: { id: String(product.id) } })}
            onLongPress={() => router.push({ pathname: '/stock/edit/[id]', params: { id: String(product.id) } })}
            onDelete={() => deletion.remove(product.id, product.name)}
            style={listStyles.row}
            pressedStyle={listStyles.rowPressed}
          >
            <View style={listStyles.rowMain}>
              <Text style={listStyles.name} numberOfLines={1}>
                {product.name}
              </Text>
              {showOffice || product.brand || product.spec || product.location ? (
                <Text style={listStyles.meta} numberOfLines={1}>
                  {[
                    showOffice && office.officeName(product.officeId),
                    product.brand,
                    product.spec,
                    product.location && `放在 ${product.location}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              ) : null}
              {expiry || low ? (
                <View style={listStyles.chips}>
                  {expiry && expiry.level !== 'fine' ? <Chip text={expiry.text} tone={expiry.tone} /> : null}
                  {expiry && expiry.level === 'fine' ? <Chip text={expiry.text} tone="neutral" /> : null}
                  {low ? <Chip text="库存不足" tone="warn" icon="alert-circle-outline" /> : null}
                </View>
              ) : null}
            </View>
            <View style={listStyles.qtyBox}>
              <Text style={[listStyles.qty, product.totalQty <= 0 && { color: colors.danger }]}>
                {formatQty(product.totalQty)}
              </Text>
              <Text style={listStyles.unit}>{product.unit}</Text>
              {breakdown ? <Text style={listStyles.breakdown}>{breakdown}</Text> : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.faint} />
          </SwipeRow>
        )}
      />
      {deletion.pending ? <UndoBar text={`已删除「${deletion.pending.label}」`} onUndo={deletion.undo} /> : null}
    </View>
  );
}

const listStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  gestureHint: { fontSize: font.small, color: colors.faint, textAlign: 'center' },
  list: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  header: { gap: 12, marginBottom: 12 },
  actions: { flexDirection: 'row', gap: 10 },
  actionMain: { flex: 3 },
  actionSide: { flex: 2 },
  separator: { height: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rowMain: { flex: 1, gap: 4, minWidth: 0 },
  name: { fontSize: font.body + 1, fontWeight: '600', color: colors.ink },
  meta: { fontSize: font.small, color: colors.muted },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 },
  qtyBox: { alignItems: 'flex-end', minWidth: 44 },
  qty: { fontSize: 22, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  unit: { fontSize: font.tiny + 1, color: colors.muted },
  breakdown: { fontSize: font.tiny + 1, color: colors.accent, fontWeight: '600' },
});
