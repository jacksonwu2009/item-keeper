import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { DEVICE_CATEGORIES, type DeviceInput } from '../db/devices';
import { takeScanResult } from '../lib/scanHandoff';
import { colors, font } from '../theme';
import { IntegerField } from './NumberField';
import { Button, Card, ChoiceChips, Field, IconButton, Label, Screen } from './ui';

const SCAN_TARGET = 'device-form-serial';

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
  const [category, setCategory] = useState(initial?.category ?? '笔记本');
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [serialNo, setSerialNo] = useState(initial?.serialNo ?? '');
  const [quantity, setQuantity] = useState(initial?.quantity ?? 1);
  const [note, setNote] = useState(initial?.note ?? '');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const code = takeScanResult(SCAN_TARGET);
      if (code) setSerialNo(code);
    }, []),
  );

  const nameError = name.trim() ? null : '请填写名称';
  const categories = Array.from(new Set([...DEVICE_CATEGORIES, category])).map((value) => ({ value, label: value }));

  async function submit() {
    setShowErrors(true);
    setSubmitError(null);
    if (nameError) return;
    setBusy(true);
    try {
      await onSubmit({ category, name, model, serialNo, quantity, note });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card>
        <View style={{ gap: 8 }}>
          <Label>类别</Label>
          <ChoiceChips options={categories} value={category} onChange={setCategory} />
        </View>
        <Field
          label="名称"
          required
          value={name}
          onChangeText={setName}
          placeholder="如 MacBook Pro 14"
          error={showErrors ? nameError : null}
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
        />
        <Field label="备注" value={note} onChangeText={setNote} placeholder="购买日期、保修期、配件等" multiline />
      </Card>
      {submitError ? <Text style={{ fontSize: font.small, color: colors.danger }}>{submitError}</Text> : null}
      <Button title={submitLabel} onPress={submit} loading={busy} />
    </Screen>
  );
}
