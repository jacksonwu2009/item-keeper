import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DEVICE_CATEGORIES, type DeviceInput } from '../db/devices';
import { useOffice } from '../hooks/useOffice';
import { formatDate } from '../lib/dates';
import { takeScanResult } from '../lib/scanHandoff';
import { validateAccessories, warrantyEnd, type WarrantyUnit } from '../lib/warranty';
import { colors, font, radius } from '../theme';
import { DateField } from './DateField';
import { IntegerField } from './NumberField';
import { OfficeChooser } from './OfficeSwitcher';
import { Button, Card, ChoiceChips, Field, IconButton, Label, Screen, SectionTitle, Segmented } from './ui';

const SCAN_TARGET = 'device-form-serial';
const ACCESSORY_SUGGESTIONS = ['充电器', '电源线', '鼠标', '键盘', '扩展坞', '数据线', '电脑包', '耳机'];

type WarrantyMode = 'none' | 'period' | 'date';
type AccessoryRow = { key: number; name: string; quantity: number | null };

let accessoryKey = 0;

export function DeviceForm({
  initial,
  minQuantity = 1,
  submitLabel,
  onSubmit,
}: {
  initial?: Partial<DeviceInput>;
  /** 编辑时数量不能少于正在借出的数量 */
  minQuantity?: number;
  submitLabel: string;
  onSubmit: (input: DeviceInput) => Promise<void>;
}) {
  const office = useOffice();
  const [officeId, setOfficeId] = useState(initial?.officeId ?? office.defaultId);
  const [category, setCategory] = useState(initial?.category ?? '笔记本');
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [serialNo, setSerialNo] = useState(initial?.serialNo ?? '');
  const [quantity, setQuantity] = useState<number | null>(initial?.quantity ?? 1);
  const [note, setNote] = useState(initial?.note ?? '');
  const [purchaseDate, setPurchaseDate] = useState<string | null>(initial?.purchaseDate ?? null);
  const [warrantyMode, setWarrantyMode] = useState<WarrantyMode>(initial?.warrantyUntil ? 'date' : 'none');
  const [warrantyAmount, setWarrantyAmount] = useState<number | null>(1);
  const [warrantyUnit, setWarrantyUnit] = useState<WarrantyUnit>('year');
  const [warrantyDate, setWarrantyDate] = useState<string | null>(initial?.warrantyUntil ?? null);
  const [accessories, setAccessories] = useState<AccessoryRow[]>(() =>
    (initial?.accessories ?? []).map((item) => ({ key: ++accessoryKey, name: item.name, quantity: item.quantity })),
  );
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const code = takeScanResult(SCAN_TARGET);
      if (code) setSerialNo(code);
    }, []),
  );

  const warrantyUntil =
    warrantyMode === 'none'
      ? null
      : warrantyMode === 'date'
        ? warrantyDate
        : purchaseDate && warrantyAmount !== null
          ? warrantyEnd(purchaseDate, warrantyAmount, warrantyUnit)
          : null;
  // 数量框清空或超范围时是 null，按 0 交给校验，报「数量要是 1 到 9999」
  const accessoryList = accessories.map((row) => ({ name: row.name.trim(), quantity: row.quantity ?? 0 }));

  const errors = {
    name: name.trim() ? null : '请填写名称',
    quantity: quantity === null ? `请填数量（${Math.max(1, minQuantity)} 到 9999）` : null,
    warranty:
      warrantyMode === 'period' && warrantyAmount === null
        ? '请填保修期（1 到 120）'
        : warrantyMode === 'period' && !purchaseDate
        ? '按保修期算需要先填购买日期'
        : warrantyMode === 'date' && !warrantyDate
          ? '请选择保修到期日'
          : warrantyUntil && purchaseDate && warrantyUntil < purchaseDate
            ? '保修到期日不能早于购买日期'
            : null,
    accessories: validateAccessories(accessoryList),
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const shown = (message: string | null) => (showErrors ? message : null);
  const categories = Array.from(new Set([...DEVICE_CATEGORIES, category])).map((value) => ({ value, label: value }));

  function addAccessory(accessoryName: string) {
    setAccessories((rows) => [...rows, { key: ++accessoryKey, name: accessoryName, quantity: 1 }]);
  }

  function updateAccessory(key: number, patch: Partial<AccessoryRow>) {
    setAccessories((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function submit() {
    setShowErrors(true);
    setSubmitError(null);
    if (hasErrors) return;
    setBusy(true);
    try {
      await onSubmit({
        officeId,
        category,
        name,
        model,
        serialNo,
        quantity: quantity ?? 1,
        note,
        purchaseDate,
        warrantyUntil,
        accessories: accessoryList,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <OfficeChooser value={officeId} onChange={setOfficeId} />
      <Card>
        <View style={formStyles.group}>
          <Label>类别</Label>
          <ChoiceChips options={categories} value={category} onChange={setCategory} />
        </View>
        <Field
          label="名称"
          required
          value={name}
          onChangeText={setName}
          placeholder="如 MacBook Pro 14"
          error={shown(errors.name)}
        />
        <Field label="型号" value={model} onChangeText={setModel} placeholder="如 M3 Pro 18G/512G、U2723QE" />
        <Field
          label="序列号"
          value={serialNo}
          onChangeText={setSerialNo}
          placeholder="可不填；多台同款建议分开登记"
          autoCapitalize="characters"
          right={
            <IconButton
              icon="barcode-outline"
              label="扫描序列号"
              onPress={() => router.push({ pathname: '/scan', params: { target: SCAN_TARGET } })}
            />
          }
        />
        <IntegerField
          label="数量"
          value={quantity}
          onChange={setQuantity}
          min={Math.max(1, minQuantity)}
          max={9999}
          suffix="件"
          hint={minQuantity > 1 ? `目前借出 ${minQuantity} 件，数量不能比这个少` : undefined}
          error={shown(errors.quantity)}
        />
      </Card>

      <SectionTitle title="购买与保修" />
      <Card>
        <DateField
          label="购买日期"
          value={purchaseDate}
          onChange={setPurchaseDate}
          clearable
          placeholder="可不填"
        />
        <View style={formStyles.group}>
          <Label>保修</Label>
          <Segmented
            options={[
              { value: 'none', label: '不记录' },
              { value: 'period', label: '按保修期算' },
              { value: 'date', label: '选到期日' },
            ]}
            value={warrantyMode}
            onChange={setWarrantyMode}
          />
        </View>
        {warrantyMode === 'period' ? (
          <View style={formStyles.group}>
            <IntegerField label="保修期" value={warrantyAmount} onChange={setWarrantyAmount} min={1} max={120} />
            <ChoiceChips
              options={[
                { value: 'year', label: '年' },
                { value: 'month', label: '个月' },
              ]}
              value={warrantyUnit}
              onChange={setWarrantyUnit}
            />
          </View>
        ) : null}
        {warrantyMode === 'date' ? (
          <DateField label="保修到期日" required value={warrantyDate} onChange={setWarrantyDate} />
        ) : null}
        {warrantyMode !== 'none' && warrantyUntil && !errors.warranty ? (
          <Text style={formStyles.computed}>
            保修到 <Text style={formStyles.computedDate}>{formatDate(warrantyUntil)}</Text>
          </Text>
        ) : null}
        {warrantyMode !== 'none' && errors.warranty ? (
          <Text style={showErrors ? formStyles.error : formStyles.hint}>{errors.warranty}</Text>
        ) : null}
      </Card>

      <SectionTitle title="配件" />
      <Card>
        <Text style={formStyles.hint}>
          随这件设备一起领走、一起退还的东西，比如充电器、扩展坞。数量按每件设备配几个填。单独借的备用鼠标、键盘，建议另外登记成设备。
        </Text>
        {accessories.map((row) => (
          <View key={row.key} style={formStyles.accessoryRow}>
            <View style={formStyles.accessoryName}>
              <Field
                value={row.name}
                onChangeText={(value) => updateAccessory(row.key, { name: value })}
                placeholder="配件名称"
                maxLength={20}
              />
            </View>
            <View style={formStyles.accessoryQty}>
              <IntegerField
                value={row.quantity}
                onChange={(value) => updateAccessory(row.key, { quantity: value })}
                min={1}
                max={9999}
                accessibilityLabel={`${row.name || '配件'}数量`}
              />
            </View>
            <IconButton
              icon="trash-outline"
              label={`删除配件${row.name}`}
              color={colors.danger}
              onPress={() => setAccessories((rows) => rows.filter((candidate) => candidate.key !== row.key))}
            />
          </View>
        ))}
        {shown(errors.accessories) ? <Text style={formStyles.error}>{errors.accessories}</Text> : null}
        <View style={formStyles.chips}>
          {ACCESSORY_SUGGESTIONS.filter((value) => !accessories.some((row) => row.name.trim() === value))
            .slice(0, 5)
            .map((value) => (
              <Button key={value} title={`+ ${value}`} compact variant="secondary" onPress={() => addAccessory(value)} />
            ))}
          <Button title="+ 其他" compact variant="ghost" onPress={() => addAccessory('')} />
        </View>
      </Card>

      <Field label="备注" value={note} onChangeText={setNote} placeholder="发票号、存放位置等" multiline />
      {submitError ? <Text style={formStyles.error}>{submitError}</Text> : null}
      <Button title={submitLabel} onPress={submit} loading={busy} />
    </Screen>
  );
}

const formStyles = StyleSheet.create({
  group: { gap: 8 },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  error: { fontSize: font.small, color: colors.danger },
  computed: { fontSize: font.small, color: colors.muted },
  computedDate: { color: colors.accent, fontWeight: '700' },
  accessoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSunken,
  },
  accessoryName: { flex: 1, minWidth: 0 },
  accessoryQty: { width: 150 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
