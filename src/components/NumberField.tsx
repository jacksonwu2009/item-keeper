import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, TextInput, View, type StyleProp, type TextStyle } from 'react-native';
import { Text } from './Text';

import type { ScanTag } from '../lib/labelScan';
import { parseNumberText, sanitizeNumberText, stepNumberText } from '../lib/number';
import { makeStyles, useColors } from '../hooks/useTheme';
import { font, radius } from '../theme';
import { Label, recognizedInputStyle } from './ui';

type NumberFieldProps = {
  label?: string;
  required?: boolean;
  /** 输入框里的文字（可以是空串） */
  value: string;
  onChangeText: (text: string) => void;
  /** 允许几位小数，0 = 只能整数 */
  decimals?: number;
  min?: number;
  max?: number;
  step?: number;
  /** 输入框右边的单位，如「件」「天」 */
  suffix?: string;
  placeholder?: string;
  hint?: string | null;
  error?: string | null;
  /** 是否显示 − / + 按钮；很窄的地方可以关掉 */
  buttons?: boolean;
  autoFocus?: boolean;
  accessibilityLabel?: string;
  onBlur?: () => void;
  /** 输入框自己的样式，叠在默认样式后面（比如放在浅灰底上时改成白底）；不传就是默认的浅灰底 */
  inputStyle?: StyleProp<TextStyle>;
  /** 不能改：输入框和 − / + 都不能点 */
  disabled?: boolean;
  /** 拍照识别填的：recognized 时浅蓝底，标签后面标「识别」；missing 标「没认出来」 */
  tag?: ScanTag | null;
};

/** 数字输入框：左右是 − / + 按钮，中间可以直接输入，只接受数字（和小数点）。 */
export function NumberField({
  label,
  required,
  value,
  onChangeText,
  decimals = 0,
  min = 0,
  max = 999999,
  step = 1,
  suffix,
  placeholder,
  hint,
  error,
  buttons = true,
  autoFocus,
  accessibilityLabel,
  onBlur,
  inputStyle,
  disabled = false,
  tag,
}: NumberFieldProps) {
  const colors = useColors();
  const numberStyles = useNumberStyles();
  const current = parseNumberText(value);
  const atMin = current !== null && current <= min;
  const atMax = current !== null && current >= max;
  const options = { min, max, decimals };

  return (
    <View style={numberStyles.field}>
      {label ? (
        <Label required={required} tag={tag}>
          {label}
        </Label>
      ) : null}
      <View style={numberStyles.row}>
        {buttons ? (
          <StepButton
            icon="remove"
            label={`减少${label ?? ''}`}
            disabled={disabled || atMin || current === null}
            onPress={() => onChangeText(stepNumberText(value, -step, options))}
          />
        ) : null}
        <TextInput
          value={value}
          onChangeText={(text) => onChangeText(sanitizeNumberText(text, decimals))}
          editable={!disabled}
          keyboardType={decimals > 0 ? 'decimal-pad' : 'number-pad'}
          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          autoFocus={autoFocus}
          accessibilityLabel={accessibilityLabel ?? label}
          selectTextOnFocus
          onBlur={onBlur}
          style={[
            numberStyles.input,
            buttons && numberStyles.inputCentered,
            tag === 'recognized' ? recognizedInputStyle(colors) : null,
            inputStyle,
            error ? numberStyles.inputError : null,
          ]}
        />
        {buttons ? (
          <StepButton
            icon="add"
            label={`增加${label ?? ''}`}
            disabled={disabled || atMax}
            onPress={() => onChangeText(stepNumberText(value, step, options))}
          />
        ) : null}
        {suffix ? <Text style={numberStyles.suffix}>{suffix}</Text> : null}
      </View>
      {error ? (
        <Text style={numberStyles.error}>{error}</Text>
      ) : hint ? (
        <Text style={numberStyles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

function StepButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: 'add' | 'remove';
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const numberStyles = useNumberStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        numberStyles.stepButton,
        pressed && numberStyles.stepPressed,
        disabled && numberStyles.stepDisabled,
      ]}
    >
      <Ionicons name={icon} size={20} color={disabled ? colors.faint : colors.accent} />
    </Pressable>
  );
}

/**
 * 整数版，值是 number | null：输入合法（在范围内）时回调这个数；清空或超出范围时回调 null，
 * 由外层显示错误、不让保存，避免悄悄用上一个值。外层把值改成别的数时，输入框跟着变。
 */
export function IntegerField({
  value,
  onChange,
  min = 0,
  max = 999999,
  error,
  ...rest
}: Omit<NumberFieldProps, 'value' | 'onChangeText' | 'decimals' | 'min' | 'max'> & {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [lastValue, setLastValue] = useState(value);
  // 外部改了值（比如重置）时同步输入框；外部变成 null 是我们自己报的，不动输入框
  if (value !== lastValue) {
    setLastValue(value);
    if (value !== null && parseNumberText(text) !== value) setText(String(value));
  }
  const parsed = parseNumberText(text);
  const outOfRange = parsed !== null && (parsed < min || parsed > max);

  return (
    <NumberField
      {...rest}
      value={text}
      decimals={0}
      min={min}
      max={max}
      error={outOfRange ? `请填 ${min} 到 ${max} 之间的数` : error}
      onChangeText={(next) => {
        setText(next);
        const number = parseNumberText(next);
        onChange(number !== null && number >= min && number <= max ? number : null);
      }}
    />
  );
}

// 照鸿蒙版 FormFields.ets 的 NumberField：输入框浅灰底不描边（出错描红边），两边是浅灰底的圆形 − / + 按钮
const useNumberStyles = makeStyles((colors) => ({
  field: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.surfaceSunken,
    backgroundColor: colors.surfaceSunken,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: font.heading,
    fontWeight: '500',
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  inputCentered: { textAlign: 'center' },
  inputError: { borderColor: colors.danger },
  stepButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepPressed: { backgroundColor: colors.accentSoft },
  stepDisabled: { opacity: 0.5 },
  suffix: { fontSize: font.body, color: colors.muted, marginLeft: 2 },
  error: { fontSize: font.small, color: colors.danger },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
}));
