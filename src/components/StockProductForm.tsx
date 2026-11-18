import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AppSettings } from '../db/settings';
import { listLocations, type BatchInput, type StockProductInput } from '../db/stock';
import { lookupBarcode, looksLikeProductBarcode } from '../lib/barcodeLookup';
import { takeScanResult } from '../lib/scanHandoff';
import { DEFAULT_UNITS, KIND_LABEL, parseQty, type StockKind } from '../lib/stock';
import { colors, font } from '../theme';
import { ExpiryInput, type ExpiryValue } from './ExpiryInput';
import { Button, Card, ChoiceChips, Field, IconButton, Label, Screen, SectionTitle, Segmented } from './ui';

const SCAN_TARGET = 'stock-form-barcode';

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
  const [qtyText, setQtyText] = useState('1');
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
    }, [runLookup]),
  );

  const lowStockThreshold = lowStockText.trim() === '' ? null : parseQty(lowStockText);
  const leadDays = leadText.trim() === '' ? null : Number(leadText);
  const qty = parseQty(qtyText);

  const errors = {
    name: name.trim() ? null : '请填写名称',
    lowStock: lowStockText.trim() !== '' && lowStockThreshold === null ? '请填数字，留空表示不提醒' : null,
    lead:
      leadText.trim() !== '' && (!Number.isInteger(leadDays) || (leadDays ?? 0) < 0 || (leadDays ?? 0) > 365)
        ? '请填 0–365 的整数，留空表示用默认设置'
        : null,
    qty: withFirstBatch && qty === null ? '请填数量（可以是 0）' : null,
    expiry: withFirstBatch && (qty ?? 0) > 0 ? expiry.error : null,
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
        },
        withFirstBatch && qty && qty > 0 ? { quantity: qty, expiryDate: expiry.expiry } : null,
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
                : '商品库里没有这个条码，请手动填名称；保存后再扫就能直接认出来。'}
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
          <Label>单位</Label>
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

      {withFirstBatch ? (
        <>
          <SectionTitle title="这次入库" />
          <Card>
            <Field
              label={`数量（${unit || '件'}）`}
              value={qtyText}
              onChangeText={setQtyText}
              keyboardType="decimal-pad"
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
          label="库存下限"
          value={lowStockText}
          onChangeText={setLowStockText}
          keyboardType="decimal-pad"
          placeholder="留空表示不提醒"
          hint={`库存 ≤ 这个数时提醒补货`}
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
});
