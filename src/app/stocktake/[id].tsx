import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Alert, SectionList, View, type SectionListRenderItem } from 'react-native';
import { Text } from '../../components/Text';

import { CardList, CardListRow, RowChip, useCardListStyles } from '../../components/CardList';
import { NumberField } from '../../components/NumberField';
import { ScanSearchField } from '../../components/ScanSearchField';
import {
  Button,
  Card,
  Chip,
  ChoiceChips,
  Empty,
  GroupCard,
  InfoRow,
  Screen,
  SectionTitle,
  Sheet,
  type Tone,
} from '../../components/ui';
import { UnitQtyField } from '../../components/UnitQtyField';
import { listAllPacks } from '../../db/stock';
import {
  cancelStocktake,
  clearCount,
  findStocktakeItemByCode,
  finishStocktake,
  getStocktake,
  getStocktakeItem,
  listStocktakeItems,
  recordCount,
  type Stocktake,
  type StocktakeItem,
} from '../../db/stocktake';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { useScene, useTerms } from '../../hooks/useScene';
import { notifyDataChanged } from '../../lib/dataEvents';
import { formatDateTime, todayStr } from '../../lib/dates';
import { shareCsv } from '../../lib/exportCsv';
import { rescheduleReminders } from '../../lib/notifications';
import { formatBreakdown, toBaseQty, type PackUnit } from '../../lib/packs';
import { takeScanResult } from '../../lib/scanHandoff';
import { formatQty, parseQty } from '../../lib/stock';
import {
  absenceLabel,
  buildStocktakeCsv,
  countDifference,
  countState,
  describeDifference,
  describeKinds,
  matchesFilter,
  matchesKeyword,
  previewFinish,
  STOCKTAKE_KIND_LABEL,
  STOCKTAKE_KINDS,
  STOCKTAKE_STATUS_LABEL,
  summarizeCounts,
  type CountState,
  type ItemFilter,
  type StocktakeKind,
} from '../../lib/stocktake';
import { makeStyles, useColors } from '../../hooks/useTheme';
import { font, radius } from '../../theme';

const STATE_TONE: Record<CountState, Tone> = {
  uncounted: 'neutral',
  match: 'ok',
  surplus: 'info',
  deficit: 'danger',
};

const FILTERS: { value: ItemFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'uncounted', label: '未盘' },
  { value: 'different', label: '有差异' },
];

type CountTarget = { itemId: number; unit: string | null };

/** 列表里的一组（按分类）：SectionList 只画屏幕上看得见的几行，几千项也不卡 */
type ItemSection = { kind: StocktakeKind; title: string; data: StocktakeItem[] };

export default function StocktakeScreen() {
  const pageStyles = usePageStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const terms = useTerms();
  const params = useLocalSearchParams<{ id: string }>();
  const stocktakeId = Number(params.id);
  const scanTarget = `stocktake-${stocktakeId}`;
  const [filter, setFilter] = useState<ItemFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [countTarget, setCountTarget] = useState<CountTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 完成或放弃正在进行：确认框连点两次时第二次不再执行 */
  const actionRunning = useRef(false);

  const loader = useCallback(async () => {
    const [stocktake, items, packs] = await Promise.all([
      getStocktake(db, stocktakeId),
      listStocktakeItems(db, stocktakeId),
      listAllPacks(db),
    ]);
    const packsByProduct = new Map<number, PackUnit[]>();
    for (const { productId, ...pack } of packs) {
      packsByProduct.set(productId, [...(packsByProduct.get(productId) ?? []), pack]);
    }
    return { stocktake, items, packsByProduct };
  }, [db, stocktakeId]);
  const [data, reload, loaded, updateData] = useFocusData(loader, {
    stocktake: null as Stocktake | null,
    items: [] as StocktakeItem[],
    packsByProduct: new Map<number, PackUnit[]>(),
  });
  const { stocktake, items, packsByProduct } = data;

  /** 记数、改回未盘以后只重读这一项，换掉列表里的那一项（别的项还是原来的对象，那些行不用重画） */
  const refreshItem = useCallback(
    async (itemId: number) => {
      const fresh = await getStocktakeItem(db, itemId);
      updateData((previous) => ({
        ...previous,
        items: fresh
          ? previous.items.map((item) => (item.id === itemId ? fresh : item))
          : previous.items.filter((item) => item.id !== itemId),
      }));
    },
    [db, updateData],
  );

  const summary = useMemo(() => summarizeCounts(items), [items]);
  // 搜索、筛选都在内存里做，不重读
  const sections = useMemo<ItemSection[]>(() => {
    const visible = items.filter((item) => matchesFilter(item, filter) && matchesKeyword(item, keyword));
    return STOCKTAKE_KINDS.map((kind) => {
      const group = visible.filter((item) => item.kind === kind);
      return { kind, title: `${STOCKTAKE_KIND_LABEL[kind]}（${group.length}）`, data: group };
    }).filter((section) => section.data.length > 0);
  }, [items, filter, keyword]);

  const openItem = useCallback((item: StocktakeItem) => {
    setMessage(null);
    if (item.absence) {
      Alert.alert(item.name, `${absenceLabel(item.absence)}，不用盘。`);
      return;
    }
    setCountTarget({ itemId: item.id, unit: null });
  }, []);

  const renderItem = useCallback<SectionListRenderItem<StocktakeItem, ItemSection>>(
    ({ item, index, section }) => (
      <ItemRow item={item} first={index === 0} last={index === section.data.length - 1} onOpen={openItem} />
    ),
    [openItem],
  );

  // 从扫码页回来：找到这一项就打开清点面板
  useFocusEffect(
    useCallback(() => {
      const code = takeScanResult(scanTarget);
      if (!code) return;
      findStocktakeItemByCode(db, stocktakeId, code)
        .then((found) => {
          if (found) setCountTarget({ itemId: found.itemId, unit: found.packUnit });
          else Alert.alert('不在这次盘点里', `条码 ${code} 对不上这次盘点的任何一项。`);
        })
        .catch(() => undefined);
    }, [db, stocktakeId, scanTarget]),
  );

  if (!loaded) return <Stack.Screen options={{ title: '盘点' }} />;
  if (!stocktake) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '盘点' }} />
        <Empty icon="help-circle-outline" title="找不到这次盘点" text={`可能所在的${terms.place}已经删除了。`} />
      </Screen>
    );
  }

  const officeLabel = office.multiple ? office.officeName(stocktake.officeId) : null;
  const scopeText = [officeLabel, describeKinds(stocktake.kinds)].filter(Boolean).join(' · ');

  if (stocktake.status !== 'open') {
    return <ResultView stocktake={stocktake} items={items} scopeText={scopeText} officeLabel={officeLabel} />;
  }

  const counting = countTarget ? (items.find((item) => item.id === countTarget.itemId) ?? null) : null;

  async function saveCount(itemId: number, countedQty: number) {
    await recordCount(db, itemId, countedQty);
    setCountTarget(null);
    await refreshItem(itemId);
  }

  /** 完成、放弃都走这里：同一时间只跑一个，跑的时候两个按钮都不能点 */
  async function runAction(action: () => Promise<void>, failTitle: string) {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      Alert.alert(failTitle, caught instanceof Error ? caught.message : '请重试');
      await reload().catch(() => undefined);
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  function confirmFinish() {
    if (busy) return;
    if (summary.counted === 0) {
      Alert.alert('还没有盘任何一项', '点一行填上数到的数量，或者扫码找到它。');
      return;
    }
    const preview = previewFinish(items);
    const lines = [
      `盘盈 ${preview.surplus} 项、盘亏 ${preview.deficit} 项、相符 ${preview.match} 项。`,
      preview.uncounted > 0 ? `还有 ${preview.uncounted} 项没盘，这些不调整。` : null,
      preview.absent > 0 ? `已删除或移走 ${preview.absent} 项，这些不调整。` : null,
      preview.deviceDifferences > 0 ? `${preview.deviceDifferences} 种设备有差异，只记录，不自动改数量。` : null,
      '完成后物品按实盘数调整库存，不能撤销。',
    ].filter(Boolean);
    Alert.alert('完成盘点？', lines.join('\n'), [
      { text: '再看看', style: 'cancel' },
      {
        text: '完成',
        onPress: () =>
          runAction(async () => {
            await finishStocktake(db, stocktakeId);
            rescheduleReminders(db).catch(() => undefined);
            notifyDataChanged();
            await reload();
          }, '没能完成'),
      },
    ]);
  }

  function confirmCancel() {
    if (busy) return;
    Alert.alert('放弃这次盘点？', '已经填的数量不会用来改库存，盘点单会留在历史里。', [
      { text: '不放弃', style: 'cancel' },
      {
        text: '放弃',
        style: 'destructive',
        onPress: () =>
          runAction(async () => {
            await cancelStocktake(db, stocktakeId);
            router.back();
          }, '没能放弃'),
      },
    ]);
  }

  const header = (
    <View style={pageStyles.header}>
      <Card style={pageStyles.summary}>
        <Text style={pageStyles.meta}>
          {scopeText} · {formatDateTime(stocktake.startedAt)} 开始
        </Text>
        <Text style={pageStyles.progress}>
          已盘 {summary.counted} / 共 {summary.total}
        </Text>
        <View style={pageStyles.bar} accessibilityLabel={`已盘 ${summary.counted} 项，共 ${summary.total} 项`}>
          <View
            style={[
              pageStyles.barFill,
              { width: `${summary.total ? Math.round((summary.counted / summary.total) * 100) : 0}%` },
            ]}
          />
        </View>
        <View style={pageStyles.chips}>
          {summary.surplus > 0 ? <Chip text={`盘盈 ${summary.surplus}`} tone="info" /> : null}
          {summary.deficit > 0 ? <Chip text={`盘亏 ${summary.deficit}`} tone="danger" /> : null}
          {summary.match > 0 ? <Chip text={`相符 ${summary.match}`} tone="ok" /> : null}
        </View>
        {message ? <Text style={pageStyles.message}>{message}</Text> : null}
      </Card>

      <ChoiceChips options={FILTERS} value={filter} onChange={setFilter} />
      {/* 照鸿蒙版：扫码是搜索框右边的条码图标 */}
      <ScanSearchField
        value={keyword}
        onChangeText={setKeyword}
        placeholder="搜名称、条码、序列号"
        returnKeyType="search"
        scanLabel="扫码找物品"
        onScan={() => {
          setMessage(null);
          router.push({ pathname: '/scan', params: { target: scanTarget } });
        }}
      />

      {sections.length === 0 ? (
        <Card>
          <Text style={pageStyles.sub}>
            {filter === 'uncounted' && !keyword ? '都盘完了，可以点下面的「完成盘点」。' : '没有符合条件的。'}
          </Text>
        </Card>
      ) : null}
    </View>
  );

  const footer = (
    <View style={pageStyles.actions}>
      <Button
        title="完成盘点"
        icon="checkmark-done-outline"
        loading={busy}
        disabled={busy}
        onPress={confirmFinish}
      />
      <Button title="放弃这次盘点" variant="ghost" disabled={busy} onPress={confirmCancel} />
    </View>
  );

  return (
    <View style={pageStyles.screen}>
      <Stack.Screen options={{ title: '盘点' }} />
      {/* 几千项时只画看得见的几行：按分类分组的 SectionList，每行是 memo 的 ItemRow */}
      <SectionList
        style={pageStyles.screen}
        contentContainerStyle={pageStyles.listContent}
        sections={sections}
        keyExtractor={itemKey}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        windowSize={11}
      />

      {counting ? (
        <CountSheet
          key={`${counting.id}-${countTarget?.unit ?? ''}`}
          item={counting}
          packs={counting.itemType === 'product' ? (packsByProduct.get(counting.itemId) ?? []) : []}
          initialUnit={countTarget?.unit ?? null}
          onClose={() => setCountTarget(null)}
          onSave={async (countedQty) => {
            await saveCount(counting.id, countedQty);
            setMessage(`${counting.name}：已记 ${formatQty(countedQty)} ${counting.unit}`);
          }}
          onClear={async () => {
            await clearCount(db, counting.id);
            setCountTarget(null);
            await refreshItem(counting.id);
          }}
        />
      ) : null}
    </View>
  );
}

function itemKey(item: StocktakeItem): string {
  return String(item.id);
}

function renderSectionHeader({ section }: { section: ItemSection }) {
  return <SectionHeader title={section.title} />;
}

/** 分组小标题：和原来一样离上面 16、离下面的卡片 8（SectionTitle 自己带上 8、下 -8 的外边距） */
function SectionHeader({ title }: { title: string }) {
  const pageStyles = usePageStyles();
  return (
    <View style={pageStyles.sectionHeader}>
      <SectionTitle title={title} />
    </View>
  );
}

/**
 * 一行：一组里的第一行、最后一行分别带上、下圆角，一组连起来就是原来那张列表卡片（CardList）。
 * memo：记一项只换掉那一项的对象，别的行参数没变不重画；onOpen 是页面里不变的函数，点的时候把这一项传回去。
 */
const ItemRow = memo(function ItemRow({
  item,
  first,
  last,
  onOpen,
}: {
  item: StocktakeItem;
  first: boolean;
  last: boolean;
  onOpen: (item: StocktakeItem) => void;
}) {
  const pageStyles = usePageStyles();
  const cardListStyles = useCardListStyles();
  const state = countState(item);
  const detail =
    item.countedQty === null
      ? `账面 ${formatQty(item.bookQty)} ${item.unit}`
      : `清点时账面 ${formatQty(item.expectedQty ?? 0)}，实盘 ${formatQty(item.countedQty)} ${item.unit}`;
  return (
    <View style={[pageStyles.rowCard, first && pageStyles.rowCardFirst, last && pageStyles.rowCardLast]}>
      <CardListRow
        first={first}
        onPress={() => onOpen(item)}
        accessibilityLabel={`${item.name}，${detail}，${describeDifference(item, item.unit)}`}
      >
        <View style={cardListStyles.main}>
          <Text style={pageStyles.rowTitle} numberOfLines={2}>
            {item.name}
          </Text>
          <Text style={item.absence ? pageStyles.note : pageStyles.sub}>
            {item.absence ? absenceLabel(item.absence) : detail}
          </Text>
        </View>
        <RowChip text={describeDifference(item, item.unit)} tone={STATE_TONE[state]} />
      </CardListRow>
    </View>
  );
});

function CountSheet({
  item,
  packs,
  initialUnit,
  onClose,
  onSave,
  onClear,
}: {
  item: StocktakeItem;
  packs: PackUnit[];
  /** 扫的是包装条码时，默认按这个包装单位数 */
  initialUnit: string | null;
  onClose: () => void;
  onSave: (countedQty: number) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const sheetStyles = useSheetStyles();
  const { scene, terms } = useScene();
  // 家庭场景设备盘一共有几件，办公场景盘在库
  const home = scene === 'home';
  const isDevice = item.itemType === 'device';
  const [qtyText, setQtyText] = useState(item.countedQty === null || initialUnit ? '' : formatQty(item.countedQty));
  const [entryUnit, setEntryUnit] = useState(initialUnit ?? item.unit);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const qty = parseQty(qtyText);
  const baseQty = qty === null ? null : isDevice ? qty : toBaseQty(qty, entryUnit, item.unit, packs);
  const qtyError =
    baseQty === null
      ? '请填数到的数量（没有就填 0）'
      : isDevice && !Number.isInteger(baseQty)
        ? '设备数量要是整数'
        : null;
  const breakdown = formatBreakdown(item.bookQty, item.unit, packs);
  const bookText = `${isDevice ? (home ? '一共' : '在库') : '账面'} ${formatQty(item.bookQty)} ${item.unit}${breakdown ? `（${breakdown}）` : ''}`;

  async function save(value: number) {
    setBusy(true);
    setSaveError(null);
    try {
      await onSave(value);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible title={item.name} onClose={onClose}>
      <Text style={sheetStyles.book}>{bookText}</Text>
      {isDevice ? (
        <NumberField
          label={home ? '实际有几件' : '实际在库（件）'}
          value={qtyText}
          onChangeText={setQtyText}
          suffix="件"
          max={99999}
          placeholder="数到几件"
          error={showErrors ? qtyError : null}
          hint={home ? '谁在用的也算上。' : `借出去的不算，只数${terms.place}里的。`}
          autoFocus
        />
      ) : (
        <UnitQtyField
          label="实盘数量"
          baseUnit={item.unit}
          packs={packs}
          qtyText={qtyText}
          onQtyText={setQtyText}
          unit={entryUnit}
          onUnit={setEntryUnit}
          error={showErrors ? qtyError : null}
          autoFocus
        />
      )}
      {saveError ? <Text style={sheetStyles.error}>{saveError}</Text> : null}
      <View style={sheetStyles.actions}>
        <Button
          title="和账面一样"
          variant="secondary"
          disabled={busy}
          onPress={() => save(item.bookQty)}
          style={sheetStyles.flex}
        />
        <Button
          title="保存"
          loading={busy}
          style={sheetStyles.flex}
          onPress={() => {
            setShowErrors(true);
            if (qtyError || baseQty === null) return;
            save(baseQty).catch(() => undefined);
          }}
        />
      </View>
      {item.countedQty !== null ? (
        <Button title="改回未盘" variant="ghost" compact disabled={busy} onPress={() => onClear().catch(() => undefined)} />
      ) : null}
    </Sheet>
  );
}

/** 已完成或已放弃的盘点：只读结果 */
function ResultView({
  stocktake,
  items,
  scopeText,
  officeLabel,
}: {
  stocktake: Stocktake;
  items: StocktakeItem[];
  scopeText: string;
  officeLabel: string | null;
}) {
  const colors = useColors();
  const pageStyles = usePageStyles();
  const cardListStyles = useCardListStyles();
  const home = useScene().scene === 'home';
  const [exporting, setExporting] = useState(false);
  const summary = summarizeCounts(items);
  const differences = items.filter((item) => {
    const state = countState(item);
    return state === 'surplus' || state === 'deficit';
  });
  // 已删除、移走的设备不算进「要手动处理」
  const deviceDifferences = differences.filter((item) => item.itemType === 'device' && item.present).length;
  const done = stocktake.status === 'done';

  async function exportCsv() {
    setExporting(true);
    try {
      const name = ['盘点', officeLabel, todayStr(new Date(stocktake.startedAt))].filter(Boolean).join('-');
      await shareCsv(name, buildStocktakeCsv(items, stocktake.status), '保存或发送盘点表');
    } catch (caught) {
      Alert.alert('导出失败', caught instanceof Error ? caught.message : '请重试');
    } finally {
      setExporting(false);
    }
  }

  return (
    <View style={pageStyles.screen}>
      <Stack.Screen options={{ title: done ? '盘点结果' : '已放弃的盘点' }} />
      <Screen>
        {/* 照鸿蒙版 StocktakeResultView：上面是状态、范围、时间的分组卡片，下面一张卡片放四个大数字和说明 */}
        <GroupCard>
          <Chip text={STOCKTAKE_STATUS_LABEL[stocktake.status]} tone={done ? 'ok' : 'neutral'} />
          <InfoRow label="范围" value={scopeText} />
          <InfoRow label="开始" value={formatDateTime(stocktake.startedAt)} />
          {stocktake.finishedAt ? (
            <InfoRow label={done ? '完成' : '放弃'} value={formatDateTime(stocktake.finishedAt)} />
          ) : null}
        </GroupCard>
        <Card style={pageStyles.summary}>
          <View style={pageStyles.tiles}>
            <Tile label="盘盈" value={summary.surplus} tone={colors.info} />
            <Tile label="盘亏" value={summary.deficit} tone={colors.danger} />
            <Tile label="相符" value={summary.match} tone={colors.ok} />
            <Tile label="未盘" value={summary.uncounted} tone={colors.ink} />
          </View>
          {done ? (
            <Text style={pageStyles.sub}>有差异的物品已按实盘数调整库存，每项在物品的出入库记录里记了一条「调整」。</Text>
          ) : (
            <Text style={pageStyles.sub}>这次盘点已放弃，库存没有改动。</Text>
          )}
          {done && deviceDifferences > 0 ? (
            <Text style={pageStyles.warn}>
              {deviceDifferences} 种设备有差异，设备数量没有自动改，请到设备里手动处理（{home ? '改数量或删除' : '改数量、登记领用或删除'}）。
            </Text>
          ) : null}
        </Card>

        <SectionTitle title={`差异（${differences.length}）`} />
        {differences.length === 0 ? (
          <Card>
            <Text style={pageStyles.sub}>{summary.counted > 0 ? '盘到的都和账面一致。' : '一项都没有盘。'}</Text>
          </Card>
        ) : (
          <CardList>
            {differences.map((item, index) => {
              const difference = countDifference(item) ?? 0;
              const adjustedNote =
                item.itemType === 'device'
                  ? item.present
                    ? '设备，需要手动处理'
                    : '设备已删除或移走'
                  : done && item.adjustedQty !== null && item.adjustedQty !== difference
                    ? `实际调整 ${formatQty(item.adjustedQty)}（清点后库存变了，只能扣到 0）`
                    : done && item.adjustedQty === null
                      ? '物品已删除或移走，没有调整'
                      : null;
              return (
                <CardListRow key={item.id} first={index === 0} style={pageStyles.differenceRow}>
                  <View style={cardListStyles.main}>
                    <Text style={pageStyles.rowTitle} numberOfLines={2}>
                      {item.name}
                    </Text>
                    <Text style={pageStyles.sub}>
                      {STOCKTAKE_KIND_LABEL[item.kind]} · 账面 {formatQty(item.expectedQty ?? 0)} → 实盘{' '}
                      {formatQty(item.countedQty ?? 0)} {item.unit}
                    </Text>
                    {adjustedNote ? <Text style={pageStyles.note}>{adjustedNote}</Text> : null}
                  </View>
                  <Chip text={describeDifference(item, item.unit)} tone={STATE_TONE[countState(item)]} />
                </CardListRow>
              );
            })}
          </CardList>
        )}

        <Button
          title="导出 CSV（全部明细）"
          icon="share-outline"
          variant="secondary"
          loading={exporting}
          onPress={() => exportCsv()}
        />
      </Screen>
    </View>
  );
}

/** 一个大数字 + 下面的说明（照鸿蒙版 IkBigNumber：不加底色，数字用状态色） */
function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  const pageStyles = usePageStyles();
  return (
    <View style={pageStyles.tile}>
      <Text style={[pageStyles.tileValue, { color: tone }]}>{value}</Text>
      <Text style={pageStyles.tileLabel}>{label}</Text>
    </View>
  );
}

// 照鸿蒙版 StocktakePage / StocktakeResultView：清点进度卡片、按分类的列表卡片（行间分隔线左边留 16）、结果页的大数字
const usePageStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  summary: { gap: 8 },
  meta: { fontSize: font.small, color: colors.muted },
  progress: { fontSize: font.title, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceSunken, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  message: { fontSize: font.small, color: colors.ok, fontWeight: '500' },
  // 列表：和原来的 Screen 一样四周留 16、底下留 40；页头里的卡片、筛选、搜索框之间隔 16
  listContent: { padding: 16, paddingBottom: 40 },
  header: { gap: 16 },
  // 分组小标题自己带「上 8、下 -8」的外边距（贴近下面的卡片），上下各留 16：离上面 24、离卡片 8，和原来一样
  sectionHeader: { paddingTop: 16, paddingBottom: 16 },
  // 一组的各行连成一张列表卡片（CardList 的样子）：第一行上圆角、最后一行下圆角
  rowCard: { backgroundColor: colors.surface, overflow: 'hidden' },
  rowCardFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowCardLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowTitle: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  // 差异行可能多一行说明：顶上对齐，上下多留一点
  differenceRow: { alignItems: 'flex-start', paddingVertical: 12 },
  sub: { fontSize: font.small, color: colors.muted, lineHeight: 19 },
  note: { fontSize: font.small, color: colors.warn },
  warn: { fontSize: font.small, color: colors.warn, lineHeight: 19 },
  actions: { gap: 8, paddingTop: 16 },
  tiles: { flexDirection: 'row' },
  tile: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2, paddingVertical: 8 },
  tileValue: { fontSize: font.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tileLabel: { fontSize: font.small, color: colors.muted },
}));

// 清点面板：说明是灰色正文
const useSheetStyles = makeStyles((colors) => ({
  book: { fontSize: font.body, color: colors.muted },
  actions: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  error: { fontSize: font.small, color: colors.danger },
}));
