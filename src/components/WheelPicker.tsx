import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatTime, todayStr } from '../lib/dates';
import {
  describeWheelDate,
  initialWheelDate,
  isDayDisabled,
  isMonthDisabled,
  isYearDisabled,
  nearestEnabledIndex,
  resolveWheelDate,
  wheelDateToStr,
  wheelDays,
  wheelHours,
  wheelIndexAt,
  wheelMinutes,
  wheelMonths,
  wheelYears,
  type WheelDate,
} from '../lib/wheelPicker';
import { colors, font, radius } from '../theme';
import { Button, styles as uiStyles } from './ui';

/**
 * 安卓的日期、时间选择：底部白色面板里放我们自己画的滚轮（安卓系统的日期对话框样子旧，和 App 不搭）。
 * 样子照效果图：左边标题（字段名）、右边圆形关闭按钮；下面一行实时写出选中的是哪天、星期几、离今天多久；
 * 每列每行 48 高、显示 5 行，中间一行垫浅绿色条，选中的字加粗加大，上下两头渐隐。
 * 点「确定」才写回字段；点关闭、点面板外面、按返回键都不改。iOS 用系统滚轮（DateField.tsx）。
 */

const ROW_HEIGHT = 48;
const VISIBLE_ROWS = 5;
/** 中间那一行上下各露出几行 */
const SIDE_ROWS = (VISIBLE_ROWS - 1) / 2;
/**
 * 松手后等这么久还没开始惯性滑动，就当作停下了：安卓轻轻拖一下松手没有惯性，只会触发 onScrollEndDrag；
 * 有惯性的话 onMomentumScrollBegin 紧跟着来，取消这次，等 onMomentumScrollEnd。
 */
const DRAG_SETTLE_DELAY_MS = 100;
/** 离中间两行的字（比 colors.faint 再浅一档，和效果图一样） */
const FAR_ROW_COLOR = '#C3CCC6';
/** 早于最早日期、不能选的年月日 */
const DISABLED_ROW_COLOR = '#D3DAD5';
/** 上下两头渐隐：从面板的白色渐变到透明 */
const FADE_HEIGHT = 56;

export type WheelItem = { label: string; disabled?: boolean };

/**
 * 一列滚轮。停下时自动对齐到最近的一行（snapToInterval），按停下的位置算出选中第几行交给 onSelect；
 * 停在灰掉的行上会弹回最近能选的一行。selectedIndex 被外面改了（弹回、日数变少、点「今天」）就滚过去。
 * 点某一行也能直接选它；读屏时整列是一个可调节的控件，上下滑动换一行。
 */
function WheelColumn({
  items,
  selectedIndex,
  onSelect,
  accessibilityLabel,
}: {
  items: WheelItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  accessibilityLabel: string;
}) {
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // 打开时直接停在当前值上（安卓认 contentOffset；万一没认，onLayout 里再滚一次）
  const [initialOffset] = useState(() => ({ x: 0, y: selectedIndex * ROW_HEIGHT }));
  const offsetRef = useRef(selectedIndex * ROW_HEIGHT);
  const userScrollingRef = useRef(false);
  const laidOutRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 手指拨动、惯性滑动时正对中间的是哪一行（加粗的字跟着走）；没在拨时是 null，按 selectedIndex 显示
  const [liveIndex, setLiveIndex] = useState<number | null>(null);
  const highlightIndex = liveIndex ?? selectedIndex;

  useEffect(() => {
    if (userScrollingRef.current) return;
    const target = selectedIndex * ROW_HEIGHT;
    if (Math.abs(offsetRef.current - target) > 1) scrollRef.current?.scrollTo({ y: target, animated: true });
  }, [selectedIndex, items.length]);

  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  function clearSettleTimer() {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }

  /** 选中第 index 行：灰掉的弹回最近能选的；值变了轻轻震一下 */
  function choose(index: number) {
    clearSettleTimer();
    userScrollingRef.current = false;
    setLiveIndex(null);
    const target = nearestEnabledIndex(
      items.map((item) => !!item.disabled),
      Math.min(items.length - 1, Math.max(0, index)),
    );
    if (target !== selectedIndex) {
      Haptics.selectionAsync().catch(() => undefined);
      // 选中项变了，上面的 useEffect 会把这一列对齐过去
      onSelect(target);
      return;
    }
    // 值没变（拨到灰掉的又弹回原处、没拨满半行）：对齐回去
    if (Math.abs(offsetRef.current - target * ROW_HEIGHT) > 1) {
      scrollRef.current?.scrollTo({ y: target * ROW_HEIGHT, animated: true });
    }
  }

  function settleAt(offset: number) {
    choose(wheelIndexAt(offset, ROW_HEIGHT, items.length));
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    offsetRef.current = event.nativeEvent.contentOffset.y;
    if (userScrollingRef.current) setLiveIndex(wheelIndexAt(offsetRef.current, ROW_HEIGHT, items.length));
  }

  function handleAccessibilityAction(event: AccessibilityActionEvent) {
    if (event.nativeEvent.actionName === 'increment') choose(selectedIndex + 1);
    if (event.nativeEvent.actionName === 'decrement') choose(selectedIndex - 1);
  }

  return (
    <View
      style={wheelStyles.column}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: items[selectedIndex]?.label ?? '' }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={handleAccessibilityAction}
    >
      <ScrollView
        ref={scrollRef}
        contentOffset={initialOffset}
        contentContainerStyle={wheelStyles.columnContent}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
        nestedScrollEnabled
        snapToInterval={ROW_HEIGHT}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onLayout={() => {
          if (laidOutRef.current) return;
          laidOutRef.current = true;
          scrollRef.current?.scrollTo({ y: selectedIndex * ROW_HEIGHT, animated: false });
        }}
        onScroll={handleScroll}
        onScrollBeginDrag={() => {
          clearSettleTimer();
          userScrollingRef.current = true;
        }}
        onScrollEndDrag={(event) => {
          offsetRef.current = event.nativeEvent.contentOffset.y;
          clearSettleTimer();
          settleTimerRef.current = setTimeout(() => settleAt(offsetRef.current), DRAG_SETTLE_DELAY_MS);
        }}
        onMomentumScrollBegin={clearSettleTimer}
        onMomentumScrollEnd={(event) => settleAt(event.nativeEvent.contentOffset.y)}
      >
        {items.map((item, index) => {
          const distance = Math.abs(index - highlightIndex);
          return (
            <Pressable key={index} style={wheelStyles.row} onPress={() => choose(index)} importantForAccessibility="no">
              <Text
                style={[
                  wheelStyles.rowText,
                  distance === 0 ? wheelStyles.rowTextSelected : distance === 1 ? wheelStyles.rowTextNear : wheelStyles.rowTextFar,
                  item.disabled && wheelStyles.rowTextDisabled,
                ]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** 几列滚轮并排，中间垫一条浅绿色条，上下两头渐隐；narrow 是时间那种两列的，窄一点居中 */
function WheelGroup({ narrow, children }: { narrow?: boolean; children: ReactNode }) {
  return (
    <View style={[wheelStyles.wheels, narrow && wheelStyles.wheelsNarrow]}>
      <View style={wheelStyles.band} />
      {children}
      <View style={[wheelStyles.fade, wheelStyles.fadeTop]} />
      <View style={[wheelStyles.fade, wheelStyles.fadeBottom]} />
    </View>
  );
}

/** 底部面板的外框：样子和 ui.tsx 的 Sheet 一样（标题、圆形关闭按钮），里面不套滚动视图，免得和滚轮抢手势 */
function WheelSheet({
  title,
  preview,
  onClose,
  actions,
  children,
}: {
  title: string;
  preview: string;
  onClose: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // 打开时收起键盘：刚在输入框里打完字就点日期框的话，键盘会挡住面板下半截
  useEffect(() => {
    Keyboard.dismiss();
  }, []);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[uiStyles.flex, uiStyles.sheetOverlay]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="关闭" />
        <View style={[uiStyles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={uiStyles.sheetHeader}>
            <Text style={uiStyles.sheetTitle}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              onPress={onClose}
              hitSlop={4}
              style={({ pressed }) => [uiStyles.sheetClose, pressed && uiStyles.sheetClosePressed]}
            >
              <Ionicons name="close" size={22} color={colors.ink} />
            </Pressable>
          </View>
          <Text style={wheelStyles.preview} accessibilityLiveRegion="polite">
            {preview}
          </Text>
          {children}
          <View style={wheelStyles.actions}>{actions}</View>
        </View>
      </View>
    </Modal>
  );
}

/** 日期滚轮面板：年、月、日三列。有最早日期时早于它的灰掉，停在那里会弹回最早能选的 */
export function DateWheelSheet({
  title,
  value,
  minimumDate,
  clearable,
  onConfirm,
  onClose,
}: {
  title: string;
  value: string | null;
  minimumDate: string | null;
  clearable: boolean;
  /** 点「确定」给选中的日期，点「清除」给 null；面板由调用方关掉 */
  onConfirm: (value: string | null) => void;
  onClose: () => void;
}) {
  const [today] = useState(() => todayStr());
  const [years] = useState(() => wheelYears({ today, value, minimumDate }));
  const [selection, setSelection] = useState<WheelDate>(() => initialWheelDate(value, today, minimumDate));
  const months = wheelMonths();
  const days = wheelDays(selection.year, selection.month);
  const todayBlocked = !!minimumDate && today < minimumDate;

  function update(change: Partial<WheelDate>) {
    setSelection((current) => resolveWheelDate({ ...current, ...change }, minimumDate));
  }

  return (
    <WheelSheet
      title={title}
      preview={describeWheelDate(wheelDateToStr(selection), today)}
      onClose={onClose}
      actions={
        <>
          {clearable ? <Button title="清除" variant="ghost" style={wheelStyles.minorAction} onPress={() => onConfirm(null)} /> : null}
          <Button
            title="今天"
            variant="secondary"
            style={wheelStyles.minorAction}
            disabled={todayBlocked}
            onPress={() => setSelection(initialWheelDate(today, today, minimumDate))}
          />
          <Button title="确定" style={wheelStyles.mainAction} onPress={() => onConfirm(wheelDateToStr(selection))} />
        </>
      }
    >
      <WheelGroup>
        <WheelColumn
          accessibilityLabel="年"
          items={years.map((year) => ({ label: `${year}年`, disabled: isYearDisabled(year, minimumDate) }))}
          selectedIndex={Math.max(0, years.indexOf(selection.year))}
          onSelect={(index) => update({ year: years[index] })}
        />
        <WheelColumn
          accessibilityLabel="月"
          items={months.map((month) => ({ label: `${month}月`, disabled: isMonthDisabled(selection.year, month, minimumDate) }))}
          selectedIndex={selection.month - 1}
          onSelect={(index) => update({ month: months[index] })}
        />
        <WheelColumn
          accessibilityLabel="日"
          items={days.map((day) => ({
            label: `${day}日`,
            disabled: isDayDisabled({ year: selection.year, month: selection.month, day }, minimumDate),
          }))}
          selectedIndex={selection.day - 1}
          onSelect={(index) => update({ day: days[index] })}
        />
      </WheelGroup>
    </WheelSheet>
  );
}

/** 时间滚轮面板：时、分两列，分钟 5 分钟一档 */
export function TimeWheelSheet({
  title,
  hour,
  minute,
  onConfirm,
  onClose,
}: {
  title: string;
  hour: number;
  minute: number;
  /** 点「确定」给选中的时、分；面板由调用方关掉 */
  onConfirm: (hour: number, minute: number) => void;
  onClose: () => void;
}) {
  const [hours] = useState(wheelHours);
  const [minutes] = useState(() => wheelMinutes(minute));
  const [selection, setSelection] = useState({ hour, minute });

  return (
    <WheelSheet
      title={title}
      preview={formatTime(selection.hour, selection.minute)}
      onClose={onClose}
      actions={<Button title="确定" style={wheelStyles.mainAction} onPress={() => onConfirm(selection.hour, selection.minute)} />}
    >
      <WheelGroup narrow>
        <WheelColumn
          accessibilityLabel="时"
          items={hours.map((value) => ({ label: `${String(value).padStart(2, '0')} 时` }))}
          selectedIndex={Math.max(0, hours.indexOf(selection.hour))}
          onSelect={(index) => setSelection((current) => ({ ...current, hour: hours[index] }))}
        />
        <WheelColumn
          accessibilityLabel="分"
          items={minutes.map((value) => ({ label: `${String(value).padStart(2, '0')} 分` }))}
          selectedIndex={Math.max(0, minutes.indexOf(selection.minute))}
          onSelect={(index) => setSelection((current) => ({ ...current, minute: minutes[index] }))}
        />
      </WheelGroup>
    </WheelSheet>
  );
}

const wheelStyles = StyleSheet.create({
  preview: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 6,
    fontSize: font.small,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  wheels: {
    height: ROW_HEIGHT * VISIBLE_ROWS,
    marginHorizontal: 16,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  // 时间只有两列，照效果图收窄居中，两列挨得近一点
  wheelsNarrow: { alignSelf: 'center', width: 260, maxWidth: '100%' },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: ROW_HEIGHT * SIDE_ROWS,
    height: ROW_HEIGHT,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  column: { flex: 1 },
  // 上下各垫两行空白，第一行、最后一行也能停到中间
  columnContent: { paddingVertical: ROW_HEIGHT * SIDE_ROWS },
  row: { height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  rowText: { fontVariant: ['tabular-nums'] },
  rowTextSelected: { fontSize: 20, fontWeight: '700', color: colors.ink },
  rowTextNear: { fontSize: 17, color: colors.faint },
  rowTextFar: { fontSize: 15, color: FAR_ROW_COLOR },
  rowTextDisabled: { color: DISABLED_ROW_COLOR },
  // 渐隐层盖在滚轮上面，不接手势
  fade: { position: 'absolute', left: 0, right: 0, height: FADE_HEIGHT, pointerEvents: 'none' },
  fadeTop: { top: 0, backgroundImage: 'linear-gradient(rgba(255, 255, 255, 1), rgba(255, 255, 255, 0))' },
  fadeBottom: { bottom: 0, backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 1))' },
  actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 16 },
  // 「清除」「今天」各占一份，「确定」占两份（最宽）
  minorAction: { flex: 1, paddingHorizontal: 8 },
  mainAction: { flex: 2 },
});
