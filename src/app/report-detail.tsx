import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View, type ListRenderItem } from 'react-native';
import { Text } from '../components/Text';

import { ChoiceChips, Empty, LIST_PRESS_DELAY, SearchField, Segmented } from '../components/ui';
import { loadDetailPage } from '../db/reportOverview';
import { getSettings } from '../db/settings';
import { useOffice } from '../hooks/useOffice';
import { useOpenTransition } from '../hooks/useOpenTransition';
import { useScene } from '../hooks/useScene';
import { makeStyles, useColors } from '../hooks/useTheme';
import { todayStr } from '../lib/dates';
import { PERIOD_OPTIONS, periodRange, type ReportPeriodKey } from '../lib/report';
import {
  DETAIL_PAGE_SIZE,
  DETAIL_TITLE,
  DEVICE_STATUS_OPTIONS,
  detailListsProducts,
  detailRowView,
  detailUsesPeriod,
  isDetailKind,
  searchKeyword,
  type DetailRowView,
  type DeviceStatusFilter,
  type ReportDetailItem,
  type ReportDetailQuery,
} from '../lib/reportOverview';
import { KIND_LABEL, type StockKind } from '../lib/stock';
import { font } from '../theme';

/** 搜索框停止输入多久后才查 */
const SEARCH_DEBOUNCE_MS = 300;
/** 每行固定高度（两行字），列表用 getItemLayout 直接算位置 */
const ROW_HEIGHT = 64;

type KindFilter = 'all' | StockKind;

/** 已经取到的几页：key 是查询条件，换了条件就整个换掉 */
type Loaded = {
  key: string;
  rows: DetailRowView[];
  nextOffset: number | null;
  total: number | null;
};

const EMPTY: Loaded = { key: '', rows: [], nextOffset: null, total: null };

function isPeriodKey(value: unknown): value is ReportPeriodKey {
  return PERIOD_OPTIONS.some((option) => option.value === value);
}

function isDeviceStatus(value: unknown): value is DeviceStatusFilter {
  return DEVICE_STATUS_OPTIONS.some((option) => option.value === value);
}

function openRow(row: DetailRowView) {
  if (row.productId !== null) router.push({ pathname: '/stock/[id]', params: { id: String(row.productId) } });
  else if (row.deviceId !== null) router.push({ pathname: '/device/[id]', params: { id: String(row.deviceId) } });
}

function rowKey(row: DetailRowView): string {
  return row.key;
}

function rowLayout(_: ArrayLike<DetailRowView> | null | undefined, index: number) {
  return { length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index };
}

const renderRow: ListRenderItem<DetailRowView> = ({ item }) => <DetailRow row={item} />;

/**
 * 报表明细：从首页各块的「更多」（或点大数字）进来，kind 决定列什么；办公点、时间段照首页带过来的。
 * 一页 40 条，滑到底再取下一页（列表只画看得见的几行）；上面固定一排筛选：大类、分类（设备是类别和借出、保修状态），
 * 搜索框停止输入 300 毫秒后才查。一打开就读库，打开动画结束后才把第一页画出来，先显示筛选和加载状态。
 */
export default function ReportDetailScreen() {
  const colors = useColors();
  const styles = useDetailStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene, terms } = useScene();
  // 家庭场景：设备不写借出
  const lending = scene !== 'home';
  const params = useLocalSearchParams<{ kind?: string; office?: string; period?: string; status?: string }>();
  const kind = isDetailKind(params.kind) ? params.kind : 'products';
  const periodKey: ReportPeriodKey = isPeriodKey(params.period) ? params.period : 'thisMonth';
  const officeNumber = params.office ? Number(params.office) : NaN;
  const officeId = Number.isFinite(officeNumber) && officeNumber > 0 ? officeNumber : null;
  const products = detailListsProducts(kind);
  const { afterOpen } = useOpenTransition();

  // 时间段、今天在打开时定下来，翻页时不变
  const [base] = useState(() => {
    const now = new Date();
    const period = periodRange(periodKey, now);
    return { startIso: period.startIso, endIso: period.endIso, label: period.label, today: todayStr(now) };
  });
  const [leadDays, setLeadDays] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [category, setCategory] = useState('');
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatusFilter>(isDeviceStatus(params.status) ? params.status : 'all');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchKeyword(text)), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const [categories, setCategories] = useState<string[]>([]);
  const stockKind = kindFilter === 'all' ? null : kindFilter;

  const query = useMemo<ReportDetailQuery | null>(
    () =>
      leadDays === null
        ? null
        : {
            kind,
            officeId,
            startIso: base.startIso,
            endIso: base.endIso,
            today: base.today,
            leadDays,
            stockKind: products ? stockKind : null,
            category: category || null,
            search,
            deviceStatus: products ? 'all' : deviceStatus,
          },
    [kind, officeId, base, leadDays, products, stockKind, category, search, deviceStatus],
  );
  const key = query ? JSON.stringify(query) : '';

  const [data, setData] = useState<Loaded>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const pendingOffset = useRef<number | null>(null);

  // 设置里的到期前几天（快到期名单要用）：一打开就读，读到了才能查第一页
  useEffect(() => {
    let alive = true;
    getSettings(db)
      .then((settings) => {
        if (alive) setLeadDays(settings.expiryLeadDays);
      })
      .catch(() => {
        if (alive) setLeadDays(7);
      });
    return () => {
      alive = false;
    };
  }, [db]);

  const toRows = useCallback(
    (items: readonly ReportDetailItem[]) => items.map((item) => detailRowView(kind, item, base.today, leadDays ?? 7, lending)),
    [kind, base.today, leadDays, lending],
  );

  // 条件变了：从第一页重取（取到之前列表照旧显示上一次的）。刚打开时马上开始读，打开动画结束后才交给列表去画
  useEffect(() => {
    if (!query) return;
    const current = ++generation.current;
    pendingOffset.current = null;
    afterOpen(loadDetailPage(db, query, 0, DETAIL_PAGE_SIZE)).then(
      (page) => {
        if (current !== generation.current) return;
        setError(null);
        if (page.categories) setCategories(page.categories);
        setData({ key, rows: toRows(page.items), nextOffset: page.nextOffset, total: page.total });
      },
      (reason: unknown) => {
        if (current === generation.current) setError(reason instanceof Error ? reason.message : '没能读到数据，请重试');
      },
    );
  }, [db, query, key, toRows, afterOpen]);

  const loadMore = useCallback(() => {
    if (!query || data.key !== key || data.nextOffset === null || pendingOffset.current === data.nextOffset) return;
    const offset = data.nextOffset;
    const current = generation.current;
    pendingOffset.current = offset;
    setLoadingMore(true);
    loadDetailPage(db, query, offset, DETAIL_PAGE_SIZE)
      .then((page) => {
        if (current !== generation.current) return;
        const more = toRows(page.items);
        setData((previous) =>
          previous.key === key && previous.nextOffset === offset
            ? { ...previous, rows: [...previous.rows, ...more], nextOffset: page.nextOffset }
            : previous,
        );
      })
      .catch(() => {
        // 取下一页失败：下次滑到底再试
        if (pendingOffset.current === offset) pendingOffset.current = null;
      })
      .finally(() => {
        if (current === generation.current) setLoadingMore(false);
      });
  }, [db, query, key, data, toRows]);

  // 换了大类：分类选项跟着变，已选的分类清掉
  const chooseKind = useCallback((value: KindFilter) => {
    setKindFilter(value);
    setCategory('');
  }, []);

  const firstLoad = data.key === '' && !error;
  const switching = data.key !== '' && data.key !== key;
  const officeText = officeId === null ? (office.multiple ? `全部${terms.place}` : (office.offices[0]?.name ?? '')) : office.officeName(officeId);
  const scope = [officeText, detailUsesPeriod(kind) ? base.label : '现在'].filter(Boolean).join(' · ');
  // 家庭场景不分借出、在库
  const statusOptions = useMemo(
    () => (lending ? DEVICE_STATUS_OPTIONS : DEVICE_STATUS_OPTIONS.filter((option) => option.value !== 'out' && option.value !== 'inStock')),
    [lending],
  );
  const categoryOptions = useMemo(
    () => [{ value: '', label: products ? '全部分类' : '全部类别' }, ...categories.map((value) => ({ value, label: value }))],
    [categories, products],
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: DETAIL_TITLE[kind] }} />
      <View style={styles.filters}>
        <View style={styles.scopeRow}>
          <Text style={styles.scope} numberOfLines={1}>
            {scope}
          </Text>
          {switching || firstLoad ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : data.total !== null ? (
            <Text style={styles.total}>共 {data.total} 条</Text>
          ) : null}
        </View>
        <SearchField
          placeholder={products ? '搜索名称' : lending ? '搜索名称、型号、序列号或使用人' : '搜索名称、型号、序列号或谁在用'}
          value={text}
          onChangeText={setText}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {products ? (
          <Segmented
            options={[
              { value: 'all' as KindFilter, label: '全部' },
              { value: 'food' as KindFilter, label: KIND_LABEL.food },
              { value: 'daily' as KindFilter, label: KIND_LABEL.daily },
            ]}
            value={kindFilter}
            onChange={chooseKind}
          />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <ChoiceChips options={statusOptions} value={deviceStatus} onChange={setDeviceStatus} />
          </ScrollView>
        )}
        {categories.length >= 2 ? (
          // 一排，放不下左右滑
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <ChoiceChips options={categoryOptions} value={category} onChange={setCategory} />
          </ScrollView>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={data.rows}
        keyExtractor={rowKey}
        renderItem={renderRow}
        getItemLayout={rowLayout}
        onEndReached={loadMore}
        onEndReachedThreshold={1}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
        windowSize={11}
        ListEmptyComponent={
          firstLoad || switching ? undefined : <Empty icon="search-outline" title="没有符合条件的" text="换个关键词或筛选条件试试。" />
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" color={colors.accent} />
            </View>
          ) : data.rows.length > 0 && data.nextOffset === null ? (
            <Text style={styles.end}>已经到底了</Text>
          ) : undefined
        }
      />
    </View>
  );
}

/** 明细的一行：标题、下面一行小字、右边数值；整行能点，进物品或设备详情。memo：翻页时已经画好的行不重画 */
const DetailRow = memo(function DetailRow({ row }: { row: DetailRowView }) {
  const colors = useColors();
  const styles = useDetailStyles();
  const valueColor = row.tone === 'danger' ? colors.danger : row.tone === 'warn' ? colors.warn : row.tone === 'info' ? colors.info : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openRow(row)}
      unstable_pressDelay={LIST_PRESS_DELAY}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {row.subtitle}
        </Text>
      </View>
      <Text style={[styles.rowValue, { color: valueColor }]} numberOfLines={1}>
        {row.value}
      </Text>
      <Ionicons name="chevron-forward" size={16} color={colors.faint} />
    </Pressable>
  );
});

const useDetailStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  filters: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  scopeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 },
  scope: { flex: 1, minWidth: 0, fontSize: font.small, color: colors.muted },
  total: { fontSize: font.small, color: colors.muted, fontVariant: ['tabular-nums'] },
  list: { flex: 1 },
  listContent: { paddingBottom: 32 },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: font.body, color: colors.ink },
  rowSubtitle: { fontSize: font.small, color: colors.muted },
  rowValue: { maxWidth: '40%', fontSize: font.body, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'right' },
  footer: { paddingVertical: 16, alignItems: 'center' },
  end: { paddingVertical: 16, textAlign: 'center', fontSize: font.small, color: colors.faint },
  error: { fontSize: font.small, color: colors.danger },
}));
