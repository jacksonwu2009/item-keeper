import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View, type ListRenderItem } from 'react-native';
import { Text } from '../components/Text';

import { Button, Card, Chip, ChoiceChips, Label, LIST_PRESS_DELAY, SectionTitle, type Tone } from '../components/ui';
import { ALL_OFFICES } from '../db/offices';
import { EMPTY_REPORT_SOURCE, loadReportSource, type ReportSource } from '../db/report';
import { useFocusData } from '../hooks/useFocusData';
import { useOffice } from '../hooks/useOffice';
import { useScene } from '../hooks/useScene';
import { toCsv } from '../lib/csv';
import { formatShortDate, toDateStr, todayStr } from '../lib/dates';
import { shareCsv } from '../lib/exportCsv';
import { formatPrice } from '../lib/price';
import {
  deviceTable,
  movementTable,
  PERIOD_OPTIONS,
  periodRange,
  productDetails,
  reportFileName,
  stockTable,
  summarizeConsumption,
  summarizeDevices,
  summarizeInventory,
  summarizePurchases,
  type CsvTable,
  type ProductDetailRow,
  type ProductRef,
  type ReportPeriodKey,
} from '../lib/report';
import { formatQty, KIND_LABEL } from '../lib/stock';
import { makeStyles, useColors } from '../hooks/useTheme';
import { font, radius } from '../theme';

/** 物品明细先显示这么多行，多了点「查看全部」 */
const DETAIL_PREVIEW_ROWS = 30;
/** 过期丢弃和坏了先显示这么多条，多了点「查看全部」 */
const LOSS_PREVIEW_ROWS = 10;
/** 领用排行先显示这么多人 */
const HOLDER_PREVIEW_ROWS = 10;

type ExportKind = 'movements' | 'stock' | 'devices';

function openProduct(productId: number) {
  router.push({ pathname: '/stock/[id]', params: { id: String(productId) } });
}

function openDevice(deviceId: number) {
  router.push({ pathname: '/device/[id]', params: { id: String(deviceId) } });
}

/**
 * 报表上的各项汇总：在读完数据时算一次（不是每次渲染都把几万条出入库记录算一遍），回到前台、换时间段重读时再算。
 * 库存概况、设备按「今天」算。
 */
function summarizeSource(source: ReportSource, today: string) {
  return {
    inventory: summarizeInventory(source.products, today, source.settings.expiryLeadDays),
    purchases: summarizePurchases(source.movements),
    consumption: summarizeConsumption(source.movements, source.priceHistory),
    details: productDetails(source.products, source.movements),
    devices: summarizeDevices(source.devices, source.assignments, today),
  };
}

const EMPTY_SUMMARY = summarizeSource(EMPTY_REPORT_SOURCE, todayStr());

/** 物品明细的一行，以及要不要在它上面写分类（食品、日用品各组的第一行） */
type DetailItem = { row: ProductDetailRow; kindTitle: boolean };

/** ISO 时间按手机本地日期显示成「11月18日」 */
function localDay(iso: string): string {
  return formatShortDate(toDateStr(new Date(iso)));
}

export default function ReportScreen() {
  const colors = useColors();
  const reportStyles = useReportStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene, terms } = useScene();
  // 家庭场景：设备不看借出、在库和领用排行
  const home = scene === 'home';
  const [officeChoice, setOfficeChoice] = useState<number>(office.filterId ?? ALL_OFFICES);
  const [periodKey, setPeriodKey] = useState<ReportPeriodKey>('thisMonth');
  const [showAllDetails, setShowAllDetails] = useState(false);
  const [showAllHolders, setShowAllHolders] = useState(false);
  const [showAllLosses, setShowAllLosses] = useState(false);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  // 选中的办公点被删了就按全部算
  const officeFilter =
    officeChoice !== ALL_OFFICES && office.offices.some((item) => item.id === officeChoice) ? officeChoice : null;

  const loader = useCallback(async () => {
    const period = periodRange(periodKey);
    const source = await loadReportSource(db, officeFilter, period);
    return { period, source, summary: summarizeSource(source, todayStr()) };
  }, [db, officeFilter, periodKey]);
  const [data, , loaded] = useFocusData(loader, { period: periodRange('thisMonth'), source: EMPTY_REPORT_SOURCE, summary: EMPTY_SUMMARY });
  const { period, source } = data;
  const { inventory, purchases, consumption, details, devices } = data.summary;

  // 物品明细是下面那个列表的数据：先显示前 30 行，「查看全部」后几千行也只画看得见的
  const detailItems = useMemo<DetailItem[]>(() => {
    const visible = showAllDetails ? details : details.slice(0, DETAIL_PREVIEW_ROWS);
    return visible.map((row, index) => ({ row, kindTitle: index === 0 || visible[index - 1].kind !== row.kind }));
  }, [details, showAllDetails]);
  // 文件名里的办公点：选了某个办公点用它的名字；只有一个办公点时也用它的名字
  const officeLabel =
    officeFilter !== null ? office.officeName(officeFilter) : office.multiple ? null : (office.offices[0]?.name ?? null);
  const officeNameOf = (officeId: number) => source.officeNames.get(officeId) ?? '';

  async function exportTable(kind: ExportKind) {
    const today = todayStr();
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
    setExporting(kind);
    try {
      await shareCsv(fileName, toCsv(table.header, table.rows));
    } catch (error) {
      Alert.alert('导出失败', error instanceof Error ? error.message : '请重试');
    } finally {
      setExporting(null);
    }
  }

  if (!loaded) return <Stack.Screen options={{ title: '报表' }} />;

  const visibleLosses = showAllLosses ? consumption.losses : consumption.losses.slice(0, LOSS_PREVIEW_ROWS);
  const visibleHolders = showAllHolders ? devices.holders : devices.holders.slice(0, HOLDER_PREVIEW_ROWS);
  const periodSuffix = `（${period.label}）`;

  const header = (
    <View style={reportStyles.section}>
      <Card>
        {office.multiple ? (
          <View style={reportStyles.group}>
            <Label>{terms.place}</Label>
            <ChoiceChips
              options={[
                { value: ALL_OFFICES, label: '全部' },
                ...office.offices.map((item) => ({ value: item.id, label: item.name })),
              ]}
              value={officeFilter ?? ALL_OFFICES}
              onChange={setOfficeChoice}
            />
          </View>
        ) : null}
        <View style={reportStyles.group}>
          <Label>时间段</Label>
          <ChoiceChips options={PERIOD_OPTIONS} value={periodKey} onChange={setPeriodKey} />
        </View>
        <Text style={reportStyles.hint}>
          进货、消耗、物品明细按 {period.label} 统计；库存概况和设备是现在的情况。
        </Text>
      </Card>

      <SectionTitle title="库存概况" />
      <Card style={reportStyles.tightCard}>
        <Text style={reportStyles.lead}>
          食品 {inventory.productCount.food} 种 · 日用品 {inventory.productCount.daily} 种
        </Text>
        <ExpandableList title="库存不足" items={inventory.lowStock} tone="warn" />
        <ExpandableList title="快到期" items={inventory.expiringSoon} tone="warn" />
        <ExpandableList title="已过期" items={inventory.expired} tone="danger" />
      </Card>

      <SectionTitle title={`进货${periodSuffix}`} />
      <Card style={reportStyles.tightCard}>
        {purchases.stockInCount === 0 ? (
          <Text style={reportStyles.muted}>这段时间没有入库。</Text>
        ) : (
          <>
            <View style={reportStyles.statRow}>
              <BigNumber label="进货金额" value={formatPrice(purchases.pricedAmount)} />
              <BigNumber label="入库次数" value={String(purchases.stockInCount)} />
            </View>
            {purchases.unpricedCount > 0 ? (
              <Text style={[reportStyles.hint, reportStyles.hintAboveRows]}>{purchases.unpricedCount} 次入库没填价格，没算进去。</Text>
            ) : null}
            <ValueRow name="食品" value={formatPrice(purchases.amountByKind.food)} />
            <ValueRow name="日用品" value={formatPrice(purchases.amountByKind.daily)} />
            {purchases.topProducts.length ? (
              <>
                <Text style={reportStyles.subTitle}>金额最高</Text>
                {purchases.topProducts.map((rank) => (
                  <ValueRow
                    key={rank.productId}
                    name={rank.name}
                    detail={`${KIND_LABEL[rank.kind]} · 入库 ${rank.count} 次`}
                    value={formatPrice(rank.amount)}
                    onPress={() => openProduct(rank.productId)}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </Card>

      <SectionTitle title={`消耗${periodSuffix}`} />
      <Card style={reportStyles.tightCard}>
        {consumption.stockOutCount === 0 ? (
          <Text style={reportStyles.muted}>这段时间没有出库。</Text>
        ) : (
          <>
            <Text style={reportStyles.lead}>出库 {consumption.stockOutCount} 次</Text>
            <View style={reportStyles.chips}>
              {consumption.reasons.map((item) => (
                <Chip
                  key={item.reason}
                  text={`${item.reason} ${item.count} 次`}
                  tone={item.reason === '过期丢弃' || item.reason === '坏了' ? 'warn' : 'neutral'}
                />
              ))}
            </View>
            <Text style={reportStyles.subTitle}>出库次数最多</Text>
            {consumption.topProducts.map((rank) => (
              <ValueRow
                key={rank.productId}
                name={rank.name}
                detail={`${KIND_LABEL[rank.kind]} · 共 ${formatQty(rank.quantity)} ${rank.unit}`}
                value={`${rank.count} 次`}
                onPress={() => openProduct(rank.productId)}
              />
            ))}
            {consumption.losses.length ? (
              <>
                <Text style={reportStyles.subTitle}>过期丢弃和坏了</Text>
                {visibleLosses.map((loss) => (
                  <ValueRow
                    key={loss.movementId}
                    name={loss.name}
                    detail={`${localDay(loss.happenedAt)} · ${loss.reason} ${formatQty(loss.quantity)} ${loss.unit}`}
                    value={loss.estimatedLoss === null ? '—' : formatPrice(loss.estimatedLoss)}
                    onPress={() => openProduct(loss.productId)}
                  />
                ))}
                {consumption.losses.length > LOSS_PREVIEW_ROWS ? (
                  <Button
                    title={showAllLosses ? '收起' : `查看全部 ${consumption.losses.length} 条`}
                    variant="ghost"
                    compact
                    onPress={() => setShowAllLosses((value) => !value)}
                  />
                ) : null}
                <Text style={reportStyles.hint}>
                  估算损失 {formatPrice(consumption.estimatedLossTotal)}（按出库前最近一次的进价算）
                  {consumption.unestimatedLossCount > 0
                    ? `；${consumption.unestimatedLossCount} 条没有进价，没算进去`
                    : ''}
                  。
                </Text>
              </>
            ) : null}
          </>
        )}
      </Card>

      <SectionTitle title={`物品明细${periodSuffix}`} />
      {details.length === 0 ? (
        <Card style={reportStyles.tightCard}>
          <Text style={reportStyles.muted}>还没有食品和日用品。</Text>
        </Card>
      ) : (
        // 明细卡片的上沿；明细一行一行是下面列表的数据，卡片下沿（说明、查看全部）在列表的页脚里
        <View style={reportStyles.detailCardTop} />
      )}
    </View>
  );

  const footer = (
    <View style={reportStyles.section}>
      {details.length > 0 ? (
        <View style={reportStyles.detailCardBottom}>
          <Text style={reportStyles.hint}>右边是这段时间的进货金额，没填价格的显示「—」。</Text>
          {details.length > DETAIL_PREVIEW_ROWS ? (
            <Button
              title={showAllDetails ? '收起' : `查看全部 ${details.length} 个`}
              variant="ghost"
              compact
              onPress={() => setShowAllDetails((value) => !value)}
            />
          ) : null}
        </View>
      ) : (
        // 没有明细时页头最后是那张「还没有」的卡片：放一个空的占位，下面的「设备」和它照样隔 16
        <View />
      )}

      <SectionTitle title="设备" />
      <Card style={reportStyles.tightCard}>
        {source.devices.length === 0 ? (
          <Text style={reportStyles.muted}>还没有设备。</Text>
        ) : (
          <>
            <View style={reportStyles.statRow}>
              <BigNumber label="共" value={`${devices.total} 件`} />
              {home ? null : (
                <>
                  <BigNumber label="借出" value={String(devices.out)} color={devices.out > 0 ? colors.info : colors.ink} />
                  <BigNumber label="在库" value={String(devices.inStock)} color={colors.ok} />
                </>
              )}
            </View>
            {devices.byCategory.map((row) => (
              <ValueRow
                key={row.category}
                name={row.category}
                detail={home ? undefined : `借出 ${row.out} · 在库 ${row.inStock}`}
                value={`${row.total} 件`}
              />
            ))}
            {devices.byConfig.length ? (
              <>
                <Text style={reportStyles.subTitle}>电脑配置</Text>
                {devices.byConfig.map((row) => (
                  <ValueRow
                    key={row.config}
                    name={row.config}
                    detail={home ? undefined : `借出 ${row.out} · 在库 ${row.inStock}`}
                    value={`${row.total} 台`}
                  />
                ))}
              </>
            ) : null}
            {devices.warrantySoonQty || devices.warrantyExpiredQty ? (
              <>
                <Text style={reportStyles.subTitle}>保修</Text>
                {devices.warrantySoon.map((item) => (
                  <ValueRow
                    key={item.deviceId}
                    name={item.name}
                    detail={item.text}
                    value={`${item.quantity} 件`}
                    tone="warn"
                    onPress={() => openDevice(item.deviceId)}
                  />
                ))}
                {devices.warrantyExpired.map((item) => (
                  <ValueRow
                    key={item.deviceId}
                    name={item.name}
                    detail={item.text}
                    value={`${item.quantity} 件`}
                    tone="danger"
                    onPress={() => openDevice(item.deviceId)}
                  />
                ))}
                <Text style={reportStyles.hint}>
                  30 天内到期 {devices.warrantySoonQty} 件，已过保 {devices.warrantyExpiredQty} 件。
                </Text>
              </>
            ) : (
              <Text style={reportStyles.hint}>没有 30 天内到期或已过保的设备。</Text>
            )}
            {!home && devices.holders.length ? (
              <>
                <Text style={reportStyles.subTitle}>领用排行</Text>
                {visibleHolders.map((holder) => (
                  <ValueRow key={holder.person} name={holder.person} value={`${holder.quantity} 件`} />
                ))}
                {devices.holders.length > HOLDER_PREVIEW_ROWS ? (
                  <Button
                    title={showAllHolders ? '收起' : `查看全部 ${devices.holders.length} 人`}
                    variant="ghost"
                    compact
                    onPress={() => setShowAllHolders((value) => !value)}
                  />
                ) : null}
              </>
            ) : null}
          </>
        )}
      </Card>

      <SectionTitle title="导出表格" />
      <Card style={reportStyles.exportCard}>
        <Text style={reportStyles.hint}>导出成 CSV 文件，可以用 Excel、WPS、Numbers 打开，或者直接发给同事。</Text>
        <Button
          title={`导出出入库明细（${period.label}）`}
          icon="list-outline"
          variant="secondary"
          loading={exporting === 'movements'}
          onPress={() => exportTable('movements')}
        />
        <Button
          title="导出当前库存"
          icon="cube-outline"
          variant="secondary"
          loading={exporting === 'stock'}
          onPress={() => exportTable('stock')}
        />
        <Button
          title="导出设备清单"
          icon="laptop-outline"
          variant="secondary"
          loading={exporting === 'devices'}
          onPress={() => exportTable('devices')}
        />
      </Card>
    </View>
  );

  // 整页是一个列表：上面的汇总卡片是页头，物品明细一行一行是列表的数据，设备和导出是页脚。
  // 明细「查看全部」后有几千行时，只画屏幕上看得见的几行
  return (
    <View style={reportStyles.screen}>
      <Stack.Screen options={{ title: '报表' }} />
      <FlatList
        style={reportStyles.screen}
        contentContainerStyle={reportStyles.listContent}
        data={detailItems}
        keyExtractor={detailKey}
        renderItem={renderDetail}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        initialNumToRender={DETAIL_PREVIEW_ROWS}
        windowSize={11}
      />
    </View>
  );
}

function detailKey(item: DetailItem): string {
  return String(item.row.productId);
}

const renderDetail: ListRenderItem<DetailItem> = ({ item }) => <DetailRow row={item.row} kindTitle={item.kindTitle} />;

/** 物品明细的一行（白底，左右留 16，连起来是一张卡片）；memo：展开、收起时已经画好的行不重画 */
const DetailRow = memo(function DetailRow({ row, kindTitle }: { row: ProductDetailRow; kindTitle: boolean }) {
  const reportStyles = useReportStyles();
  return (
    <View style={reportStyles.detailRow}>
      {kindTitle ? <Text style={reportStyles.subTitle}>{KIND_LABEL[row.kind]}</Text> : null}
      <ValueRow
        name={row.name}
        detail={`入 ${formatQty(row.inQty)} · 出 ${formatQty(row.outQty)} · 现有 ${formatQty(row.currentQty)} ${row.unit}`}
        value={row.purchaseAmount === null ? '—' : formatPrice(row.purchaseAmount)}
        onPress={() => openProduct(row.productId)}
      />
    </View>
  );
});

/** 一个大数字 + 下面的说明，居中（照鸿蒙版 IkBigNumber）；color 不给就是黑字 */
function BigNumber({ label, value, color }: { label: string; value: string; color?: string }) {
  const colors = useColors();
  const reportStyles = useReportStyles();
  return (
    <View style={reportStyles.bigNumber}>
      <Text style={[reportStyles.bigValue, { color: color ?? colors.ink }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={reportStyles.bigLabel}>{label}</Text>
    </View>
  );
}

/** 一行：左边名称（下面一行小字），右边数值；能点的带箭头。 */
function ValueRow({
  name,
  detail,
  value,
  tone,
  onPress,
}: {
  name: string;
  detail?: string;
  value: string;
  tone?: Tone;
  onPress?: () => void;
}) {
  const colors = useColors();
  const reportStyles = useReportStyles();
  const valueColor = tone === 'danger' ? colors.danger : tone === 'warn' ? colors.warn : colors.ink;
  const content: ReactNode = (
    <>
      <View style={reportStyles.rowText}>
        <Text style={reportStyles.rowName} numberOfLines={1}>
          {name}
        </Text>
        {detail ? (
          <Text style={reportStyles.rowDetail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Text style={[reportStyles.rowValue, { color: valueColor }]}>{value}</Text>
      {onPress ? <Ionicons name="chevron-forward" size={16} color={colors.faint} /> : null}
    </>
  );
  if (!onPress) return <View style={reportStyles.row}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      unstable_pressDelay={LIST_PRESS_DELAY}
      style={({ pressed }) => [reportStyles.row, pressed && reportStyles.rowPressed]}
    >
      {content}
    </Pressable>
  );
}

/** 「库存不足 3 种」这样一行，点开列出名单，名单里点一个进物品详情。 */
function ExpandableList({ title, items, tone }: { title: string; items: ProductRef[]; tone: Tone }) {
  const colors = useColors();
  const reportStyles = useReportStyles();
  const [open, setOpen] = useState(false);
  const empty = items.length === 0;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: empty }}
        disabled={empty}
        onPress={() => setOpen((value) => !value)}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [reportStyles.row, pressed && reportStyles.rowPressed]}
      >
        <Text style={[reportStyles.rowName, reportStyles.rowText]}>{title}</Text>
        {empty ? <Text style={reportStyles.rowDetail}>没有</Text> : <Chip text={`${items.length} 种`} tone={tone} />}
        {empty ? null : <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.faint} />}
      </Pressable>
      {open
        ? items.map((item) => (
            <Pressable
              key={item.productId}
              accessibilityRole="button"
              onPress={() => openProduct(item.productId)}
              unstable_pressDelay={LIST_PRESS_DELAY}
              style={({ pressed }) => [reportStyles.row, reportStyles.nestedRow, pressed && reportStyles.rowPressed]}
            >
              <Text style={[reportStyles.rowName, reportStyles.rowText]} numberOfLines={1}>
                {item.name}（{KIND_LABEL[item.kind]}）
              </Text>
              <Text style={[reportStyles.rowValue, { color: tone === 'danger' ? colors.danger : colors.warn }]}>
                {item.detail}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.faint} />
            </Pressable>
          ))
        : null}
    </View>
  );
}

// 照鸿蒙版 ReportPage：报表卡片上下留 12、左右 16，里面一行最矮 48、行上面一条分隔线；大数字居中
const useReportStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  // 和原来的 Screen 一样：四周留 16、底下留 40，卡片之间隔 16
  listContent: { padding: 16, paddingBottom: 40 },
  section: { gap: 16 },
  // 物品明细卡片拆成三段：上沿（圆角、上边距 12）、一行一行（左右 16）、下沿（说明、按钮，圆角、下边距 12）
  detailCardTop: {
    height: 12,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  detailRow: { backgroundColor: colors.surface, paddingHorizontal: 16 },
  detailCardBottom: {
    backgroundColor: colors.surface,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  group: { gap: 8 },
  // 报表卡片里行与行紧挨着（靠分隔线隔开），说明文字上面自己留一点
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18, paddingTop: 4 },
  // 说明下面紧跟着带分隔线的行时，下面也留 8，文字不贴着线
  hintAboveRows: { paddingBottom: 8 },
  muted: { fontSize: font.body, color: colors.muted },
  lead: { fontSize: font.body, fontWeight: '500', color: colors.ink, paddingBottom: 8 },
  tightCard: { gap: 0, paddingVertical: 12 },
  exportCard: { gap: 8 },
  subTitle: { fontSize: font.small, fontWeight: '700', color: colors.muted, marginTop: 12, marginBottom: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingTop: 8, paddingBottom: 4 },
  statRow: { flexDirection: 'row' },
  bigNumber: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2, paddingVertical: 8 },
  bigValue: { fontSize: font.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  bigLabel: { fontSize: font.small, color: colors.muted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  nestedRow: { paddingLeft: 16 },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { fontSize: font.body, color: colors.ink },
  rowDetail: { fontSize: font.small, color: colors.muted, marginTop: 1 },
  rowValue: { fontSize: font.body, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'right' },
}));
