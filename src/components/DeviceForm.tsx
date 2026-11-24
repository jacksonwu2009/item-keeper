import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { DEVICE_CATEGORIES, type DeviceInput } from '../db/devices';
import { useOffice } from '../hooks/useOffice';
import { useScene } from '../hooks/useScene';
import { formatDate } from '../lib/dates';
import {
  composeChip,
  hasComputerConfig,
  HOME_ACCESSORY_SUGGESTIONS,
  HOME_DEVICE_CATEGORIES,
  isMacName,
  MAC_CHIP_GENERATIONS,
  MAC_CHIP_TIERS,
  MEMORY_OPTIONS,
  normalizeCapacity,
  parseChip,
  presetLabel,
  presetMatchesForm,
  STORAGE_OPTIONS,
  type DevicePreset,
} from '../lib/devicePresets';
import { takeScanResult } from '../lib/scanHandoff';
import { validateAccessories, warrantyEnd, type WarrantyUnit } from '../lib/warranty';
import { makeStyles, useColors } from '../hooks/useTheme';
import { font, radius } from '../theme';
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
  presets,
  onSubmitAndNext,
}: {
  initial?: Partial<DeviceInput>;
  /** 编辑时数量不能少于正在借出的数量 */
  minQuantity?: number;
  submitLabel: string;
  onSubmit: (input: DeviceInput) => Promise<void>;
  /** 新增时的快速选择（登记过的组合 + 内置常用设备）；不传就不显示 */
  presets?: DevicePreset[];
  /** 传了就多一个「保存并扫下一台」按钮（同款批量登记） */
  onSubmitAndNext?: (input: DeviceInput) => Promise<void>;
}) {
  const colors = useColors();
  const formStyles = useFormStyles();
  const office = useOffice();
  // 家庭场景：类别、配件建议换成家里常见的
  const home = useScene().scene === 'home';
  const categoryList = home ? HOME_DEVICE_CATEGORIES : DEVICE_CATEGORIES;
  const [officeId, setOfficeId] = useState(initial?.officeId ?? office.defaultId);
  const [category, setCategory] = useState(initial?.category ?? categoryList[0]);
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [serialNo, setSerialNo] = useState(initial?.serialNo ?? '');
  const [chip, setChip] = useState(initial?.chip ?? '');
  const [memory, setMemory] = useState(initial?.memory ?? '');
  const [storage, setStorage] = useState(initial?.storage ?? '');
  const [quantity, setQuantity] = useState<number | null>(initial?.quantity ?? 1);
  const [note, setNote] = useState(initial?.note ?? '');
  const [purchaseDate, setPurchaseDate] = useState<string | null>(initial?.purchaseDate ?? null);
  const [invoiceNo, setInvoiceNo] = useState(initial?.invoiceNo ?? '');
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
  const categories = Array.from(new Set([...categoryList, category])).map((value) => ({ value, label: value }));

  function addAccessory(accessoryName: string) {
    setAccessories((rows) => [...rows, { key: ++accessoryKey, name: accessoryName, quantity: 1 }]);
  }

  function updateAccessory(key: number, patch: Partial<AccessoryRow>) {
    setAccessories((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  /** 最近选的快速选项（快速选择里的第几个）；表单再改了名称、配置等就不算选中 */
  const [appliedPresetIndex, setAppliedPresetIndex] = useState<number | null>(null);

  /** 选了快速选择里的一项：类别、名称、型号、配置、配件都换成它的 */
  function applyPreset(preset: DevicePreset) {
    setCategory(preset.category);
    setName(preset.name);
    setModel(preset.model ?? '');
    setChip(preset.chip ?? '');
    setMemory(preset.memory ?? '');
    setStorage(preset.storage ?? '');
    setAccessories(preset.accessories.map((item) => ({ key: ++accessoryKey, name: item.name, quantity: item.quantity })));
  }

  const showConfig = hasComputerConfig(category);
  // 选过的快速选项还和表单一致时标成选中（主色底），改了名称、配置等就取消选中
  const appliedPreset = appliedPresetIndex !== null && presets ? presets[appliedPresetIndex] : undefined;
  const selectedPresetIndex =
    appliedPreset && presetMatchesForm(appliedPreset, { category, name, model, chip, memory, storage }) ? appliedPresetIndex : null;
  const chipParts = parseChip(chip);

  async function submit(handler: (input: DeviceInput) => Promise<void>) {
    setShowErrors(true);
    setSubmitError(null);
    if (hasErrors) return;
    setBusy(true);
    try {
      await handler({
        officeId,
        category,
        name,
        model,
        serialNo,
        quantity: quantity ?? 1,
        note,
        purchaseDate,
        warrantyUntil,
        invoiceNo,
        // 不是电脑的类别不存配置（比如先选了笔记本又改成显示器）
        chip: showConfig ? chip.trim() || null : null,
        memory: showConfig ? normalizeCapacity(memory) : null,
        storage: showConfig ? normalizeCapacity(storage) : null,
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
      {presets && presets.length > 0 ? (
        <View style={formStyles.group}>
          <Label>快速选择</Label>
          <ChoiceChips
            options={presets.slice(0, 14).map((preset, index) => ({ value: index, label: presetLabel(preset) }))}
            value={selectedPresetIndex}
            onChange={(index) => {
              setAppliedPresetIndex(index);
              applyPreset(presets[index]);
            }}
          />
          <Text style={formStyles.hint}>前面是登记过的，选了自动填类别、名称、配置和配件，再按实际改。</Text>
        </View>
      ) : null}
      <OfficeChooser value={officeId} onChange={setOfficeId} />
      <Card style={formStyles.card}>
        <View style={formStyles.group}>
          <Label>类别</Label>
          <ChoiceChips options={categories} value={category} onChange={setCategory} />
        </View>
        <Field
          label="名称"
          required
          value={name}
          onChangeText={setName}
          placeholder={home ? '如 客厅电视' : '如 MacBook Pro 14 英寸'}
          error={shown(errors.name)}
        />
        <Field
          label="型号"
          value={model}
          onChangeText={setModel}
          placeholder={showConfig ? '型号编号等，如 MRX33CH/A，可不填' : home ? '如 KD-65X85L，可不填' : '如 U2723QE，可不填'}
        />
        {showConfig ? (
          <View style={formStyles.config}>
            <Field label="芯片" value={chip} onChangeText={setChip} placeholder="如 M3 Pro、i7-1260P" />
            {isMacName(name) ? (
              <>
                <ChoiceChips
                  options={MAC_CHIP_GENERATIONS.map((value) => ({ value, label: value }))}
                  value={chipParts.generation}
                  onChange={(generation) => setChip(composeChip(generation, chipParts.tier))}
                />
                {chipParts.generation ? (
                  <ChoiceChips
                    options={MAC_CHIP_TIERS.map((value) => ({ value, label: value || '标准' }))}
                    value={chipParts.tier}
                    onChange={(tier) => setChip(composeChip(chipParts.generation, tier))}
                  />
                ) : null}
              </>
            ) : null}
            <Field label="内存" value={memory} onChangeText={setMemory} placeholder="如 16G" />
            <ChoiceChips
              options={MEMORY_OPTIONS.map((value) => ({ value, label: value }))}
              value={normalizeCapacity(memory)}
              onChange={setMemory}
            />
            <Field label="硬盘" value={storage} onChangeText={setStorage} placeholder="如 512G" />
            <ChoiceChips
              options={STORAGE_OPTIONS.map((value) => ({ value, label: value }))}
              value={normalizeCapacity(storage)}
              onChange={setStorage}
            />
          </View>
        ) : null}
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
              onPress={() => router.push({ pathname: '/scan', params: { target: SCAN_TARGET, mode: 'device' } })}
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
          hint={minQuantity > 1 ? (home ? `目前有 ${minQuantity} 件在用，数量不能比这个少` : `目前借出 ${minQuantity} 件，数量不能比这个少`) : undefined}
          error={shown(errors.quantity)}
        />
      </Card>

      <SectionTitle title="购买与保修" />
      <Card style={formStyles.card}>
        <DateField
          label="购买日期"
          value={purchaseDate}
          onChange={setPurchaseDate}
          clearable
          placeholder="可不填"
        />
        <Field
          label="发票号"
          value={invoiceNo}
          onChangeText={setInvoiceNo}
          placeholder="可不填"
          autoCapitalize="characters"
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
          {home
            ? '随这件设备一起的东西，比如遥控器、充电器。数量按每件设备配几个填。'
            : '随这件设备一起领走、一起退还的东西，比如充电器、扩展坞。数量按每件设备配几个填。单独借的备用鼠标、键盘，建议另外登记成设备。'}
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
        <ChoiceChips
          options={[
            ...(home ? HOME_ACCESSORY_SUGGESTIONS : ACCESSORY_SUGGESTIONS)
              .filter((value) => !accessories.some((row) => row.name.trim() === value))
              .slice(0, 5)
              .map((value) => ({ value, label: `+ ${value}` })),
            { value: '', label: '+ 其他' },
          ]}
          value={null}
          onChange={addAccessory}
        />
      </Card>

      <Card>
        <Field
          label="备注"
          value={note}
          onChangeText={setNote}
          placeholder="存放位置等"
          multiline
          style={formStyles.noteInput}
        />
      </Card>
      {submitError ? <Text style={formStyles.error}>{submitError}</Text> : null}
      <Button title={submitLabel} onPress={() => submit(onSubmit)} loading={busy} />
      {onSubmitAndNext ? (
        <Button
          title="保存并扫下一台"
          icon="barcode-outline"
          variant="secondary"
          onPress={() => submit(onSubmitAndNext)}
          disabled={busy}
        />
      ) : null}
      {onSubmitAndNext ? (
        <Text style={[formStyles.hint, formStyles.centered]}>
          同款批量登记：下一台沿用这台的名称、配置、配件、购买日期、发票号和保修，只换序列号。
        </Text>
      ) : null}
    </Screen>
  );
}

// 照鸿蒙版 DeviceFormPage.ets：快速选择、配件建议是浅灰小胶囊；表单卡片里各栏隔 16；
// 电脑配置是卡片里一块浅灰底小圆角；配件一行是名称框、数量框、删除按钮，不再套灰底；备注也放进卡片
const useFormStyles = makeStyles((colors) => ({
  group: { gap: 8 },
  card: { gap: 16 },
  config: { gap: 8, padding: 12, borderRadius: radius.md, backgroundColor: colors.bg },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  centered: { textAlign: 'center' },
  error: { fontSize: font.small, color: colors.danger },
  computed: { fontSize: font.small, color: colors.accent, fontWeight: '500' },
  computedDate: { fontWeight: '600' },
  accessoryRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accessoryName: { flex: 1, minWidth: 0 },
  accessoryQty: { width: 140 },
  noteInput: { minHeight: 80, textAlignVertical: 'top' },
}));
