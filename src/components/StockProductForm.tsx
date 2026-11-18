import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AppSettings } from '../db/settings';
import { listLocations, type BatchInput, type StockProductInput } from '../db/stock';
import { lookupBarcode, looksLikeProductBarcode } from '../lib/barcodeLookup';
import { toBaseQty, validatePacks, type PackUnit } from '../lib/packs';
import { takeScanResult, takeScanResultWithPrefix } from '../lib/scanHandoff';
import { DEFAULT_UNITS, formatQty, KIND_LABEL, parseQty, type StockKind } from '../lib/stock';
import { colors, font, radius } from '../theme';
import { ExpiryInput, type ExpiryValue } from './ExpiryInput';
import { Button, Card, ChoiceChips, Field, IconButton, Label, Screen, SectionTitle, Segmented } from './ui';
import { UnitQtyField } from './UnitQtyField';

const SCAN_TARGET = 'stock-form-barcode';
const PACK_SCAN_PREFIX = 'stock-form-pack-';
const PACK_SUGGESTIONS = ['箱', '提', '包', '盒', '袋', '件'];

type PackRow = { key: number; unit: string; sizeText: string; barcode: string };

let packRowKey = 0;
function toPackRow(pack: PackUnit): PackRow {
  return { key: ++packRowKey, unit: pack.unit, sizeText: formatQty(pack.size), barcode: pack.barcode ?? '' };
}

type LookupState = 'idle' | 'loading' | 'found' | 'notfound';

export function StockProductForm({
  initial,
  settings,
  withFirstBatch,
  submitLabel,
  onSubmit,
}: {
  initial: Partial<StockProductInput> & { kind: StockKind };
  settings: AppSettings;
  withFirstBatch: boolean;
  submitLabel: string;
  onSubmit: (input: StockProductInput, firstBatch: BatchInput | null) => Promise<void>;
}) {
  const db = useSQLiteContext();
  const [kind, setKind] = useState<StockKind>(initial.kind);
  const [barcode, setBarcode] = useState(initial.barcode ?? '');
  const [name, setName] = useState(initial.name ?? '');
  const [brand, setBrand] = useState(initial.brand ?? '');
  const [spec, setSpec] = useState(initial.spec ?? '');
  const [unit, setUnit] = useState(initial.unit ?? '件');
  const [location, setLocation] = useState(initial.location ?? '');
  const [lowStockText, setLowStockText] = useState(
    initial.lowStockThreshold === undefined
      ? String(settings.defaultLowStockThreshold)
      : initial.lowStockThreshold === null
        ? ''
        : String(initial.lowStockThreshold),
  );
  const [leadText, setLeadText] = useState(
    initial.expiryLeadDays === undefined || initial.expiryLeadDays === null ? '' : String(initial.expiryLeadDays),
  );
  const [note, setNote] = useState(initial.note ?? '');
  const [packRows, setPackRows] = useState<PackRow[]>(() => (initial.packs ?? []).map(toPackRow));
  const [qtyText, setQtyText] = useState('1');
  const [entryUnit, setEntryUnit] = useState(initial.unit ?? '件');
  const [expiry, setExpiry] = useState<ExpiryValue>({ expiry: null, error: null });
  const [locations, setLocations] = useState<string[]>([]);
  // 新建时带着扫到的条码进来，并且还没有名称：自动查一次商品名
  const autoLookupCode =
    withFirstBatch &&
    initial.barcode &&
    !initial.name &&
    settings.onlineLookup &&
    looksLikeProductBarcode(initial.barcode)
      ? initial.barcode
      : null;
  const [lookup, setLookup] = useState<LookupState>(autoLookupCode ? 'loading' : 'idle');
  const [submitting, setSubmitting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const lookedUp = useRef<string | null>(null);

  useEffect(() => {
    listLocations(db).then(setLocations).catch(() => undefined);
  }, [db]);

  /** 查商品库并把结果填进还空着的字段。只在 await 之后改状态。 */
  const applyLookup = useCallback(async (code: string) => {
    const info = await lookupBarcode(code);
    if (lookedUp.current !== code) return;
    if (!info) {
      setLookup('notfound');
      return;
    }
    setLookup('found');
    if (info.name) setName((current) => current || info.name || '');
    if (info.brand) setBrand((current) => current || info.brand || '');
    if (info.spec) setSpec((current) => current || info.spec || '');
  }, []);

  const runLookup = useCallback(
    (code: string) => {
      if (!settings.onlineLookup || !looksLikeProductBarcode(code) || lookedUp.current === code) return;
      lookedUp.current = code;
      setLookup('loading');
      applyLookup(code).catch(() => setLookup('notfound'));
    },
    [settings.onlineLookup, applyLookup],
  );

  useEffect(() => {
    if (!autoLookupCode || lookedUp.current === autoLookupCode) return;
    lookedUp.current = autoLookupCode;
    applyLookup(autoLookupCode).catch(() => setLookup('notfound'));
  }, [autoLookupCode, applyLookup]);

  // 从扫码页回来时取走扫到的条码
  useFocusEffect(
    useCallback(() => {
      const code = takeScanResult(SCAN_TARGET);
      if (code) {
        setBarcode(code);
        runLookup(code);
      }
      const packScan = takeScanResultWithPrefix(PACK_SCAN_PREFIX);
      if (packScan) {
        const key = Number(packScan.target.slice(PACK_SCAN_PREFIX.length));
        setPackRows((rows) => rows.map((row) => (row.key === key ? { ...row, barcode: packScan.code } : row)));
      }
    }, [runLookup]),
  );

  function updatePackRow(key: number, patch: Partial<PackRow>) {
    setPackRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  const lowStockThreshold = lowStockText.trim() === '' ? null : parseQty(lowStockText);
  const leadDays = leadText.trim() === '' ? null : Number(leadText);
  const qty = parseQty(qtyText);
  const baseUnit = unit.trim() || '件';
  const packs: PackUnit[] = packRows.map((row) => ({
    unit: row.unit.trim(),
    size: parseQty(row.sizeText) ?? Number.NaN,
    barcode: row.barcode.trim() || null,
  }));
  const packError = validatePacks(baseUnit, packs);
  const usablePacks = packError ? [] : packs;
  const baseQty = qty === null ? null : toBaseQty(qty, entryUnit, baseUnit, usablePacks) ?? qty;

  const errors = {
    name: name.trim() ? null : '请填写名称',
    lowStock: lowStockText.trim() !== '' && lowStockThreshold === null ? '请填数字，留空表示不提醒' : null,
    lead:
      leadText.trim() !== '' && (!Number.isInteger(leadDays) || (leadDays ?? 0) < 0 || (leadDays ?? 0) > 365)
        ? '请填 0–365 的整数，留空表示用默认设置'
        : null,
    qty: withFirstBatch && qty === null ? '请填数量（可以是 0）' : null,
    expiry: withFirstBatch && (qty ?? 0) > 0 ? expiry.error : null,
    packs: packError,
  };
  const hasErrors = Object.values(errors).some(Boolean);

  async function submit() {
    setShowErrors(true);
    setSubmitError(null);
    if (hasErrors) return;
    setSubmitting(true);
    try {
      await onSubmit(
        {
          kind,
          barcode: barcode.trim() || null,
          name,
          brand,
          spec,
          unit,
          location,
          lowStockThreshold,
          expiryLeadDays: leadDays,
          note,
          packs,
        },
        withFirstBatch && qty && qty > 0 && baseQty
          ? {
              quantity: baseQty,
              expiryDate: expiry.expiry,
              entry: { qty, unit: usablePacks.some((pack) => pack.unit === entryUnit) ? entryUnit : baseUnit },
            }
          : null,
      );
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const shown = (message: string | null) => (showErrors ? message : null);
  const unitOptions = Array.from(new Set([...DEFAULT_UNITS[kind], unit].filter(Boolean))).map((value) => ({
    value,
    label: value,
  }));

  return (
    <Screen>
      <Segmented
        options={[
          { value: 'food', label: KIND_LABEL.food },
          { value: 'daily', label: KIND_LABEL.daily },
        ]}
        value={kind}
        onChange={setKind}
      />

      <Card>
        <Field
          label="条码"
          value={barcode}
          onChangeText={(value) => {
            setBarcode(value);
            setLookup('idle');
          }}
          onEndEditing={() => runLookup(barcode.trim())}
          placeholder="扫码或手动输入，可不填"
          keyboardType="number-pad"
          right={
            <IconButton
              icon="barcode-outline"
              label="扫描条码"
              onPress={() => router.push({ pathname: '/scan', params: { target: SCAN_TARGET } })}
            />
          }
        />
        {lookup !== 'idle' ? (
          <Text style={[formStyles.lookup, lookup === 'found' && { color: colors.ok }]}>
            {lookup === 'loading'
              ? '正在查商品库…'
              : lookup === 'found'
                ? '已从商品库带出名称，请核对。'
                : '商品库里没有这个条码，请手动填名称；保存后再扫就能直接认出来。如果这是某个已录物品的整箱条码，到那个物品的「编辑 → 包装规格」里扫它。'}
          </Text>
        ) : null}
        <Field label="名称" required value={name} onChangeText={setName} placeholder="例如 纯牛奶" error={shown(errors.name)} />
        <View style={formStyles.twoCols}>
          <View style={formStyles.col}>
            <Field label="品牌" value={brand} onChangeText={setBrand} placeholder="可不填" />
          </View>
          <View style={formStyles.col}>
            <Field label="规格" value={spec} onChangeText={setSpec} placeholder="如 250ml×12" />
          </View>
        </View>
        <View style={formStyles.group}>
          <Label>最小单位（库存按它算）</Label>
          <ChoiceChips options={unitOptions} value={unit} onChange={setUnit} />
          <Field value={unit} onChangeText={setUnit} placeholder="其他单位" maxLength={6} />
        </View>
        <View style={formStyles.group}>
          <Field label="存放位置" value={location} onChangeText={setLocation} placeholder="如 冰箱冷藏、储物柜" />
          {locations.length ? (
            <ChoiceChips
              options={locations.map((value) => ({ value, label: value }))}
              value={location}
              onChange={setLocation}
            />
          ) : null}
        </View>
      </Card>

      <SectionTitle title="包装规格（可选）" />
      <Card>
        <Text style={formStyles.hint}>
          整箱进、按{baseUnit}出的东西在这里设，如「1 箱 = 24 {baseUnit}」。入库出库时可以按箱或按{baseUnit}填，库存自动换算。
          整箱外包装上的条码也可以录进来，扫箱子就能认出。
        </Text>
        {packRows.map((row) => (
          <View key={row.key} style={formStyles.packRow}>
            <View style={formStyles.packLine}>
              <Text style={formStyles.packText}>1</Text>
              <View style={formStyles.packUnit}>
                <Field value={row.unit} onChangeText={(value) => updatePackRow(row.key, { unit: value })} placeholder="箱" maxLength={6} />
              </View>
              <Text style={formStyles.packText}>=</Text>
              <View style={formStyles.packSize}>
                <Field
                  value={row.sizeText}
                  onChangeText={(value) => updatePackRow(row.key, { sizeText: value })}
                  placeholder="24"
                  keyboardType="decimal-pad"
                />
              </View>
              <Text style={formStyles.packText}>{baseUnit}</Text>
              <IconButton
                icon="trash-outline"
                label="删除这个包装规格"
                color={colors.danger}
                onPress={() => setPackRows((rows) => rows.filter((candidate) => candidate.key !== row.key))}
              />
            </View>
            <Field
              value={row.barcode}
              onChangeText={(value) => updatePackRow(row.key, { barcode: value })}
              placeholder={`${row.unit || '这个包装'}的条码，可不填`}
              keyboardType="number-pad"
              right={
                <IconButton
                  icon="barcode-outline"
                  label="扫描包装条码"
                  onPress={() => router.push({ pathname: '/scan', params: { target: `${PACK_SCAN_PREFIX}${row.key}` } })}
                />
              }
            />
          </View>
        ))}
        {packRows.length === 0 ? null : shown(errors.packs) ? <Text style={formStyles.error}>{errors.packs}</Text> : null}
        <View style={formStyles.packAdd}>
          {PACK_SUGGESTIONS.filter((value) => value !== baseUnit && !packRows.some((row) => row.unit === value))
            .slice(0, 3)
            .map((value) => (
              <Button
                key={value}
                title={`+ 按${value}`}
                compact
                variant="secondary"
                onPress={() => setPackRows((rows) => [...rows, { key: ++packRowKey, unit: value, sizeText: '', barcode: '' }])}
              />
            ))}
          <Button
            title="+ 其他"
            compact
            variant="ghost"
            onPress={() => setPackRows((rows) => [...rows, { key: ++packRowKey, unit: '', sizeText: '', barcode: '' }])}
          />
        </View>
      </Card>

      {withFirstBatch ? (
        <>
          <SectionTitle title="这次入库" />
          <Card>
            <UnitQtyField
              label="数量"
              baseUnit={baseUnit}
              packs={usablePacks}
              qtyText={qtyText}
              onQtyText={setQtyText}
              unit={entryUnit}
              onUnit={setEntryUnit}
              error={shown(errors.qty)}
            />
            <ExpiryInput
              key={kind}
              initialMode={kind === 'food' ? 'date' : 'none'}
              allowNone
              onChange={setExpiry}
            />
            {shown(errors.expiry) ? <Text style={formStyles.error}>{errors.expiry}</Text> : null}
          </Card>
        </>
      ) : null}

      <SectionTitle title="提醒" />
      <Card>
        <Field
          label={`库存下限（${baseUnit}）`}
          value={lowStockText}
          onChangeText={setLowStockText}
          keyboardType="decimal-pad"
          placeholder="留空表示不提醒"
          hint={
            usablePacks.length
              ? `库存 ≤ 这个数时提醒补货。按${baseUnit}算，比如想剩 1 ${usablePacks[0].unit}时提醒就填 ${formatQty(usablePacks[0].size)}`
              : '库存 ≤ 这个数时提醒补货'
          }
          error={shown(errors.lowStock)}
        />
        <Field
          label="到期前几天提醒"
          value={leadText}
          onChangeText={setLeadText}
          keyboardType="number-pad"
          placeholder={`留空用默认设置（${settings.expiryLeadDays} 天）`}
          error={shown(errors.lead)}
        />
      </Card>

      <Field label="备注" value={note} onChangeText={setNote} placeholder="可不填" multiline />

      {submitError ? <Text style={formStyles.error}>{submitError}</Text> : null}
      <Button title={submitLabel} onPress={submit} loading={submitting} />
    </Screen>
  );
}

const formStyles = StyleSheet.create({
  twoCols: { flexDirection: 'row', gap: 10 },
  col: { flex: 1, minWidth: 0 },
  group: { gap: 8 },
  lookup: { fontSize: font.small, color: colors.muted },
  error: { fontSize: font.small, color: colors.danger },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  packRow: {
    gap: 8,
    padding: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSunken,
  },
  packLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  packText: { fontSize: font.body, color: colors.ink, fontWeight: '600' },
  packUnit: { width: 72 },
  packSize: { flex: 1, minWidth: 0 },
  packAdd: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
