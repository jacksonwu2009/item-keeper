import Ionicons from '@expo/vector-icons/Ionicons';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { makeStyles, useColors } from '../hooks/useTheme';
import type { BarDatum, ColumnDatum } from '../lib/reportOverview';
import type { Colors } from '../theme';
import { font, radius } from '../theme';
import { Text } from './Text';
import { LIST_PRESS_DELAY } from './ui';

/**
 * 报表首页的图：大数字、分段条、横条、柱状图。只用 View 画（不加原生依赖），颜色全从主题取，深色模式跟着变。
 * 每个都用 memo 包着：数据没变（同一个对象）就不重画；切办公点、时间段时只有数变了的重画。
 * 文字不压在色块上（图例、数值都写在条外面），深浅两种模式下都看得清。
 */

/** 图上用的颜色：主题里的名字 */
export type ChartTone = 'accent' | 'info' | 'ok' | 'warn' | 'danger' | 'muted';

function toneColor(colors: Colors, tone: ChartTone): string {
  return colors[tone];
}

/** 一排大数字里的一个：点了能进明细的带箭头 */
export type StatItem = { key: string; label: string; value: string; tone?: ChartTone; onPress?: () => void };

export const StatRow = memo(function StatRow({ items }: { items: readonly StatItem[] }) {
  const styles = useChartStyles();
  return (
    <View style={styles.statRow}>
      {items.map((item) => (
        <StatTile key={item.key} item={item} />
      ))}
    </View>
  );
});

const StatTile = memo(function StatTile({ item }: { item: StatItem }) {
  const colors = useColors();
  const styles = useChartStyles();
  const color = item.tone ? toneColor(colors, item.tone) : colors.ink;
  const body = (
    <>
      <Text style={[styles.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {item.value}
      </Text>
      <View style={styles.statLabelRow}>
        <Text style={styles.statLabel} numberOfLines={1}>
          {item.label}
        </Text>
        {item.onPress ? <Ionicons name="chevron-forward" size={12} color={colors.faint} /> : null}
      </View>
    </>
  );
  if (!item.onPress) return <View style={styles.statTile}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.label} ${item.value}`}
      onPress={item.onPress}
      unstable_pressDelay={LIST_PRESS_DELAY}
      style={({ pressed }) => [styles.statTile, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
});

/** 分段条的一段 */
export type Segment = { key: string; label: string; value: number; text: string; tone: ChartTone };

/**
 * 分段条：一根横条按比例分成几段，段与段之间留一道卡片底色的缝（深色下相邻两段也分得清）；
 * 下面是图例（色点 + 名称 + 数），数是 0 的段不画但图例照列。全是 0 时只画空的底槽。
 */
export const SegmentBar = memo(function SegmentBar({ segments }: { segments: readonly Segment[] }) {
  const colors = useColors();
  const styles = useChartStyles();
  const visible = segments.filter((segment) => segment.value > 0);
  return (
    <View style={styles.segmentWrap}>
      <View style={styles.segmentTrack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {visible.map((segment, index) => (
          <View
            key={segment.key}
            style={[
              styles.segment,
              { flexGrow: segment.value, backgroundColor: toneColor(colors, segment.tone) },
              index > 0 && styles.segmentGap,
            ]}
          />
        ))}
      </View>
      <View style={styles.legend}>
        {segments.map((segment) => (
          <View key={segment.key} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: toneColor(colors, segment.tone) }]} />
            <Text style={styles.legendText}>
              {segment.label} <Text style={styles.legendValue}>{segment.text}</Text>
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
});

/**
 * 横条图：每条上面一行写名称和数，下面一根条（长短按这一组里最大的那个比）。
 * onPressItem 给了就能点（比如出库最多的物品点进物品详情）；toneOf 可以给个别条换颜色（比如损耗用提示色）。
 */
export const BarList = memo(function BarList({
  items,
  tone = 'accent',
  toneOf,
  onPressItem,
}: {
  items: readonly BarDatum[];
  tone?: ChartTone;
  toneOf?: (item: BarDatum) => ChartTone;
  onPressItem?: (key: string) => void;
}) {
  const max = items.reduce((value, item) => Math.max(value, item.value), 0);
  return (
    <View>
      {items.map((item) => (
        <BarRow key={item.key} item={item} max={max} tone={toneOf ? toneOf(item) : tone} onPressItem={onPressItem} />
      ))}
    </View>
  );
});

const BarRow = memo(function BarRow({
  item,
  max,
  tone,
  onPressItem,
}: {
  item: BarDatum;
  max: number;
  tone: ChartTone;
  onPressItem?: (key: string) => void;
}) {
  const colors = useColors();
  const styles = useChartStyles();
  const share = max > 0 ? item.value / max : 0;
  const body = (
    <>
      <View style={styles.barTextRow}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {item.label}
        </Text>
        <Text style={styles.barValue}>{item.text}</Text>
        {onPressItem ? <Ionicons name="chevron-forward" size={14} color={colors.faint} /> : null}
      </View>
      <View style={styles.barTrack}>
        {share > 0 ? <View style={[styles.barFill, { width: `${Math.max(share * 100, 1.5)}%`, backgroundColor: toneColor(colors, tone) }]} /> : null}
      </View>
    </>
  );
  if (!onPressItem || item.key === '__rest__') return <View style={styles.barRow}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPressItem(item.key)}
      unstable_pressDelay={LIST_PRESS_DELAY}
      style={({ pressed }) => [styles.barRow, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
});

/** 柱子上写的数：一万以上写成「1.2万」，柱子窄也放得下 */
export function compactNumber(value: number): string {
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.round(value));
}

const COLUMN_HEIGHT = 96;

/**
 * 柱状图（时间段内每周 / 每月）：柱高按最大的那根比，柱顶写数（0 不写），下面写标签；底下一条坐标线。
 */
export const ColumnChart = memo(function ColumnChart({ columns, tone = 'accent' }: { columns: readonly ColumnDatum[]; tone?: ChartTone }) {
  const colors = useColors();
  const styles = useChartStyles();
  const max = columns.reduce((value, column) => Math.max(value, column.value), 0);
  const fill = toneColor(colors, tone);
  return (
    <View style={styles.columnWrap} accessibilityLabel={columns.map((column) => `${column.label} ${compactNumber(column.value)}`).join('，')}>
      <View style={styles.columnPlot}>
        {columns.map((column) => {
          const height = max > 0 ? Math.round((column.value / max) * COLUMN_HEIGHT) : 0;
          return (
            <View key={column.key} style={styles.column}>
              <Text style={styles.columnValue} numberOfLines={1}>
                {column.value > 0 ? compactNumber(column.value) : ''}
              </Text>
              <View style={[styles.columnBar, { height: column.value > 0 ? Math.max(height, 2) : 0, backgroundColor: fill }]} />
            </View>
          );
        })}
      </View>
      <View style={styles.columnAxis} />
      <View style={styles.columnLabels}>
        {columns.map((column) => (
          <Text key={column.key} style={styles.columnLabel} numberOfLines={1}>
            {column.label}
          </Text>
        ))}
      </View>
    </View>
  );
});

/** 加载中的占位：几条灰色的块，高度和真的内容差不多，读完换上时页面不跳 */
export const ChartPlaceholder = memo(function ChartPlaceholder({ lines = 3 }: { lines?: number }) {
  const styles = useChartStyles();
  return (
    <View style={styles.placeholder}>
      <View style={styles.placeholderStats}>
        <View style={styles.placeholderBlock} />
        <View style={styles.placeholderBlock} />
        <View style={styles.placeholderBlock} />
      </View>
      {Array.from({ length: lines }, (_, index) => (
        <View key={index} style={[styles.placeholderLine, { width: `${90 - index * 18}%` }]} />
      ))}
    </View>
  );
});

const useChartStyles = makeStyles((colors) => ({
  pressed: { backgroundColor: colors.surfaceSunken },
  statRow: { flexDirection: 'row', gap: 4 },
  statTile: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2, paddingVertical: 8, borderRadius: radius.md },
  statValue: { fontSize: font.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  statLabel: { fontSize: font.small, color: colors.muted },
  segmentWrap: { gap: 8, paddingVertical: 8 },
  segmentTrack: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: colors.surfaceSunken },
  segment: { flexBasis: 0, minWidth: 3 },
  // 段与段之间的缝用卡片的底色，深色、浅色下都和两边的颜色分得开
  segmentGap: { borderLeftWidth: 2, borderLeftColor: colors.surface },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: font.small, color: colors.muted },
  legendValue: { color: colors.ink, fontWeight: '700', fontVariant: ['tabular-nums'] },
  barRow: { paddingVertical: 6, gap: 4, borderRadius: radius.sm },
  barTextRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { flex: 1, minWidth: 0, fontSize: font.body, color: colors.ink },
  barValue: { fontSize: font.small, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceSunken, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  columnWrap: { paddingTop: 8 },
  columnPlot: { flexDirection: 'row', alignItems: 'flex-end', height: COLUMN_HEIGHT + 16, gap: 4 },
  column: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
  columnValue: { fontSize: font.tiny, color: colors.muted, fontVariant: ['tabular-nums'] },
  columnBar: { width: '70%', maxWidth: 28, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  columnAxis: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  columnLabels: { flexDirection: 'row', gap: 4, paddingTop: 4 },
  columnLabel: { flex: 1, minWidth: 0, fontSize: font.tiny, color: colors.muted, textAlign: 'center' },
  placeholder: { gap: 10, paddingVertical: 8 },
  placeholderStats: { flexDirection: 'row', gap: 12 },
  placeholderBlock: { flex: 1, height: 44, borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
  placeholderLine: { height: 10, borderRadius: 5, backgroundColor: colors.surfaceSunken },
}));
