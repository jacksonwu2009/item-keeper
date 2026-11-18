import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, radius } from '../theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export type Tone = 'danger' | 'warn' | 'ok' | 'info' | 'neutral' | 'accent';

const TONES: Record<Tone, { bg: string; fg: string }> = {
  danger: { bg: colors.dangerSoft, fg: colors.danger },
  warn: { bg: colors.warnSoft, fg: colors.warn },
  ok: { bg: colors.okSoft, fg: colors.ok },
  info: { bg: colors.infoSoft, fg: colors.info },
  neutral: { bg: colors.surfaceSunken, fg: colors.muted },
  accent: { bg: colors.accentSoft, fg: colors.accent },
};

export function Screen({ children, contentStyle }: { children: ReactNode; contentStyle?: StyleProp<ViewStyle> }) {
  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.screenContent, contentStyle]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  style,
  compact,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const palette = {
    primary: { bg: colors.accent, fg: colors.accentInk },
    secondary: { bg: colors.accentSoft, fg: colors.accent },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    ghost: { bg: 'transparent', fg: colors.accent },
  }[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive }}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: palette.bg, opacity: inactive ? 0.5 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} size="small" />
      ) : icon ? (
        <Ionicons name={icon} size={compact ? 16 : 18} color={palette.fg} />
      ) : null}
      <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: palette.fg }]}>{title}</Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  color = colors.accent,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  color?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Ionicons name={icon} size={22} color={color} />
    </Pressable>
  );
}

export function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <Text style={styles.label}>
      {children}
      {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
    </Text>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  right,
  ...inputProps
}: TextInputProps & { label?: string; required?: boolean; hint?: string; error?: string | null; right?: ReactNode }) {
  return (
    <View style={styles.field}>
      {label ? <Label required={required}>{label}</Label> : null}
      <View style={styles.inputRow}>
        <TextInput
          placeholderTextColor={colors.faint}
          {...inputProps}
          style={[styles.input, error ? styles.inputError : null, inputProps.style]}
        />
        {right}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Chip({ text, tone = 'neutral', icon }: { text: string; tone?: Tone; icon?: IconName }) {
  const palette = TONES[tone];
  return (
    <View style={[styles.chip, { backgroundColor: palette.bg }]}>
      {icon ? <Ionicons name={icon} size={12} color={palette.fg} /> : null}
      <Text style={[styles.chipText, { color: palette.fg }]}>{text}</Text>
    </View>
  );
}

export function ChoiceChips<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choiceWrap}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.choice, selected && styles.choiceSelected]}
          >
            <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 可多选的标签，选中的带勾。 */
export function MultiChips<T extends string>({
  options,
  values,
  onChange,
}: {
  options: { value: T; label: string; disabled?: boolean }[];
  values: T[];
  onChange: (values: T[]) => void;
}) {
  return (
    <View style={styles.choiceWrap}>
      {options.map((option) => {
        const selected = values.includes(option.value);
        return (
          <Pressable
            key={option.value}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected, disabled: !!option.disabled }}
            disabled={option.disabled}
            onPress={() =>
              onChange(selected ? values.filter((value) => value !== option.value) : [...values, option.value])
            }
            style={[styles.choice, styles.multiChoice, selected && styles.choiceSelected, option.disabled && styles.choiceDisabled]}
          >
            <Ionicons
              name={selected ? 'checkbox' : 'square-outline'}
              size={16}
              color={selected ? colors.accentInk : colors.faint}
            />
            <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && styles.segmentSelected]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = 999,
  suffix,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable
        accessibilityLabel="减少"
        onPress={() => onChange(Math.max(min, value - 1))}
        style={styles.stepperButton}
        hitSlop={6}
      >
        <Ionicons name="remove" size={18} color={value <= min ? colors.faint : colors.accent} />
      </Pressable>
      <Text style={styles.stepperValue}>
        {value}
        {suffix ? <Text style={styles.stepperSuffix}> {suffix}</Text> : null}
      </Text>
      <Pressable
        accessibilityLabel="增加"
        onPress={() => onChange(Math.min(max, value + 1))}
        style={styles.stepperButton}
        hitSlop={6}
      >
        <Ionicons name="add" size={18} color={value >= max ? colors.faint : colors.accent} />
      </Pressable>
    </View>
  );
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {right}
    </View>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text style={styles.infoValue} selectable>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

export function SwitchRow({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.flexShrink}>
        <Text style={styles.switchTitle}>{title}</Text>
        {description ? <Text style={styles.hint}>{description}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors.line }}
        thumbColor={colors.surface}
      />
    </View>
  );
}

export function Empty({ icon, title, text, children }: { icon: IconName; title: string; text?: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={28} color={colors.accent} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {text ? <Text style={styles.emptyText}>{text}</Text> : null}
      {children ? <View style={styles.emptyActions}>{children}</View> : null}
    </View>
  );
}

/** 底部弹出的面板，用来做入库、出库、领用、退还这些小表单。 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="关闭" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <IconButton icon="close" label="关闭" onPress={onClose} color={colors.muted} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1, flexGrow: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  screenContent: { padding: 16, gap: 14, paddingBottom: 40 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 14,
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  button: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  buttonCompact: { minHeight: 34, paddingHorizontal: 12, borderRadius: radius.sm },
  buttonText: { fontSize: font.body, fontWeight: '600' },
  buttonTextCompact: { fontSize: font.small },
  iconButton: { padding: 6 },
  label: { fontSize: font.small, color: colors.muted, fontWeight: '600', letterSpacing: 0.3 },
  field: { gap: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: font.body,
    color: colors.ink,
  },
  inputError: { borderColor: colors.danger },
  error: { fontSize: font.small, color: colors.danger },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: font.tiny + 1, fontWeight: '600' },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  choiceSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  multiChoice: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  choiceDisabled: { opacity: 0.4 },
  choiceText: { fontSize: font.small, color: colors.ink },
  choiceTextSelected: { color: colors.accentInk, fontWeight: '600' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.sm + 2,
    padding: 3,
    gap: 3,
  },
  segment: { flex: 1, paddingVertical: 8, borderRadius: radius.sm, alignItems: 'center' },
  segmentSelected: { backgroundColor: colors.surface },
  segmentText: { fontSize: font.small, color: colors.muted, fontWeight: '500' },
  segmentTextSelected: { color: colors.ink, fontWeight: '700' },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  stepperButton: { paddingHorizontal: 14, paddingVertical: 10 },
  stepperValue: {
    minWidth: 56,
    textAlign: 'center',
    fontSize: font.heading,
    fontWeight: '700',
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  stepperSuffix: { fontSize: font.small, fontWeight: '400', color: colors.muted },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  sectionTitle: { fontSize: font.small, fontWeight: '700', color: colors.muted, letterSpacing: 0.6 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  infoLabel: { fontSize: font.small, color: colors.muted },
  infoValue: { fontSize: font.body, color: colors.ink, flexShrink: 1, textAlign: 'right' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchTitle: { fontSize: font.body, color: colors.ink, fontWeight: '500' },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24, gap: 8 },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: { fontSize: font.heading, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptyText: { fontSize: font.small, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  emptyActions: { flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(16, 24, 20, 0.35)' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '88%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  sheetTitle: { fontSize: font.heading, fontWeight: '700', color: colors.ink },
  sheetBody: { padding: 16, gap: 14 },
});
