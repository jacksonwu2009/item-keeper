import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from 'react-native';
import { Text } from '../components/Text';

import { BarList, ChartPlaceholder, ColumnChart, SegmentBar, StatRow, type StatItem } from '../components/ReportCharts';
import { Button, Card, ChoiceChips, Label, SectionTitle } from '../components/ui';
import { ALL_OFFICES } from '../db/offices';
import { loadReportSource } from '../db/report';
import { loadOverviewRows } from '../db/reportOverview';
import { getSettings } from '../db/settings';
import { useFocusData } from '../hooks/useFocusData';
import { useOffice } from '../hooks/useOffice';
import { useOpenAnimationDone } from '../hooks/useOpenAnimationDone';
import { useScene } from '../hooks/useScene';
import { makeStyles, useColors } from '../hooks/useTheme';
import { toCsv } from '../lib/csv';
import { todayStr } from '../lib/dates';
import { shareCsv } from '../lib/exportCsv';
import { formatPrice } from '../lib/price';
import { deviceTable, movementTable, PERIOD_OPTIONS, periodRange, reportFileName, stockTable, type CsvTable, type ReportPeriodKey } from '../lib/report';
import {
  buildOverview,
  EMPTY_OVERVIEW_ROWS,
  isLossNote,
  periodBuckets,
  type BarDatum,
  type DeviceStatusFilter,
  type ReportDetailKind,
  type ReportOverview,
} from '../lib/reportOverview';
import { KIND_LABEL } from '../lib/stock';
import { font } from '../theme';

type ExportKind = 'movements' | 'stock' | 'devices';

/** 首页的数据：key 是读的时候的办公点和时间段（换了条件、新的还没读完时，页面照旧显示上一次的，标出「正在统计」） */
type OverviewData = { key: string; periodLabel: string; columnsTitle: string; overview: ReportOverview; rowsJson: string };

const EMPTY_DATA: OverviewData = {
  key: '',
  periodLabel: '',
  columnsTitle: '',
  overview: buildOverview(EMPTY_OVERVIEW_ROWS, []),
  rowsJson: '',
};

function openProduct(productId: number) {
  router.push({ pathname: '/stock/[id]', params: { id: String(productId) } });
}

function openProductByKey(key: string) {
  openProduct(Number(key));
}

/**
 * 报表首页：图表为主，只放汇总（读本机库时用 GROUP BY 直接算出数字），明细点每块右上角的「更多」另开一页（report-detail）。
 * 打开时先显示页面框架和占位，打开动画结束后才读库；换办公点、时间段时照旧显示上一次的，读完换上。
 */
export default function ReportScreen() {
  const colors = useColors();
  const styles = useReportStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene, terms } = useScene();
  // 家庭场景：设备不看借出、在库和领用排行
  const home = scene === 'home';
  const [officeChoice, setOfficeChoice] = useState<number>(office.filterId ?? ALL_OFFICES);
  const [periodKey, setPeriodKey] = useState<ReportPeriodKey>('thisMonth');
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  // 选中的办公点被删了就按全部算
  const officeFilter =
    officeChoice !== ALL_OFFICES && office.offices.some((item) => item.id === officeChoice) ? officeChoice : null;
  const key = `${officeFilter ?? 'all'}:${periodKey}`;
  const waitForOpen = useOpenAnimationDone();
  const previous = useRef<OverviewData>(EMPTY_DATA);

  const loader = useCallback(async (): Promise<OverviewData> => {
    await waitForOpen();
    const now = new Date();
    const settings = await getSettings(db);
    const period = periodRange(periodKey, now);
    const buckets = periodBuckets(periodKey, now);
    const rows = await loadOverviewRows(db, officeFilter, period, buckets, todayStr(now), settings.expiryLeadDays);
    // 回到这一页时会重读一次：数都没变就沿用上一次的对象，图不重画
    const rowsJson = JSON.stringify([rows, buckets.map((bucket) => bucket.label)]);
    const last = previous.current;
    if (last.key === key && last.rowsJson === rowsJson) return last;
    const next: OverviewData = {
      key,
      periodLabel: period.label,
      columnsTitle: periodKey === 'thisMonth' || periodKey === 'lastMonth' ? '按周' : '按月',
      overview: buildOverview(rows, buckets.map((bucket) => bucket.label)),
      rowsJson,
    };
    previous.current = next;
    return next;
  }, [db, officeFilter, periodKey, key, waitForOpen]);
  const [data, , loaded] = useFocusData(loader, EMPTY_DATA);
  const switching = loaded && data.key !== key;
  const { overview } = data;

  const openDetail = useCallback(
    (kind: ReportDetailKind, deviceStatus?: DeviceStatusFilter) => {
      router.push({
        pathname: '/report-detail',
        params: { kind, office: officeFilter === null ? '' : String(officeFilter), period: periodKey, ...(deviceStatus ? { status: deviceStatus } : {}) },
      });
    },
    [officeFilter, periodKey],
  );

  const inventoryStats = useMemo<StatItem[]>(
    () => [
      { key: 'low', label: '库存不足', value: String(overview.inventory.lowStock), tone: 'warn', onPress: () => openDetail('lowStock') },
      { key: 'soon', label: '快到期', value: String(overview.inventory.expiring), tone: 'warn', onPress: () => openDetail('expiring') },
      { key: 'expired', label: '已过期', value: String(overview.inventory.expired), tone: 'danger', onPress: () => openDetail('expired') },
    ],
    [overview.inventory, openDetail],
  );
  const kindSegments = useMemo(
    () => [
      { key: 'food', label: KIND_LABEL.food, value: overview.inventory.byKind.food, text: `${overview.inventory.byKind.food} 种`, tone: 'accent' as const },
      { key: 'daily', label: KIND_LABEL.daily, value: overview.inventory.byKind.daily, text: `${overview.inventory.byKind.daily} 种`, tone: 'info' as const },
    ],
    [overview.inventory],
  );
  const purchaseStats = useMemo<StatItem[]>(
    () => [
      { key: 'amount', label: '进货金额', value: formatPrice(overview.purchases.amount) },
      { key: 'count', label: '入库次数', value: String(overview.purchases.count) },
    ],
    [overview.purchases],
  );
  const consumptionStats = useMemo<StatItem[]>(
    () => [
      { key: 'count', label: '出库次数', value: String(overview.consumption.count) },
      {
        key: 'losses',
        label: '过期丢弃和坏了',
        value: String(overview.consumption.losses.count),
        tone: overview.consumption.losses.count > 0 ? 'warn' : undefined,
        onPress: overview.consumption.losses.count > 0 ? () => openDetail('losses') : undefined,
      },
      { key: 'estimate', label: '估算损失', value: formatPrice(overview.consumption.losses.estimatedTotal) },
    ],
    [overview.consumption, openDetail],
  );
  const topConsumers = useMemo<BarDatum[]>(
    () => overview.consumption.top.map((row) => ({ key: String(row.productId), label: row.name, value: row.count, text: `${row.count} 次` })),
    [overview.consumption.top],
  );
  const deviceStats = useMemo<StatItem[]>(
    () => [
      { key: 'total', label: '设备', value: `${overview.devices.total} 件` },
      {
        key: 'soon',
        label: '保修快到期',
        value: String(overview.devices.warrantySoon),
        tone: overview.devices.warrantySoon > 0 ? 'warn' : undefined,
        onPress: () => openDetail('devices', 'warrantySoon'),
      },
      {
        key: 'expired',
        label: '已过保',
        value: String(overview.devices.warrantyExpired),
        tone: overview.devices.warrantyExpired > 0 ? 'danger' : undefined,
        onPress: () => openDetail('devices', 'warrantyExpired'),
      },
    ],
    [overview.devices, openDetail],
  );
  const deviceSegments = useMemo(
    () => [
      { key: 'out', label: '借出', value: overview.devices.out, text: `${overview.devices.out} 件`, tone: 'info' as const },
      { key: 'in', label: '在库', value: overview.devices.inStock, text: `${overview.devices.inStock} 件`, tone: 'ok' as const },
    ],
    [overview.devices],
  );

  async function exportTable(kind: ExportKind) {
    // 导出要逐条的数据：点了才读
    setExporting(kind);
    try {
      const today = todayStr();
      const period = periodRange(periodKey);
      const source = await loadReportSource(db, officeFilter, period);
      const officeNameOf = (officeId: number) => source.officeNames.get(officeId) ?? '';
      // 文件名里的办公点：选了某个办公点用它的名字；只有一个办公点时也用它的名字
      const officeLabel =
        officeFilter !== null ? office.officeName(officeFilter) : office.multiple ? null : (office.offices[0]?.name ?? null);
      let table: CsvTable;
      let fileName: string;
      if (kind === 'movements') {
        if (!source.movements.length) {
          Alert.alert('没有可导出的记录', `${period.label}没有出入库记录。`);
          return;
        }
        table = movementTable(source.movements, officeNameOf);
        fileName = reportFileName('出入库明细', officeLabel, period.label);
      } else if (kind === 'stock') {
        table = stockTable(source.products, source.batches, officeNameOf);
        fileName = reportFileName('当前库存', officeLabel, today);
      } else {
        table = deviceTable(source.devices, source.accessoriesByDevice, officeNameOf);
        fileName = reportFileName('设备清单', officeLabel, today);
      }
      await shareCsv(fileName, toCsv(table.header, table.rows));
    } catch (error) {
      Alert.alert('导出失败', error instanceof Error ? error.message : '请重试');
    } finally {
      setExporting(null);
    }
  }

  const periodLabel = loaded ? data.periodLabel : periodRange(periodKey).label;
  const periodSuffix = `（${periodLabel}）`;
  const { purchases, consumption, devices, inventory } = overview;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: '报表' }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Card>
          {office.multiple ? (
            <View style={styles.group}>
              <Label>{terms.place}</Label>
              <ChoiceChips
                options={[{ value: ALL_OFFICES, label: '全部' }, ...office.offices.map((item) => ({ value: item.id, label: item.name }))]}
                value={officeFilter ?? ALL_OFFICES}
                onChange={setOfficeChoice}
              />
            </View>
          ) : null}
          <View style={styles.group}>
            <Label>时间段</Label>
            <ChoiceChips options={PERIOD_OPTIONS} value={periodKey} onChange={setPeriodKey} />
          </View>
          <View style={styles.hintRow}>
            <Text style={[styles.hint, styles.hintText]}>进货、消耗按 {periodRange(periodKey).label} 统计；库存概况和设备是现在的情况。</Text>
            {!loaded || switching ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          </View>
        </Card>

        <Section title="库存概况" onMore={() => openDetail('products')} moreLabel="物品明细">
          {!loaded ? (
            <ChartPlaceholder lines={1} />
          ) : (
            <>
              <StatRow items={inventoryStats} />
              <SegmentBar segments={kindSegments} />
              <Text style={styles.hint}>共 {inventory.total} 种；点上面的数看名单。</Text>
            </>
          )}
        </Section>

        <Section title={`进货${periodSuffix}`} onMore={() => openDetail('purchases')} moreLabel="进货明细">
          {!loaded ? (
            <ChartPlaceholder lines={4} />
          ) : purchases.count === 0 ? (
            <Text style={styles.muted}>这段时间没有入库。</Text>
          ) : (
            <>
              <StatRow items={purchaseStats} />
              {purchases.unpricedCount > 0 ? (
                <Text style={styles.hint}>{purchases.unpricedCount} 次入库没填价格，没算进金额。</Text>
              ) : null}
              <Text style={styles.subTitle}>进货金额{data.columnsTitle}</Text>
              <ColumnChart columns={purchases.columns} />
              {purchases.categories.length ? (
                <>
                  <Text style={styles.subTitle}>按分类</Text>
                  <BarList items={purchases.categories} tone="accent" />
                </>
              ) : null}
            </>
          )}
        </Section>

        <Section title={`消耗${periodSuffix}`} onMore={() => openDetail('consumption')} moreLabel="消耗明细">
          {!loaded ? (
            <ChartPlaceholder lines={4} />
          ) : consumption.count === 0 ? (
            <Text style={styles.muted}>这段时间没有出库。</Text>
          ) : (
            <>
              <StatRow items={consumptionStats} />
              {consumption.losses.unestimatedCount > 0 ? (
                <Text style={styles.hint}>
                  估算损失按出库前最近一次的进价算；{consumption.losses.unestimatedCount} 条没有进价，没算进去。
                </Text>
              ) : (
                <Text style={styles.hint}>估算损失按出库前最近一次的进价算。</Text>
              )}
              <Text style={styles.subTitle}>按原因</Text>
              <BarList items={consumption.reasons} toneOf={reasonTone} />
              <Text style={styles.subTitle}>出库次数最多</Text>
              <BarList items={topConsumers} tone="info" onPressItem={openProductByKey} />
            </>
          )}
        </Section>

        <Section title="设备" onMore={() => openDetail('devices')} moreLabel="设备明细">
          {!loaded ? (
            <ChartPlaceholder lines={3} />
          ) : devices.total === 0 ? (
            <Text style={styles.muted}>还没有设备。</Text>
          ) : (
            <>
              <StatRow items={deviceStats} />
              {home ? null : <SegmentBar segments={deviceSegments} />}
              <Text style={styles.subTitle}>按类别</Text>
              <BarList items={devices.categories} tone="accent" />
              {!home && devices.holders.length ? (
                <>
                  <Text style={styles.subTitle}>领用最多</Text>
                  <BarList items={devices.holders} tone="info" />
                </>
              ) : null}
            </>
          )}
        </Section>

        <SectionTitle title="导出表格" />
        <Card style={styles.exportCard}>
          <Text style={styles.hint}>导出成 CSV 文件，可以用 Excel、WPS、Numbers 打开，或者直接发给同事。</Text>
          <Button
            title={`导出出入库明细（${periodRange(periodKey).label}）`}
            icon="list-outline"
            variant="secondary"
            loading={exporting === 'movements'}
            onPress={() => exportTable('movements')}
          />
          <Button title="导出当前库存" icon="cube-outline" variant="secondary" loading={exporting === 'stock'} onPress={() => exportTable('stock')} />
          <Button
            title="导出设备清单"
            icon="laptop-outline"
            variant="secondary"
            loading={exporting === 'devices'}
            onPress={() => exportTable('devices')}
          />
        </Card>
      </ScrollView>
    </View>
  );
}

/** 损耗的原因用提示色 */
function reasonTone(item: BarDatum) {
  return isLossNote(item.key) ? ('warn' as const) : ('accent' as const);
}

/** 一块：标题（右边「更多」进明细）+ 卡片 */
function Section({
  title,
  onMore,
  moreLabel,
  children,
}: {
  title: string;
  onMore?: () => void;
  moreLabel?: string;
  children: ReactNode;
}) {
  const colors = useColors();
  const styles = useReportStyles();
  return (
    <View style={styles.section}>
      <SectionTitle
        title={title}
        right={
          onMore ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={moreLabel ? `更多：${moreLabel}` : '更多'}
              hitSlop={8}
              onPress={onMore}
              style={({ pressed }) => [styles.more, pressed && styles.morePressed]}
            >
              <Text style={[styles.moreText, { color: colors.accent }]}>更多</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.accent} />
            </Pressable>
          ) : null
        }
      />
      <Card style={styles.card}>{children}</Card>
    </View>
  );
}

const useReportStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  // 和原来的 Screen 一样：四周留 16、底下留 40，卡片之间隔 16
  content: { padding: 16, paddingBottom: 40, gap: 16 },
  section: { gap: 0 },
  card: { gap: 4, paddingVertical: 12 },
  group: { gap: 8 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hintText: { flex: 1 },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  muted: { fontSize: font.body, color: colors.muted, paddingVertical: 4 },
  subTitle: { fontSize: font.small, fontWeight: '700', color: colors.muted, marginTop: 12, marginBottom: 2 },
  exportCard: { gap: 8 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 8 },
  morePressed: { backgroundColor: colors.surfaceSunken },
  moreText: { fontSize: font.small, fontWeight: '700' },
}));
