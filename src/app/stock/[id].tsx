import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { isLabelOcrAvailable } from '../../../modules/label-ocr';

import { BatchPicker, pickedAllocation, type PickerBatch } from '../../components/BatchPicker';
import { DateField } from '../../components/DateField';
import { ExpiryInput, type ExpiryValue } from '../../components/ExpiryInput';
import {
  Button,
  Card,
  Chip,
  ChoiceChips,
  Empty,
  Field,
  GroupCard,
  InfoRow,
  Label,
  Screen,
  SectionTitle,
  Sheet,
} from '../../components/ui';
import { MovementPriceSheet } from '../../components/MovementPriceEditor';
import { NumberField } from '../../components/NumberField';
import { PriceFields } from '../../components/PriceFields';
import { SwipeRow, UndoBar } from '../../components/SwipeRow';
import { UnitQtyField } from '../../components/UnitQtyField';
import { DEFAULT_SETTINGS, getSettings } from '../../db/settings';
import {
  deleteBatch,
  deleteProduct,
  getLastPurchasePrice,
  getLastStockIn,
  getProduct,
  listBatches,
  listMovements,
  listPacks,
  productShelfLife,
  stockIn,
  stockOut,
  updateBatch,
  updateMovementPrice,
  type EntryQty,
  type LastPurchasePrice,
  type StockBatch,
  type StockMovement,
  type StockProduct,
} from '../../db/stock';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { useTerms } from '../../hooks/useScene';
import { usePendingDelete } from '../../hooks/usePendingDelete';
import { formatDate, formatDateTime, formatShelfLife, formatShortDate, toDateStr, todayStr, type ShelfLife } from '../../lib/dates';
import { lastProductionDate, stockInExpiryDefaults } from '../../lib/stockInDefaults';
import { rescheduleReminders } from '../../lib/notifications';
import { describePacks, formatBreakdown, toBaseQty, type PackUnit } from '../../lib/packs';
import {
  convertPriceUnit,
  defaultPriceDraft,
  derivePrice,
  formatPrice,
  type EntryPrice,
  type PriceDraft,
} from '../../lib/price';
import { expiryStatus, isLowStock } from '../../lib/status';
import { formatQty, KIND_LABEL, NOTE_INPUT_MAX, outNote, parseQty, roundQty, type BatchAllocation } from '../../lib/stock';
import { makeStyles, useColors } from '../../hooks/useTheme';
import { font, radius } from '../../theme';

type SheetState =
  | { type: 'in' }
  | { type: 'out' }
  | { type: 'batch'; batch: StockBatch }
  | { type: 'price'; movement: StockMovement }
  | null;

export default function StockDetailScreen() {
  const colors = useColors();
  const detailStyles = useDetailStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const terms = useTerms();
  // in=1：一打开就是入库面板；known=1：新增页扫到本机已有的条码跳过来的，入库面板上说一句
  const params = useLocalSearchParams<{ id: string; scanned?: string; unit?: string; in?: string; known?: string }>();
  /** 扫的是整箱等包装上的条码时，入库默认按这个单位 */
  const scannedUnit = typeof params.unit === 'string' ? params.unit : null;
  const productId = Number(params.id);
  const [showScanBanner, setShowScanBanner] = useState(params.scanned === '1');
  const [sheet, setSheet] = useState<SheetState>(params.in === '1' ? { type: 'in' } : null);
  // 从新增页跳过来的那一句只在第一次弹出的入库面板上显示
  const [knownNotice, setKnownNotice] = useState(params.known === '1' && params.in === '1');
  const [message, setMessage] = useState<string | null>(null);

  const loader = useCallback(async () => {
    const [product, batches, movements, packs, settings, lastPrice, lastIn] = await Promise.all([
      getProduct(db, productId),
      listBatches(db, productId),
      listMovements(db, productId, 100),
      listPacks(db, productId),
      getSettings(db),
      getLastPurchasePrice(db, productId),
      getLastStockIn(db, productId),
    ]);
    return { product, batches, movements, packs, settings, lastPrice, lastIn };
  }, [db, productId]);
  const [data, reload, loaded] = useFocusData(loader, {
    product: null as StockProduct | null,
    batches: [] as StockBatch[],
    movements: [] as StockMovement[],
    packs: [] as PackUnit[],
    settings: DEFAULT_SETTINGS,
    lastPrice: null as LastPurchasePrice | null,
    lastIn: null as StockMovement | null,
  });
  const { product, movements, packs, settings, lastPrice, lastIn } = data;
  const [showAllMovements, setShowAllMovements] = useState(false);
  const batchDeletion = usePendingDelete<number>(
    (batchId) => deleteBatch(db, batchId),
    () => {
      rescheduleReminders(db).catch(() => undefined);
      return reload();
    },
  );
  // 等撤销的那一批先从界面上拿掉，库存数字也跟着变
  const batches = data.batches.filter((batch) => batch.id !== batchDeletion.pending?.key);

  /** 入库、出库、改批次都按数据库里的批次算：先把等撤销的删除真正执行掉，再打开面板。 */
  function openSheet(next: Exclude<SheetState, null>) {
    batchDeletion
      .flush()
      .catch(() => undefined)
      .finally(() => setSheet(next));
  }

  async function afterChange(note?: string) {
    setSheet(null);
    setKnownNotice(false);
    setShowScanBanner(false);
    setMessage(note ?? null);
    await reload();
    rescheduleReminders(db).catch(() => undefined);
  }

  if (!loaded) return <Stack.Screen options={{ title: '' }} />;
  if (!product) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <Empty icon="help-circle-outline" title="找不到这个物品" text="可能已经被删除了。" />
      </Screen>
    );
  }

  const today = todayStr();
  const leadDays = product.expiryLeadDays ?? settings.expiryLeadDays;
  const totalQty = roundQty(batches.reduce((sum, batch) => sum + batch.quantity, 0));
  const low = isLowStock(totalQty, product.lowStockThreshold);
  const nearest = expiryStatus(batches.find((batch) => batch.expiryDate)?.expiryDate ?? null, today, leadDays);
  const breakdown = formatBreakdown(totalQty, product.unit, packs);
  const scannedPack = scannedUnit ? (packs.find((pack) => pack.unit === scannedUnit) ?? null) : null;
  const shelfLife = productShelfLife(product);

  function confirmDelete() {
    if (!product) return;
    Alert.alert('删除这个物品？', `「${product.name}」和它的所有批次都会被删除，不能恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteProduct(db, product.id);
          rescheduleReminders(db).catch(() => undefined);
          router.back();
        },
      },
    ]);
  }

  return (
    <View style={detailStyles.screen}>
      <Screen>
        <Stack.Screen options={{ title: product.name }} />

        {showScanBanner ? (
          <View style={detailStyles.banner}>
            <Text style={detailStyles.bannerText}>
              已认出：{product.name}
              {scannedPack
                ? `（${scannedPack.unit}的条码，1 ${scannedPack.unit} = ${formatQty(scannedPack.size)} ${product.unit}）`
                : ''}
              。这次是买回来，还是用掉？
            </Text>
          </View>
        ) : null}

        <Card style={detailStyles.summary}>
          <View style={detailStyles.summaryTop}>
            <View style={detailStyles.flex}>
              <Text style={detailStyles.kind}>{KIND_LABEL[product.kind]}</Text>
              <Text style={detailStyles.title}>{product.name}</Text>
              {product.category || product.spec ? (
                <Text style={detailStyles.sub}>{[product.category, product.spec].filter(Boolean).join(' · ')}</Text>
              ) : null}
            </View>
            <View style={detailStyles.qtyBox}>
              <Text style={[detailStyles.qty, totalQty <= 0 && { color: colors.danger }]}>{formatQty(totalQty)}</Text>
              <Text style={detailStyles.unit}>{product.unit}</Text>
              {breakdown ? <Text style={detailStyles.breakdown}>{breakdown}</Text> : null}
            </View>
          </View>
          {nearest || low ? (
            <View style={detailStyles.chips}>
              {nearest ? (
                <Chip text={`最早一批${nearest.text}`} tone={nearest.level === 'fine' ? 'neutral' : nearest.tone} />
              ) : null}
              {low ? <Chip text={`库存不足（下限 ${formatQty(product.lowStockThreshold ?? 0)}）`} tone="warn" /> : null}
            </View>
          ) : null}
          <View style={detailStyles.actions}>
            <Button title="入库" onPress={() => openSheet({ type: 'in' })} style={detailStyles.flex} />
            <Button
              title="出库 / 用掉"
              variant="secondary"
              onPress={() => openSheet({ type: 'out' })}
              disabled={totalQty <= 0}
              style={detailStyles.flex}
            />
          </View>
          {message ? <Text style={detailStyles.message}>{message}</Text> : null}
        </Card>

        <SectionTitle title={`批次（${batches.length}）`} />
        {batches.length === 0 ? (
          <Card>
            <Text style={detailStyles.sub}>没有库存了。买回来后点「入库」记一下。</Text>
          </Card>
        ) : (
          <View style={detailStyles.batchList}>
            <Text style={detailStyles.batchHint}>点一批调整数量和过期日期，向左滑删除</Text>
            {batches.map((batch) => {
              const status = expiryStatus(batch.expiryDate, today, leadDays);
              return (
                <SwipeRow
                  key={batch.id}
                  accessibilityLabel={`${batch.expiryDate ? `${formatDate(batch.expiryDate)} 到期` : '没记过期日期'}，${formatQty(batch.quantity)} ${product.unit}`}
                  onPress={() => openSheet({ type: 'batch', batch })}
                  onLongPress={() => openSheet({ type: 'batch', batch })}
                  onDelete={() =>
                    batchDeletion.remove(
                      batch.id,
                      `${batch.expiryDate ? `${formatDate(batch.expiryDate)} 到期的` : ''}一批（${formatQty(batch.quantity)} ${product.unit}）`,
                    )
                  }
                  style={detailStyles.batchItem}
                  pressedStyle={{ backgroundColor: colors.surfaceSunken }}
                >
                  {/* 和列表一样：左边文字和标签，右边只放数量，左滑出来的「删除」只盖住数量 */}
                  <View style={detailStyles.batchMain}>
                    <Text style={detailStyles.batchDate}>
                      {batch.expiryDate ? `${formatDate(batch.expiryDate)} 到期` : '没记过期日期'}
                    </Text>
                    <View style={detailStyles.batchMetaRow}>
                      {status ? <Chip text={status.text} tone={status.level === 'fine' ? 'neutral' : status.tone} /> : null}
                      <Text style={detailStyles.batchMeta}>{formatDate(batch.addedOn)} 入库</Text>
                    </View>
                  </View>
                  <Text style={detailStyles.batchQty}>
                    {formatQty(batch.quantity)} {product.unit}
                  </Text>
                </SwipeRow>
              );
            })}
          </View>
        )}

        <SectionTitle title="出入库记录" />
        {movements.length === 0 ? (
          <Card>
            <Text style={detailStyles.sub}>还没有记录。</Text>
          </Card>
        ) : (
          <Card style={detailStyles.listCard}>
            {movements.some((movement) => movement.type === 'in') ? (
              <Text style={[detailStyles.batchHint, detailStyles.movementHint]}>点一条入库记录可以改价格</Text>
            ) : null}
            {(showAllMovements ? movements : movements.slice(0, 8)).map((movement, index) => (
              <MovementRow
                key={movement.id}
                movement={movement}
                unit={product.unit}
                first={index === 0}
                onEditPrice={movement.type === 'in' && movement.delta > 0 ? () => openSheet({ type: 'price', movement }) : null}
              />
            ))}
            {movements.length > 8 ? (
              <Button
                title={showAllMovements ? '收起' : `查看全部 ${movements.length} 条`}
                variant="ghost"
                compact
                onPress={() => setShowAllMovements((value) => !value)}
                style={detailStyles.moreButton}
              />
            ) : null}
          </Card>
        )}

        <SectionTitle title="信息" />
        <GroupCard>
          {office.multiple ? <InfoRow label={terms.place} value={office.officeName(product.officeId)} /> : null}
          <InfoRow label="分类" value={product.category ?? '—'} />
          <InfoRow label="条码" value={product.barcode ?? '—'} />
          {product.spec ? <InfoRow label="规格" value={product.spec} /> : null}
          <InfoRow label="包装规格" value={packs.length ? describePacks(product.unit, packs) : '—'} />
          {packs
            .filter((pack) => pack.barcode)
            .map((pack) => (
              <InfoRow key={pack.unit} label={`${pack.unit}的条码`} value={pack.barcode ?? ''} />
            ))}
          <InfoRow
            label="上次进价"
            value={lastPrice ? `每${lastPrice.unit} ${formatPrice(lastPrice.unitPrice)}（${purchaseDay(lastPrice.happenedAt)}）` : '没记录'}
          />
          <InfoRow label="存放位置" value={product.location ?? '—'} />
          {shelfLife ? <InfoRow label="保质期" value={formatShelfLife(shelfLife)} /> : null}
          <InfoRow
            label="库存提醒"
            value={
              product.lowStockThreshold === null
                ? '不提醒'
                : `≤ ${formatQty(product.lowStockThreshold)} ${product.unit} 时`
            }
          />
          <InfoRow
            label="到期提醒"
            value={`到期前 ${leadDays} 天起${product.expiryLeadDays === null ? '（默认）' : ''}`}
          />
          {product.note ? <InfoRow label="备注" value={product.note} /> : null}
        </GroupCard>

        <View style={detailStyles.actions}>
          <Button
            title="编辑"
            variant="secondary"
            onPress={() => router.push({ pathname: '/stock/edit/[id]', params: { id: String(product.id) } })}
            style={detailStyles.flex}
          />
          <Button
            title="删除"
            variant="danger"
            onPress={confirmDelete}
            style={detailStyles.flex}
          />
        </View>

        {sheet?.type === 'in' ? (
          <StockInSheet
            unit={product.unit}
            packs={packs}
            defaultUnit={scannedPack?.unit ?? product.unit}
            isFood={product.kind === 'food'}
            shelfLife={shelfLife}
            lastPrice={lastPrice}
            lastIn={lastIn}
            notice={knownNotice ? `已有「${product.name}」，${scannedPack ? `按${scannedPack.unit}` : '直接'}入库` : null}
            onClose={() => {
              setSheet(null);
              setKnownNotice(false);
            }}
            onSubmit={async (quantity, expiryDate, entry, price, usedShelfLife, productionDate) => {
              await stockIn(db, product.id, { quantity, expiryDate, entry, price, shelfLife: usedShelfLife, productionDate });
              const asEntered = entry.unit !== product.unit ? `${formatQty(entry.qty)} ${entry.unit}，` : '';
              const priceNote = price ? `，总价 ${formatPrice(price.totalPrice)}` : '';
              await afterChange(`已入库 ${asEntered}${formatQty(quantity)} ${product.unit}${priceNote}`);
            }}
          />
        ) : null}
        {sheet?.type === 'out' ? (
          <StockOutSheet
            unit={product.unit}
            packs={packs}
            total={totalQty}
            batches={batches.map((batch) => ({ id: batch.id, uid: null, quantity: batch.quantity, expiryDate: batch.expiryDate }))}
            onClose={() => setSheet(null)}
            onSubmit={async (quantity, reason, entry, allocations) => {
              const result = await stockOut(db, product.id, quantity, reason, entry, allocations);
              await afterChange(
                result.shortfall > 0
                  ? `只有 ${formatQty(result.consumed)} ${product.unit}，已全部出库`
                  : `已出库 ${formatQty(result.consumed)} ${product.unit}`,
              );
            }}
          />
        ) : null}
        {sheet?.type === 'price' ? (
          <MovementPriceSheet
            record={sheet.movement}
            baseUnit={product.unit}
            onClose={() => setSheet(null)}
            onSave={async (price) => {
              await updateMovementPrice(db, sheet.movement.id, price);
              await afterChange(price ? `价格已更新，总价 ${formatPrice(price.totalPrice)}` : '已清掉这条入库的价格');
            }}
          />
        ) : null}
        {sheet?.type === 'batch' ? (
          <BatchSheet
            batch={sheet.batch}
            unit={product.unit}
            onClose={() => setSheet(null)}
            onSave={async (quantity, expiryDate) => {
              await updateBatch(db, sheet.batch.id, { quantity, expiryDate });
              await afterChange('批次已更新');
            }}
            onDelete={async () => {
              await deleteBatch(db, sheet.batch.id);
              await afterChange('批次已删除');
            }}
          />
        ) : null}
      </Screen>
      {batchDeletion.pending ? (
        <UndoBar text={`已删除${batchDeletion.pending.label}`} onUndo={batchDeletion.undo} />
      ) : null}
    </View>
  );
}

const OUT_REASONS = ['用掉', '过期丢弃', '坏了', '送人', '其他'];

const MOVEMENT_LABEL: Record<StockMovement['type'], string> = { in: '入库', out: '出库', adjust: '调整' };

/** 入库时间是 ISO（UTC），按手机本地日期显示 */
function purchaseDay(happenedAt: string): string {
  return formatShortDate(toDateStr(new Date(happenedAt)));
}

function describeMovementPrice(movement: StockMovement, unit: string): string | null {
  if (movement.type !== 'in') return null;
  const priceUnit = movement.inputUnit ?? unit;
  const parts = [
    movement.unitPrice !== null ? `单价 ${formatPrice(movement.unitPrice)}/${priceUnit}` : null,
    movement.totalPrice !== null ? `总价 ${formatPrice(movement.totalPrice)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('，') : null;
}

function MovementRow({
  movement,
  unit,
  first,
  onEditPrice,
}: {
  movement: StockMovement;
  unit: string;
  first: boolean;
  /** 入库记录：点了改价格；别的记录没有价格，是 null */
  onEditPrice: (() => void) | null;
}) {
  const colors = useColors();
  const detailStyles = useDetailStyles();
  const positive = movement.delta > 0;
  const enteredInPack =
    movement.inputUnit && movement.inputUnit !== unit && movement.inputQty !== null
      ? `按 ${formatQty(movement.inputQty)} ${movement.inputUnit}`
      : null;
  const detail = [
    enteredInPack,
    movement.note,
    movement.type === 'in' && movement.expiryDate ? `${formatDate(movement.expiryDate)} 到期` : null,
    describeMovementPrice(movement, unit),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole={onEditPrice ? 'button' : undefined}
      accessibilityHint={onEditPrice ? '改这条入库的价格' : undefined}
      disabled={!onEditPrice}
      onPress={onEditPrice ?? undefined}
      style={({ pressed }) => [detailStyles.movementRow, !first && detailStyles.movementDivider, pressed && detailStyles.pressed]}
    >
      <View style={detailStyles.flex}>
        <Text style={detailStyles.batchDate}>
          {MOVEMENT_LABEL[movement.type]}
          {detail ? <Text style={detailStyles.batchMeta}> {detail}</Text> : null}
        </Text>
        <Text style={detailStyles.batchMeta}>{formatDateTime(movement.happenedAt)}</Text>
      </View>
      <Text
        style={[
          detailStyles.batchQty,
          { color: positive ? colors.ok : movement.delta < 0 ? colors.danger : colors.muted },
        ]}
      >
        {positive ? '+' : ''}
        {formatQty(movement.delta)} {unit}
      </Text>
    </Pressable>
  );
}

function StockInSheet({
  unit,
  packs,
  defaultUnit,
  isFood,
  shelfLife,
  lastPrice,
  lastIn,
  notice,
  onClose,
  onSubmit,
}: {
  unit: string;
  packs: PackUnit[];
  defaultUnit: string;
  isFood: boolean;
  /** 商品资料里的保质期：有就默认按「生产日期+保质期」填，生产日期空着等人选或拍 */
  shelfLife: ShelfLife | null;
  lastPrice: LastPurchasePrice | null;
  /** 上一次入库：过期日期的填法、到期日按它带出来（见 lib/stockInDefaults.ts） */
  lastIn: StockMovement | null;
  /** 面板最上面的一句（新增页扫到本机已有的条码跳过来时说明一下），没有是 null */
  notice: string | null;
  onClose: () => void;
  /** shelfLife：按「生产日期+保质期」填时的保质期，商品资料里还没有就记进去；productionDate：记在入库记录上的生产日期（见 ExpiryValue） */
  onSubmit: (
    quantity: number,
    expiryDate: string | null,
    entry: EntryQty,
    price: EntryPrice | null,
    shelfLife: ShelfLife | null,
    productionDate: string | null,
  ) => Promise<void>;
}) {
  /** 1 个这种单位等于多少最小单位（1 箱 = 24 瓶） */
  const detailStyles = useDetailStyles();
  const unitSize = (entry: string) => toBaseQty(1, entry, unit, packs) ?? 1;
  const [qtyText, setQtyText] = useState('1');
  const [entryUnit, setEntryUnit] = useState(defaultUnit);
  // 同一物品默认用上一次的进价，换算成这次的单位
  const [priceDraft, setPriceDraft] = useState<PriceDraft>(() =>
    defaultPriceDraft(lastPrice?.perBaseUnit ?? null, unitSize(defaultUnit)),
  );
  // 单价是按上次进价带出来的、还没改过：标「按上次」（换单位时跟着换算，还算按上次）
  const [priceFromLast, setPriceFromLast] = useState(!!lastPrice);
  // 过期日期按上次入库带出来（填法、到期日或保质期），带出的格子标出来
  const [expiryDefaults] = useState(() =>
    stockInExpiryDefaults({ last: lastIn, shelfLife, isFood, canScan: isLabelOcrAvailable() }),
  );
  const [expiry, setExpiry] = useState<ExpiryValue>({ expiry: null, error: null, shelfLife: null, productionDate: null });
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const qty = parseQty(qtyText);
  const baseQty = qty === null ? null : toBaseQty(qty, entryUnit, unit, packs);
  const qtyError = qty === null || qty <= 0 || baseQty === null ? '请填大于 0 的数量' : null;
  const { price } = derivePrice(priceDraft, qty);

  function changeUnit(next: string) {
    setPriceDraft((draft) => convertPriceUnit(draft, unitSize(entryUnit), unitSize(next)));
    setEntryUnit(next);
  }

  return (
    <Sheet visible title="入库" onClose={onClose}>
      {notice ? (
        <View style={detailStyles.banner}>
          <Text style={detailStyles.bannerText}>{notice}</Text>
        </View>
      ) : null}
      <UnitQtyField
        label="数量"
        baseUnit={unit}
        packs={packs}
        qtyText={qtyText}
        onQtyText={setQtyText}
        unit={entryUnit}
        onUnit={changeUnit}
        error={showErrors ? qtyError : null}
        autoFocus
      />
      <PriceFields
        draft={priceDraft}
        onChange={(draft) => {
          setPriceDraft(draft);
          setPriceFromLast(false);
        }}
        qty={qty}
        unit={entryUnit}
        tag={priceFromLast ? 'last' : null}
        hint={
          lastPrice
            ? `已按上次进价填好（${purchaseDay(lastPrice.happenedAt)}，每${lastPrice.unit} ${formatPrice(lastPrice.unitPrice)}），价格变了直接改。`
            : null
        }
      />
      <ExpiryInput
        initialMode={expiryDefaults.mode}
        fill={expiryDefaults.fill}
        initialShelfLife={shelfLife}
        initialProductionDate={null}
        lastProductionDate={lastProductionDate(lastIn)}
        allowNone
        onChange={setExpiry}
      />
      {showErrors && expiry.error ? <Text style={detailStyles.error}>{expiry.error}</Text> : null}
      <Text style={detailStyles.hintText}>过期日期和已有批次相同时会合并到那一批。</Text>
      <Button
        title="确认入库"
        loading={busy}
        onPress={async () => {
          setShowErrors(true);
          if (qtyError || expiry.error || qty === null || baseQty === null) return;
          setBusy(true);
          try {
            await onSubmit(baseQty, expiry.expiry, { qty, unit: entryUnit }, price, expiry.shelfLife, expiry.productionDate);
          } finally {
            setBusy(false);
          }
        }}
      />
    </Sheet>
  );
}

function StockOutSheet({
  unit,
  packs,
  total,
  batches,
  onClose,
  onSubmit,
}: {
  unit: string;
  packs: PackUnit[];
  total: number;
  /** 在库的批次（先到期的在前）：两批以上时可以选从哪一批出 */
  batches: PickerBatch[];
  onClose: () => void;
  onSubmit: (quantity: number, reason: string, entry: EntryQty, allocations: BatchAllocation[] | null) => Promise<void>;
}) {
  // 现有不到 1 时默认填现有的全部，免得一打开就超了
  const detailStyles = useDetailStyles();
  const [qtyText, setQtyText] = useState(total > 0 && total < 1 ? formatQty(total) : '1');
  const [entryUnit, setEntryUnit] = useState(unit);
  const [reason, setReason] = useState<string>(OUT_REASONS[0]);
  const [note, setNote] = useState('');
  const [allocation, setAllocation] = useState<BatchAllocation[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const qty = parseQty(qtyText);
  const baseQty = qty === null ? null : toBaseQty(qty, entryUnit, unit, packs);
  const qtyError = qty === null || qty <= 0 || baseQty === null ? '请填大于 0 的数量' : null;
  const totalBreakdown = formatBreakdown(total, unit, packs);
  // 不能出得比现有的多：输多了马上提示，不能确认
  const overError = baseQty !== null && baseQty > total ? `最多出 ${formatQty(total)} ${unit}（现有的全部）` : null;
  const picked = pickedAllocation(batches, baseQty, allocation);
  const firstBatch = batches[0] ?? null;

  return (
    <Sheet visible title="出库 / 用掉" onClose={onClose}>
      <View style={detailStyles.group}>
        <Label>原因</Label>
        <ChoiceChips
          options={OUT_REASONS.map((value) => ({ value, label: value }))}
          value={reason}
          onChange={setReason}
        />
      </View>
      <UnitQtyField
        label="数量"
        baseUnit={unit}
        packs={packs}
        qtyText={qtyText}
        onQtyText={setQtyText}
        unit={entryUnit}
        onUnit={setEntryUnit}
        error={overError ?? (showErrors ? qtyError : null)}
        hint={`现有 ${formatQty(total)} ${unit}${totalBreakdown ? `（${totalBreakdown}）` : ''}`}
        max={total}
        autoFocus
      />
      {batches.length >= 2 ? (
        <BatchPicker
          batches={batches}
          amount={qtyError || overError ? null : baseQty}
          unit={unit}
          value={allocation}
          onChange={setAllocation}
          syncEnabled={false}
          showErrors={showErrors}
        />
      ) : firstBatch?.expiryDate ? (
        <Text style={detailStyles.hintText}>先扣 {formatDate(firstBatch.expiryDate)} 到期的那一批。</Text>
      ) : null}
      <Field label="备注" value={note} onChangeText={setNote} placeholder="选填，比如：年会用" maxLength={NOTE_INPUT_MAX} />
      <View style={detailStyles.actions}>
        <Button
          title="全部用完"
          variant="secondary"
          onPress={() => {
            setEntryUnit(unit);
            setQtyText(formatQty(total));
          }}
          style={detailStyles.flex}
        />
        <Button
          title="确认出库"
          loading={busy}
          style={detailStyles.flex}
          onPress={async () => {
            setShowErrors(true);
            if (overError || qtyError || qty === null || baseQty === null || picked.error) return;
            setBusy(true);
            try {
              await onSubmit(baseQty, outNote(reason, note), { qty, unit: entryUnit }, picked.allocations);
            } finally {
              setBusy(false);
            }
          }}
        />
      </View>
    </Sheet>
  );
}

function BatchSheet({
  batch,
  unit,
  onClose,
  onSave,
  onDelete,
}: {
  batch: StockBatch;
  unit: string;
  onClose: () => void;
  onSave: (quantity: number, expiryDate: string | null) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const detailStyles = useDetailStyles();
  const [qtyText, setQtyText] = useState(formatQty(batch.quantity));
  const [expiryDate, setExpiryDate] = useState<string | null>(batch.expiryDate);
  const qty = parseQty(qtyText);

  return (
    <Sheet visible title="调整这一批" onClose={onClose}>
      <NumberField
        label={`数量（${unit}）`}
        value={qtyText}
        onChangeText={setQtyText}
        decimals={2}
        max={1000000}
        suffix={unit}
        hint="改成 0 等于删除这一批"
        error={qty === null ? '请填数量' : null}
      />
      <DateField label="过期日期" value={expiryDate} onChange={setExpiryDate} clearable placeholder="没记过期日期" />
      <View style={detailStyles.actions}>
        <Button title="删除这一批" variant="danger" onPress={onDelete} style={detailStyles.flex} />
        <Button
          title="保存"
          disabled={qty === null}
          onPress={() => (qty === null ? undefined : onSave(qty, expiryDate))}
          style={detailStyles.flex}
        />
      </View>
    </Sheet>
  );
}

// 照鸿蒙版 ProductDetailPage.ets：顶上一张大卡片（分类、名称、大数字、状态、入库出库），批次一批一张小卡片，
// 记录和信息是不留内边距的分组卡片、行间画分隔线
const useDetailStyles = makeStyles((colors) => ({
  flex: { flex: 1, minWidth: 0 },
  banner: {
    backgroundColor: colors.infoSoft,
    borderRadius: radius.md,
    padding: 12,
  },
  bannerText: { color: colors.info, fontSize: font.body, fontWeight: '500' },
  summary: { gap: 12 },
  summaryTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  kind: { fontSize: font.tiny, color: colors.accent, fontWeight: '700' },
  title: { fontSize: font.title, fontWeight: '700', color: colors.ink, marginTop: 2 },
  sub: { fontSize: font.small, color: colors.muted, marginTop: 2 },
  qtyBox: { alignItems: 'flex-end' },
  qty: { fontSize: 34, fontWeight: '800', color: colors.ink, fontVariant: ['tabular-nums'] },
  unit: { fontSize: font.small, color: colors.muted },
  chips: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: 12 },
  message: { fontSize: font.small, color: colors.ok, fontWeight: '500' },
  listCard: { padding: 0, gap: 0, overflow: 'hidden' },
  moreButton: { marginVertical: 4 },
  screen: { flex: 1, backgroundColor: colors.bg },
  // 记录卡片不留内边距：每一行左边用外边距空出 16，上面的分隔线也就从 16 开始、右边到头（和鸿蒙版一样）
  movementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    marginLeft: 16,
    paddingRight: 16,
    backgroundColor: colors.surface,
  },
  movementDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  movementHint: { paddingTop: 10, paddingHorizontal: 16 },
  pressed: { opacity: 0.6 },
  // 批次：每一批一张卡片，和外面列表的一行一样，左滑删除的样子也一样
  batchList: { gap: 8 },
  batchHint: { fontSize: font.small, color: colors.faint, textAlign: 'center' },
  batchItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 64,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  batchMain: { flex: 1, gap: 4, minWidth: 0 },
  batchMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  batchDate: { fontSize: font.body, color: colors.ink, fontWeight: '500' },
  batchMeta: { fontSize: font.small, color: colors.faint, marginTop: 2 },
  batchQty: {
    fontSize: font.body,
    fontWeight: '700',
    color: colors.ink,
    minWidth: 56,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  error: { fontSize: font.small, color: colors.danger },
  hintText: { fontSize: font.small, color: colors.faint },
  group: { gap: 8 },
  breakdown: { fontSize: font.small, color: colors.accent, fontWeight: '600', marginTop: 2 },
}));
