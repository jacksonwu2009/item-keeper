import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { expiryFromShelfLife, formatDate, todayStr, type ShelfLifeUnit } from '../lib/dates';
import { colors, font } from '../theme';
import { DateField } from './DateField';
import { NumberField } from './NumberField';
import { ChoiceChips, Segmented } from './ui';

export type ExpiryMode = 'date' | 'shelf' | 'none';

export type ExpiryValue = { expiry: string | null; error: string | null };

/**
 * 过期日期的三种填法：直接选到期日 / 按包装上的「生产日期 + 保质期」算 / 不记录。
 * 计算结果通过 onChange 往上报。
 */
export function ExpiryInput({
  initialMode,
  initialExpiry = null,
  allowNone,
  onChange,
}: {
  initialMode: ExpiryMode;
  initialExpiry?: string | null;
  allowNone: boolean;
  onChange: (value: ExpiryValue) => void;
}) {
  const [mode, setMode] = useState<ExpiryMode>(initialMode);
  const [expiry, setExpiry] = useState<string | null>(initialExpiry);
  const [productionDate, setProductionDate] = useState<string | null>(todayStr());
  const [shelfAmount, setShelfAmount] = useState('12');
  const [shelfUnit, setShelfUnit] = useState<ShelfLifeUnit>('month');

  let result: ExpiryValue;
  if (mode === 'none') {
    result = { expiry: null, error: null };
  } else if (mode === 'date') {
    result = expiry ? { expiry, error: null } : { expiry: null, error: '请选择过期日期' };
  } else {
    const amount = Number(shelfAmount);
    if (!productionDate) result = { expiry: null, error: '请选择生产日期' };
    else if (!Number.isInteger(amount) || amount <= 0) result = { expiry: null, error: '保质期请填正整数' };
    else result = { expiry: expiryFromShelfLife(productionDate, amount, shelfUnit), error: null };
  }

  useEffect(() => {
    onChange(result);
    // 只在算出来的结果变化时上报
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.expiry, result.error]);

  const modeOptions: { value: ExpiryMode; label: string }[] = [
    { value: 'date', label: '选到期日' },
    { value: 'shelf', label: '生产日期+保质期' },
  ];
  if (allowNone) modeOptions.push({ value: 'none', label: '不记录' });

  return (
    <View style={expiryStyles.wrap}>
      <Segmented options={modeOptions} value={mode} onChange={setMode} />
      {mode === 'date' ? <DateField label="过期日期" value={expiry} onChange={setExpiry} required /> : null}
      {mode === 'shelf' ? (
        <View style={expiryStyles.wrap}>
          <DateField label="生产日期" value={productionDate} onChange={setProductionDate} required />
          <NumberField
            label="保质期"
            required
            value={shelfAmount}
            onChangeText={setShelfAmount}
            min={1}
            max={9999}
          />
          <ChoiceChips
            options={[
              { value: 'day', label: '天' },
              { value: 'month', label: '个月' },
              { value: 'year', label: '年' },
            ]}
            value={shelfUnit}
            onChange={setShelfUnit}
          />
          {result.expiry ? (
            <Text style={expiryStyles.computed}>
              到期日：<Text style={expiryStyles.computedDate}>{formatDate(result.expiry)}</Text>
            </Text>
          ) : null}
        </View>
      ) : null}
      {mode === 'none' ? <Text style={expiryStyles.note}>不记过期日期，只按库存数量提醒。</Text> : null}
    </View>
  );
}

// 照鸿蒙版 StockInputs.ets 的 ExpiryInput：分段选填法，下面的日期、保质期上下排，间隔 12
const expiryStyles = StyleSheet.create({
  wrap: { gap: 12 },
  computed: { fontSize: font.small, color: colors.muted },
  computedDate: { color: colors.accent, fontWeight: '700' },
  note: { fontSize: font.small, color: colors.faint },
});
