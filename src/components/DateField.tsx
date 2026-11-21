import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { dateStrToLocalDate, formatDate, formatTime, toDateStr, todayStr } from '../lib/dates';
import { colors, font, radius } from '../theme';
import { Button, Label } from './ui';

type PickerMode = 'date' | 'time';

/** iOS 底部弹出滚轮；Android 用系统日期对话框。 */
function usePicker() {
  const [iosState, setIosState] = useState<{
    mode: PickerMode;
    value: Date;
    minimumDate?: Date;
    onConfirm: (date: Date) => void;
  } | null>(null);

  function open(mode: PickerMode, value: Date, onConfirm: (date: Date) => void, minimumDate?: Date) {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode,
        value,
        minimumDate,
        is24Hour: true,
        onValueChange: (_event, date) => onConfirm(date),
      });
      return;
    }
    setIosState({ mode, value, minimumDate, onConfirm });
  }

  return { iosState, setIosState, open };
}

function IosPickerSheet({
  state,
  onChange,
  onClose,
}: {
  state: { mode: PickerMode; value: Date; minimumDate?: Date; onConfirm: (date: Date) => void } | null;
  onChange: (date: Date) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  if (!state) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={pickerStyles.backdrop} onPress={onClose} accessibilityLabel="取消" />
      <View style={[pickerStyles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <DateTimePicker
          value={state.value}
          mode={state.mode}
          display={state.mode === 'date' ? 'inline' : 'spinner'}
          locale="zh-CN"
          minimumDate={state.minimumDate}
          minuteInterval={state.mode === 'time' ? 5 : undefined}
          accentColor={colors.accent}
          themeVariant="light"
          onValueChange={(_event, date) => onChange(date)}
        />
        <Button
          title="确定"
          onPress={() => {
            state.onConfirm(state.value);
            onClose();
          }}
        />
      </View>
    </Modal>
  );
}

export function DateField({
  label,
  value,
  onChange,
  required,
  clearable,
  placeholder = '选择日期',
  minimumDate,
  hint,
}: {
  label?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  required?: boolean;
  clearable?: boolean;
  placeholder?: string;
  minimumDate?: string | null;
  hint?: string;
}) {
  const picker = usePicker();
  const current = value ? dateStrToLocalDate(value) : dateStrToLocalDate(todayStr());
  const min = minimumDate ? dateStrToLocalDate(minimumDate) : undefined;

  return (
    <View style={pickerStyles.field}>
      {label ? <Label required={required}>{label}</Label> : null}
      <View style={pickerStyles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label ? `${label}：${value ? formatDate(value) : '未设置'}` : undefined}
          style={pickerStyles.box}
          onPress={() => picker.open('date', current, (date) => onChange(toDateStr(date)), min)}
        >
          <Ionicons name="calendar-outline" size={18} color={colors.accent} />
          <Text style={[pickerStyles.boxText, !value && pickerStyles.placeholder]}>
            {value ? formatDate(value) : placeholder}
          </Text>
        </Pressable>
        {clearable && value ? <Button title="清除" variant="ghost" compact onPress={() => onChange(null)} /> : null}
      </View>
      {hint ? <Text style={pickerStyles.hint}>{hint}</Text> : null}
      <IosPickerSheet
        state={picker.iosState}
        onChange={(date) => picker.setIosState((state) => (state ? { ...state, value: date } : state))}
        onClose={() => picker.setIosState(null)}
      />
    </View>
  );
}

export function TimeField({
  label,
  hour,
  minute,
  onChange,
}: {
  label?: string;
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
}) {
  const picker = usePicker();
  const current = new Date();
  current.setHours(hour, minute, 0, 0);
  return (
    <View style={pickerStyles.field}>
      {label ? <Label>{label}</Label> : null}
      <Pressable
        accessibilityRole="button"
        style={[pickerStyles.box, pickerStyles.timeBox]}
        onPress={() => picker.open('time', current, (date) => onChange(date.getHours(), date.getMinutes()))}
      >
        <Ionicons name="time-outline" size={18} color={colors.accent} />
        <Text style={pickerStyles.boxText}>{formatTime(hour, minute)}</Text>
      </Pressable>
      <IosPickerSheet
        state={picker.iosState}
        onChange={(date) => picker.setIosState((state) => (state ? { ...state, value: date } : state))}
        onClose={() => picker.setIosState(null)}
      />
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  field: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // 和输入框一样浅灰底不描边
  box: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.surfaceSunken,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSunken,
    paddingHorizontal: 12,
  },
  timeBox: { flex: 0, alignSelf: 'flex-start', paddingRight: 18 },
  boxText: { fontSize: font.body, color: colors.ink, fontVariant: ['tabular-nums'] },
  placeholder: { color: colors.faint },
  hint: { fontSize: font.small, color: colors.faint },
  backdrop: { flex: 1, backgroundColor: 'rgba(16, 24, 20, 0.35)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: 16,
    gap: 12,
  },
});
