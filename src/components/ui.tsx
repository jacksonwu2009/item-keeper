import { Ionicons } from '@expo/vector-icons';
import { Children, isValidElement, useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, CONTENT_MAX_WIDTH, font, radius } from '../theme';
import { SwitchTrack } from './HarmonySwitch';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export type Tone = 'danger' | 'warn' | 'ok' | 'info' | 'neutral' | 'accent';

/** 状态色：每种一深一浅，深色写字、浅色做底（和鸿蒙版 Tones.ets 一一对应） */
export const TONES: Record<Tone, { bg: string; fg: string }> = {
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

/**
 * 列表里可点的行：按下后等这么久才显示按下的底色。手指一开始就滑动（左滑删除、上下滚动、切标签）时
 * 按下会被取消，底色不会闪一下；直接点的话松手时照常触发。
 */
export const LIST_PRESS_DELAY = 130;

/** 白底圆角卡片，四周留边距；里面的东西上下排，间隔 12 */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * 分组卡片（设置项、详情页「信息」这种一行一行的）：白底圆角，每个子元素是一行，自己留边距，
 * 行与行之间画一条分隔线（左边留空、右边到头，和鸿蒙版的列表一样）。null、false 不算一行。
 */
export function GroupCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const rows = Children.toArray(children);
  return (
    <View style={[styles.groupCard, style]}>
      {rows.map((row, index) => (
        <View key={isValidElement(row) && row.key !== null ? row.key : index}>
          {index > 0 ? <View style={styles.groupDivider} /> : null}
          <View style={styles.groupRow}>{row}</View>
        </View>
      ))}
    </View>
  );
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

/** 搜索框：胶囊形浅灰底，左边一个放大镜；属性和 TextInput 一样。获得焦点时描一圈主色。 */
export function SearchField({ style, onFocus, onBlur, ...inputProps }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.search, focused && styles.searchFocused]}>
      <Ionicons name="search" size={18} color={colors.faint} />
      <TextInput
        placeholderTextColor={colors.faint}
        {...inputProps}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[styles.searchInput, style]}
      />
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

/** 可多选的标签：选中的浅主色底、主色描边、带勾；没选中的浅灰底。 */
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
            style={[styles.choice, styles.multiChoice, selected && styles.multiChoiceSelected, option.disabled && styles.choiceDisabled]}
          >
            {selected ? <Ionicons name="checkmark" size={15} color={colors.accent} /> : null}
            <Text style={[styles.choiceText, selected && styles.multiChoiceTextSelected]}>{option.label}</Text>
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
  // 整行都能点（和鸿蒙版一样）；开关用自己画的鸿蒙样式，安卓、iOS、网页一样
  return (
    <Pressable
      style={styles.switchRow}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={title}
      onPress={() => onChange(!value)}
    >
      <View style={styles.flexShrink}>
        <Text style={styles.switchTitle}>{title}</Text>
        {description ? <Text style={styles.switchDescription}>{description}</Text> : null}
      </View>
      <SwitchTrack value={value} />
    </Pressable>
  );
}

export function Empty({ icon, title, text, children }: { icon: IconName; title: string; text?: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={48} color={colors.faint} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {text ? <Text style={styles.emptyText}>{text}</Text> : null}
      {children ? <View style={styles.emptyActions}>{children}</View> : null}
    </View>
  );
}

/**
 * 底部弹出的面板，用来做入库、出库、领用、退还这些小表单。
 * 样子照鸿蒙版的半屏面板：浅灰底、顶上两个大圆角，左边大标题、右边圆形关闭按钮；平板、电脑上最宽 720 居中。
 */
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
      <KeyboardAvoidingView style={[styles.flex, styles.sheetOverlay]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* 铺满整个底层：宽屏上面板两边空出来的地方点了也关掉，和点面板上面一样 */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="关闭" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              onPress={onClose}
              hitSlop={4}
              style={({ pressed }) => [styles.sheetClose, pressed && styles.sheetClosePressed]}
            >
              <Ionicons name="close" size={22} color={colors.ink} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// 尺寸、留白照鸿蒙版 Theme.ets：页面左右 16，卡片内边距 16，分组之间 24，同组元素之间 8～12
export const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1, flexGrow: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  screenContent: { padding: 16, gap: 16, paddingBottom: 40 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    gap: 12,
  },
  groupCard: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  groupRow: { minHeight: 48, justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 16, gap: 8 },
  groupDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 16 },
  // 胶囊按钮：主要（主色底）、次要（浅主色底）、危险（浅红底）、文字（无底）
  button: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  buttonCompact: { minHeight: 36, paddingHorizontal: 16 },
  buttonText: { fontSize: font.body, fontWeight: '600' },
  buttonTextCompact: { fontSize: font.small },
  iconButton: { padding: 6 },
  label: { fontSize: font.small, color: colors.muted, fontWeight: '500' },
  field: { gap: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // 输入框：浅灰底、不描边（出错时描红边）；边框留着同色，出错时不跳动
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.surfaceSunken,
    backgroundColor: colors.surfaceSunken,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: font.body,
    color: colors.ink,
  },
  inputError: { borderColor: colors.danger },
  error: { fontSize: font.small, color: colors.danger },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.surfaceSunken,
    backgroundColor: colors.surfaceSunken,
  },
  searchFocused: { borderColor: colors.accent },
  // 网页上焦点由外面这一圈胶囊边框表示，输入框自己不再画方框
  // 网页上浏览器默认的焦点框是 outline-style: auto，只设宽度 0 去不掉，要连样式一起改
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 10, fontSize: font.body, color: colors.ink, outlineWidth: 0, outlineStyle: 'solid' },
  // 小状态标签：「已过期 2 天」「库存不足」
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: font.tiny, fontWeight: '500', lineHeight: 16 },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // 可选的小胶囊：没选中浅灰底，单选选中主色底，多选选中浅主色底加主色描边
  choice: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceSunken,
    backgroundColor: colors.surfaceSunken,
  },
  choiceSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  multiChoice: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  multiChoiceSelected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  multiChoiceTextSelected: { color: colors.accent, fontWeight: '500' },
  choiceDisabled: { opacity: 0.4 },
  choiceText: { fontSize: font.small, color: colors.ink },
  choiceTextSelected: { color: colors.accentInk, fontWeight: '600' },
  // 分段筛选：浅灰的胶囊槽，选中的一段是白色胶囊
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2,
  },
  // 左右只留 2：表单卡片里三段的「生产日期+保质期」要能放在一行
  segment: {
    flex: 1,
    minHeight: 36,
    paddingVertical: 8,
    paddingHorizontal: 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: {
    backgroundColor: colors.surface,
    shadowColor: colors.ink,
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentText: { fontSize: font.small, color: colors.muted, fontWeight: '500', textAlign: 'center' },
  segmentTextSelected: { color: colors.ink, fontWeight: '600' },
  // 分组小标题在卡片外面、贴着下面的卡片：上面多留 8，和下面的卡片只隔 8（页面里元素之间是 16）
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: 8,
    marginBottom: -8,
  },
  sectionTitle: { fontSize: font.small, fontWeight: '500', color: colors.muted },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 24 },
  infoLabel: { fontSize: font.body, color: colors.muted },
  infoValue: { fontSize: font.body, color: colors.ink, flexShrink: 1, textAlign: 'right' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 32 },
  switchTitle: { fontSize: font.body, color: colors.ink },
  switchDescription: { fontSize: font.small, color: colors.muted, lineHeight: 18, marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: 56, paddingHorizontal: 24, gap: 8 },
  emptyTitle: { fontSize: font.heading, fontWeight: '600', color: colors.ink, textAlign: 'center', marginTop: 4 },
  emptyText: { fontSize: font.small, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  emptyActions: { flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(16, 24, 20, 0.35)' },
  sheetOverlay: { backgroundColor: 'rgba(16, 24, 20, 0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    maxHeight: '88%',
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  sheetTitle: { flexShrink: 1, fontSize: font.title - 2, fontWeight: '700', color: colors.ink },
  sheetClose: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetClosePressed: { opacity: 0.6 },
  sheetBody: { padding: 16, paddingTop: 12, gap: 16 },
});
