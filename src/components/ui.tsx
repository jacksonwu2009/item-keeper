import { Ionicons } from '@expo/vector-icons';
import { Children, isValidElement, useState, type ComponentProps, type ComponentRef, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ScanTag } from '../lib/labelScan';
import { makeStyles, useColors } from '../hooks/useTheme';
import { CONTENT_MAX_WIDTH, font, radius, type Colors } from '../theme';
import { SwitchTrack } from './HarmonySwitch';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export type Tone = 'danger' | 'warn' | 'ok' | 'info' | 'neutral' | 'accent';

/** 状态色：每种一深一浅，深色写字、浅色做底（和鸿蒙版 Tones.ets 一一对应） */
export function toneColors(colors: Colors, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case 'danger':
      return { bg: colors.dangerSoft, fg: colors.danger };
    case 'warn':
      return { bg: colors.warnSoft, fg: colors.warn };
    case 'ok':
      return { bg: colors.okSoft, fg: colors.ok };
    case 'info':
      return { bg: colors.infoSoft, fg: colors.info };
    case 'neutral':
      return { bg: colors.surfaceSunken, fg: colors.muted };
    case 'accent':
      return { bg: colors.accentSoft, fg: colors.accent };
  }
}

/**
 * iOS 上标签页的标题是系统导航栏的大标题（见 TabStack）：页面最外层的滚动视图要让系统按标题栏的高度自动留出上边距，
 * 大标题才会跟着内容滑走、收成顶部的小标题。只在 iOS 上设；安卓、网页保持默认。
 */
export const LARGE_TITLE_SCROLL_INSET = Platform.OS === 'ios' ? ('automatic' as const) : undefined;

export function Screen({
  children,
  contentStyle,
  largeTitle,
  scrollRef,
}: {
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  /** 这一页顶上是 iOS 系统大标题（标签页）：滚动视图配合大标题收缩，见 LARGE_TITLE_SCROLL_INSET */
  largeTitle?: boolean;
  /** 要在页面里滚到某个位置时传（比如提醒页点数字块滚到对应的一组） */
  scrollRef?: Ref<ComponentRef<typeof ScrollView>>;
}) {
  const styles = useStyles();
  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={scrollRef}
        style={styles.screen}
        contentContainerStyle={[styles.screenContent, contentStyle]}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior={largeTitle ? LARGE_TITLE_SCROLL_INSET : undefined}
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
  const styles = useStyles();
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * 分组卡片（设置项、详情页「信息」这种一行一行的）：白底圆角，每个子元素是一行，自己留边距，
 * 行与行之间画一条分隔线（左边留空、右边到头，和鸿蒙版的列表一样）。null、false 不算一行。
 */
export function GroupCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
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
  const colors = useColors();
  const styles = useStyles();
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

/**
 * 列表页最上面的两个按钮：左边扫码（实心主色）、右边手动添加（浅主色），一样宽、一样高。
 * 食品、日用品、设备三个列表页都用它，文字按各自的意思传（扫码入库 / 扫码录入）。
 */
export function ListActions({ scanTitle, onScan, onAdd }: { scanTitle: string; onScan: () => void; onAdd: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.listActions}>
      <Button title={scanTitle} icon="barcode-outline" onPress={onScan} style={styles.listAction} />
      <Button title="手动添加" icon="add" variant="secondary" onPress={onAdd} style={styles.listAction} />
    </View>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  color,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  /** 不给就是主色 */
  color?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Ionicons name={icon} size={22} color={color ?? colors.accent} />
    </Pressable>
  );
}

const SCAN_TAG_CHIP: Record<ScanTag, { text: string; tone: Tone }> = {
  recognized: { text: '识别', tone: 'info' },
  missing: { text: '没认出来', tone: 'warn' },
  last: { text: '按上次', tone: 'neutral' },
  saved: { text: '按资料', tone: 'neutral' },
};

/** 自动填的格子：标签后面的小字「识别」（蓝）、「没认出来」（黄）、「按上次」「按资料」（灰） */
export function ScanTagChip({ tag }: { tag: ScanTag }) {
  const chip = SCAN_TAG_CHIP[tag];
  return <Chip text={chip.text} tone={chip.tone} />;
}

/** 照片里认出来的格子：浅蓝底、蓝边（照效果图） */
export function recognizedInputStyle(colors: Colors) {
  return { backgroundColor: colors.infoSoft, borderColor: colors.info };
}

export function Label({ children, required, tag }: { children: ReactNode; required?: boolean; tag?: ScanTag | null }) {
  const colors = useColors();
  const styles = useStyles();
  const text = (
    <Text style={styles.label}>
      {children}
      {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
    </Text>
  );
  if (!tag) return text;
  return (
    <View style={styles.labelRow}>
      {text}
      <ScanTagChip tag={tag} />
    </View>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  right,
  tag,
  ...inputProps
}: TextInputProps & {
  label?: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  right?: ReactNode;
  /** 拍照识别填的：recognized 时输入框浅蓝底，标签后面标「识别」；missing 标「没认出来」 */
  tag?: ScanTag | null;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.field}>
      {label ? (
        <Label required={required} tag={tag}>
          {label}
        </Label>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          placeholderTextColor={colors.faint}
          {...inputProps}
          style={[
            styles.input,
            tag === 'recognized' ? recognizedInputStyle(colors) : null,
            error ? styles.inputError : null,
            inputProps.style,
          ]}
        />
        {right}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

/** 搜索框：胶囊形浅灰底，左边一个放大镜；属性和 TextInput 一样。获得焦点时描一圈主色。 */
export function SearchField({ style, onFocus, onBlur, ...inputProps }: TextInputProps) {
  const colors = useColors();
  const styles = useStyles();
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
  const colors = useColors();
  const styles = useStyles();
  const palette = toneColors(colors, tone);
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
  const styles = useStyles();
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
  const colors = useColors();
  const styles = useStyles();
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

/** 分段按钮的字最多缩到原来的几成（再小就看不清了） */
const SEGMENT_MIN_FONT_SCALE = 0.75;

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const styles = useStyles();
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
            style={[styles.segment, Platform.OS === 'web' && styles.segmentWeb, selected && styles.segmentSelected]}
          >
            {/* 和鸿蒙版的分段按钮一样始终一行：窄的地方（比如表单卡片里的「生产日期+保质期」）把字缩小一点，不折行 */}
            <Text
              style={[styles.segmentText, selected && styles.segmentTextSelected]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={SEGMENT_MIN_FONT_SCALE}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {right}
    </View>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const styles = useStyles();
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
  // iOS 用系统开关（拨动有触感反馈），和 iOS 设置一样只有开关本身能点，整行不切换
  const colors = useColors();
  const styles = useStyles();
  if (Platform.OS === 'ios') {
    return (
      <View style={styles.switchRow}>
        <View style={styles.flexShrink}>
          <Text style={styles.switchTitle}>{title}</Text>
          {description ? <Text style={styles.switchDescription}>{description}</Text> : null}
        </View>
        <Switch
          value={value}
          onValueChange={onChange}
          trackColor={{ true: colors.accent, false: colors.iosSwitchOff }}
          ios_backgroundColor={colors.iosSwitchOff}
          accessibilityLabel={title}
        />
      </View>
    );
  }
  // 安卓、网页（鸿蒙是原生应用，不走这里）：整行都能点，开关用自己画的鸿蒙样式；安卓系统自带的开关样式比较旧
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
  const colors = useColors();
  const styles = useStyles();
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
 * 样子照鸿蒙版的半屏面板：白底、顶上两个大圆角，左边大标题、右边圆形关闭按钮；平板、电脑上最宽 720 居中。
 * 面板里要单独圈出来的一块（比如确认导入面板里的备份摘要）用浅灰底 colors.bg，不要放白卡片，会融进面板。
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
  const colors = useColors();
  const styles = useStyles();
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
export const useStyles = makeStyles((colors) => ({
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
  // 列表页顶上的两个按钮各占一半；左右留白收窄一点，窄屏上字也排得下
  listActions: { flexDirection: 'row', gap: 8 },
  listAction: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
  buttonText: { fontSize: font.body, fontWeight: '600' },
  buttonTextCompact: { fontSize: font.small },
  iconButton: { padding: 6 },
  label: { fontSize: font.small, color: colors.muted, fontWeight: '500' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  field: { gap: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // 输入框：浅灰底、不描边（出错时描红边）；边框留着同色，出错时不跳动
  input: {
    flex: 1,
    // 网页上输入框天生有个最小宽度（约 20 个字），并排两个时会被挤出卡片；去掉它才能跟着列宽缩
    minWidth: 0,
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
  // 分段筛选：浅灰的胶囊槽，选中的一段是白色胶囊（深色模式：深灰的槽，选中的一段亮一档）
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2,
  },
  // 左右只留 2，给三段里最长的「生产日期+保质期」多留点地方；还放不下时字会缩小（见 Segmented）
  segment: {
    flex: 1,
    minHeight: 36,
    paddingVertical: 8,
    paddingHorizontal: 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 网页不支持缩字：按字的长短分宽度（最长的一段多分一点），每段至少留出自己的字宽
  segmentWeb: { flexBasis: 'auto' },
  segmentSelected: {
    backgroundColor: colors.segmentSelected,
    shadowColor: colors.shadowSoft,
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
  backdrop: { flex: 1, backgroundColor: colors.scrim },
  sheetOverlay: { backgroundColor: colors.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
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
}));
