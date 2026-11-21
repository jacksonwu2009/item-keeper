import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { dateStrToLocalDate, formatDate, formatTime, toDateStr, todayStr } from '../lib/dates';
import { colors, font, radius } from '../theme';
import { Button, Label } from './ui';
import { DateWheelSheet, TimeWheelSheet } from './WheelPicker';

type PickerMode = 'date' | 'time';

/**
 * 手机上的日期、时间选择：
 * - 安卓：我们自己画的底部滚轮面板（WheelPicker.tsx），日期是年、月、日三列，时间是时、分两列；
 * - iOS：底部面板里放系统滚轮（日期、时间都是 spinner），点「确定」写回。
 */
const USE_WHEEL_SHEET = Platform.OS === 'android';

/** iOS 底部弹出的系统滚轮：拨动时只改面板里的值，点「确定」才交给 onConfirm */
function IosPickerSheet({
  mode,
  initialValue,
  minimumDate,
  onConfirm,
  onClose,
}: {
  mode: PickerMode;
  initialValue: Date;
  minimumDate?: Date;
  onConfirm: (date: Date) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(initialValue);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={pickerStyles.backdrop} onPress={onClose} accessibilityLabel="取消" />
      <View style={[pickerStyles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <DateTimePicker
          value={draft}
          mode={mode}
          display="spinner"
          locale="zh-CN"
          minimumDate={minimumDate}
          minuteInterval={mode === 'time' ? 5 : undefined}
          accentColor={colors.accent}
          themeVariant="light"
          onValueChange={(_event, date) => setDraft(date)}
        />
        <Button
          title="确定"
          onPress={() => {
            onConfirm(draft);
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
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <View style={pickerStyles.field}>
      {label ? <Label required={required}>{label}</Label> : null}
      <View style={pickerStyles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label ? `${label}：${value ? formatDate(value) : '未设置'}` : undefined}
          style={pickerStyles.box}
          onPress={() => setPickerOpen(true)}
        >
          <Ionicons name="calendar-outline" size={18} color={colors.accent} />
          <Text style={[pickerStyles.boxText, !value && pickerStyles.placeholder]}>
            {value ? formatDate(value) : placeholder}
          </Text>
        </Pressable>
        {clearable && value ? <Button title="清除" variant="ghost" compact onPress={() => onChange(null)} /> : null}
      </View>
      {hint ? <Text style={pickerStyles.hint}>{hint}</Text> : null}
      {pickerOpen && USE_WHEEL_SHEET ? (
        <DateWheelSheet
          title={label ?? '选择日期'}
          value={value}
          minimumDate={minimumDate ?? null}
          clearable={!!clearable}
          onConfirm={(next) => {
            setPickerOpen(false);
            onChange(next);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {pickerOpen && !USE_WHEEL_SHEET ? (
        <IosPickerSheet
          mode="date"
          initialValue={dateStrToLocalDate(value ?? todayStr())}
          minimumDate={minimumDate ? dateStrToLocalDate(minimumDate) : undefined}
          onConfirm={(date) => onChange(toDateStr(date))}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = new Date();
  current.setHours(hour, minute, 0, 0);
  return (
    <View style={pickerStyles.field}>
      {label ? <Label>{label}</Label> : null}
      <Pressable
        accessibilityRole="button"
        style={[pickerStyles.box, pickerStyles.timeBox]}
        onPress={() => setPickerOpen(true)}
      >
        <Ionicons name="time-outline" size={18} color={colors.accent} />
        <Text style={pickerStyles.boxText}>{formatTime(hour, minute)}</Text>
      </Pressable>
      {pickerOpen && USE_WHEEL_SHEET ? (
        <TimeWheelSheet
          title={label ?? '选择时间'}
          hour={hour}
          minute={minute}
          onConfirm={(nextHour, nextMinute) => {
            setPickerOpen(false);
            onChange(nextHour, nextMinute);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {pickerOpen && !USE_WHEEL_SHEET ? (
        <IosPickerSheet
          mode="time"
          initialValue={current}
          onConfirm={(date) => onChange(date.getHours(), date.getMinutes())}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * 直接弹出的时间选择（没有输入框）：设置页「提醒时间」点一行就弹滚轮，不用先开一层面板再点时间框。
 * 安卓是我们的时、分滚轮面板，iOS 是系统滚轮（在我们的底部面板里）。点「确定」写回并关掉，点关闭或面板外面不改。
 */
export function TimePickerSheet({
  title,
  hour,
  minute,
  onChange,
  onClose,
}: {
  title: string;
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  onClose: () => void;
}) {
  if (USE_WHEEL_SHEET) {
    return (
      <TimeWheelSheet
        title={title}
        hour={hour}
        minute={minute}
        onConfirm={(nextHour, nextMinute) => {
          onChange(nextHour, nextMinute);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }
  const current = new Date();
  current.setHours(hour, minute, 0, 0);
  return <IosPickerSheet mode="time" initialValue={current} onConfirm={(date) => onChange(date.getHours(), date.getMinutes())} onClose={onClose} />;
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
