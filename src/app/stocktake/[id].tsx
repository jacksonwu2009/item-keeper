import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { NumberField } from '../../components/NumberField';
import {
  Button,
  Card,
  Chip,
  ChoiceChips,
  Empty,
  Field,
  IconButton,
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
  listStocktakeItems,
  recordCount,
  type Stocktake,
  type StocktakeItem,
} from '../../db/stocktake';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { notifyDataChanged } from '../../lib/dataEvents';
import { formatDateTime, todayStr } from '../../lib/dates';
import { shareCsv } from '../../lib/exportCsv';
import { rescheduleReminders } from '../../lib/notifications';
import { formatBreakdown, toBaseQty, type PackUnit } from '../../lib/packs';
import { takeScanResult } from '../../lib/scanHandoff';
import { formatQty, parseQty } from '../../lib/stock';
import {
  buildStocktakeCsv,
  countDifference,
  countState,
  describeDifference,
  describeKinds,
  matchesFilter,
  matchesKeyword,
  STOCKTAKE_KIND_LABEL,
  STOCKTAKE_KINDS,
  STOCKTAKE_STATUS_LABEL,
  summarizeCounts,
  type CountState,
  type ItemFilter,
} from '../../lib/stocktake';
import { colors, font, radius } from '../../theme';

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

export default function StocktakeScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const params = useLocalSearchParams<{ id: string }>();
  const stocktakeId = Number(params.id);
  const scanTarget = `stocktake-${stocktakeId}`;
  const [filter, setFilter] = useState<ItemFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [countTarget, setCountTarget] = useState<CountTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const [data, reload, loaded] = useFocusData(loader, {
    stocktake: null as Stocktake | null,
    items: [] as StocktakeItem[],
    packsByProduct: new Map<number, PackUnit[]>(),
  });
  const { stocktake, items, packsByProduct } = data;

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
        <Empty icon="help-circle-outline" title="找不到这次盘点" text="可能所在的办公点已经删除了。" />
      </Screen>
    );
  }

  const summary = summarizeCounts(items);
  const officeLabel = office.multiple ? office.officeName(stocktake.officeId) : null;
  const scopeText = [officeLabel, describeKinds(stocktake.kinds)].filter(Boolean).join(' · ');

  if (stocktake.status !== 'open') {
    return <ResultView stocktake={stocktake} items={items} scopeText={scopeText} officeLabel={officeLabel} />;
  }

  const visible = items.filter((item) => matchesFilter(item, filter) && matchesKeyword(item, keyword));
  const counting = countTarget ? (items.find((item) => item.id === countTarget.itemId) ?? null) : null;

  async function saveCount(itemId: number, countedQty: number) {
    await recordCount(db, itemId, countedQty);
    setCountTarget(null);
    await reload();
  }

  function confirmFinish() {
    if (summary.counted === 0) {
      Alert.alert('还没有盘任何一项', '点一行填上数到的数量，或者扫码找到它。');
      return;
    }
    const deviceDifferences = items.filter(
      (item) => item.itemType === 'device' && (countState(item) === 'surplus' || countState(item) === 'deficit'),
    ).length;
    const lines = [
      `盘盈 ${summary.surplus} 项、盘亏 ${summary.deficit} 项、相符 ${summary.match} 项。`,
      summary.uncounted > 0 ? `还有 ${summary.uncounted} 项没盘，这些不调整。` : null,
      deviceDifferences > 0 ? `${deviceDifferences} 种设备有差异，只记录，不自动改数量。` : null,
      '完成后物品按实盘数调整库存，不能撤销。',
    ].filter(Boolean);
    Alert.alert('完成盘点？', lines.join('\n'), [
      { text: '再看看', style: 'cancel' },
      {
        text: '完成',
        onPress: async () => {
          setBusy(true);
          try {
            await finishStocktake(db, stocktakeId);
            rescheduleReminders(db).catch(() => undefined);
            notifyDataChanged();
            await reload();
          } catch (caught) {
            Alert.alert('没能完成', caught instanceof Error ? caught.message : '请重试');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  function confirmCancel() {
    Alert.alert('放弃这次盘点？', '已经填的数量不会用来改库存，盘点单会留在历史里。', [
      { text: '不放弃', style: 'cancel' },
      {
        text: '放弃',
        style: 'destructive',
        onPress: async () => {
          await cancelStocktake(db, stocktakeId);
          router.back();
        },
      },
    ]);
  }

  return (
    <View style={pageStyles.screen}>
      <Stack.Screen options={{ title: '盘点' }} />
      <Screen>
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
        <Field
          value={keyword}
          onChangeText={setKeyword}
          placeholder="搜名称、条码、序列号"
          returnKeyType="search"
          right={
            <IconButton
              icon="barcode-outline"
              label="扫码找物品"
              onPress={() => {
                setMessage(null);
                router.push({ pathname: '/scan', params: { target: scanTarget } });
              }}
            />
          }
        />

        {visible.length === 0 ? (
          <Card>
            <Text style={pageStyles.sub}>
              {filter === 'uncounted' && !keyword ? '都盘完了，可以点下面的「完成盘点」。' : '没有符合条件的。'}
            </Text>
          </Card>
        ) : (
          STOCKTAKE_KINDS.filter((kind) => visible.some((item) => item.kind === kind)).map((kind) => {
            const group = visible.filter((item) => item.kind === kind);
            return (
              <View key={kind} style={pageStyles.group}>
                <SectionTitle title={`${STOCKTAKE_KIND_LABEL[kind]}（${group.length}）`} />
                <Card style={pageStyles.listCard}>
                  {group.map((item, index) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      first={index === 0}
                      onPress={() => {
                        setMessage(null);
                        setCountTarget({ itemId: item.id, unit: null });
                      }}
                    />
                  ))}
                </Card>
              </View>
            );
          })
        )}

        <View style={pageStyles.actions}>
          <Button title="完成盘点" icon="checkmark-done-outline" loading={busy} onPress={confirmFinish} />
          <Button title="放弃这次盘点" variant="ghost" onPress={confirmCancel} />
        </View>
      </Screen>

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
            await reload();
          }}
        />
      ) : null}
    </View>
  );
}

function ItemRow({ item, first, onPress }: { item: StocktakeItem; first: boolean; onPress: () => void }) {
  const state = countState(item);
  const detail =
    item.countedQty === null
      ? `账面 ${formatQty(item.bookQty)} ${item.unit}`
      : `清点时账面 ${formatQty(item.expectedQty ?? 0)}，实盘 ${formatQty(item.countedQty)} ${item.unit}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name}，${detail}，${describeDifference(item, item.unit)}`}
      onPress={onPress}
      style={({ pressed }) => [pageStyles.row, !first && pageStyles.rowDivider, pressed && pageStyles.rowPressed]}
    >
      <View style={pageStyles.rowMain}>
        <Text style={pageStyles.rowTitle} numberOfLines={2}>
          {item.name}
        </Text>
        <Text style={pageStyles.sub}>{item.present ? detail : '已经删除，完成时跳过'}</Text>
      </View>
      <Chip text={describeDifference(item, item.unit)} tone={STATE_TONE[state]} />
    </Pressable>
  );
}

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
  const bookText = `${isDevice ? '在库' : '账面'} ${formatQty(item.bookQty)} ${item.unit}${breakdown ? `（${breakdown}）` : ''}`;

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
          label="实际在库（件）"
          value={qtyText}
          onChangeText={setQtyText}
          suffix="件"
          max={99999}
          placeholder="数到几件"
          error={showErrors ? qtyError : null}
          hint="借出去的不算，只数办公点里的。"
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
  const [exporting, setExporting] = useState(false);
  const summary = summarizeCounts(items);
  const differences = items.filter((item) => {
    const state = countState(item);
    return state === 'surplus' || state === 'deficit';
  });
  const deviceDifferences = differences.filter((item) => item.itemType === 'device').length;
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
        <Card style={pageStyles.summary}>
          <View style={pageStyles.chips}>
            <Chip text={STOCKTAKE_STATUS_LABEL[stocktake.status]} tone={done ? 'ok' : 'neutral'} />
          </View>
          <InfoRow label="范围" value={scopeText} />
          <InfoRow label="开始" value={formatDateTime(stocktake.startedAt)} />
          {stocktake.finishedAt ? (
            <InfoRow label={done ? '完成' : '放弃'} value={formatDateTime(stocktake.finishedAt)} />
          ) : null}
          <View style={pageStyles.tiles}>
            <Tile label="盘盈" value={summary.surplus} tone={colors.info} />
            <Tile label="盘亏" value={summary.deficit} tone={colors.danger} />
            <Tile label="相符" value={summary.match} tone={colors.ok} />
            <Tile label="未盘" value={summary.uncounted} tone={colors.muted} />
          </View>
          {done ? (
            <Text style={pageStyles.sub}>有差异的物品已按实盘数调整库存，每项在物品的出入库记录里记了一条「调整」。</Text>
          ) : (
            <Text style={pageStyles.sub}>这次盘点已放弃，库存没有改动。</Text>
          )}
          {done && deviceDifferences > 0 ? (
            <Text style={pageStyles.warn}>
              {deviceDifferences} 种设备有差异，设备数量没有自动改，请到设备里手动处理（改数量、登记领用或删除）。
            </Text>
          ) : null}
        </Card>

        <SectionTitle title={`差异（${differences.length}）`} />
        {differences.length === 0 ? (
          <Card>
            <Text style={pageStyles.sub}>{summary.counted > 0 ? '盘到的都和账面一致。' : '一项都没有盘。'}</Text>
          </Card>
        ) : (
          <Card style={pageStyles.listCard}>
            {differences.map((item, index) => {
              const difference = countDifference(item) ?? 0;
              const adjustedNote =
                item.itemType === 'device'
                  ? '设备，需要手动处理'
                  : done && item.adjustedQty !== null && item.adjustedQty !== difference
                    ? `实际调整 ${formatQty(item.adjustedQty)}（清点后库存变了，只能扣到 0）`
                    : done && item.adjustedQty === null
                      ? '物品已删除，没有调整'
                      : null;
              return (
                <View key={item.id} style={[pageStyles.row, index > 0 && pageStyles.rowDivider]}>
                  <View style={pageStyles.rowMain}>
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
                </View>
              );
            })}
          </Card>
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

function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <View style={pageStyles.tile}>
      <Text style={[pageStyles.tileValue, { color: tone }]}>{value}</Text>
      <Text style={pageStyles.tileLabel}>{label}</Text>
    </View>
  );
}

const pageStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  summary: { gap: 10 },
  meta: { fontSize: font.small, color: colors.muted },
  progress: { fontSize: font.title, fontWeight: '800', color: colors.ink, fontVariant: ['tabular-nums'] },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceSunken, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: colors.accent },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  message: { fontSize: font.small, color: colors.ok, fontWeight: '600' },
  group: { gap: 8 },
  listCard: { paddingVertical: 4, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowPressed: { opacity: 0.6 },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: font.body, fontWeight: '600', color: colors.ink },
  sub: { fontSize: font.small, color: colors.muted, lineHeight: 19 },
  note: { fontSize: font.small, color: colors.warn },
  warn: { fontSize: font.small, color: colors.warn, lineHeight: 19 },
  actions: { gap: 8 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tileValue: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tileLabel: { fontSize: font.tiny + 1, color: colors.muted, marginTop: 2 },
});

const sheetStyles = StyleSheet.create({
  book: { fontSize: font.body, color: colors.muted },
  actions: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  error: { fontSize: font.small, color: colors.danger },
});
