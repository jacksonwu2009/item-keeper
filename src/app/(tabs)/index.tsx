import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback } from 'react';
import { Linking, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Button, Card, Chip, LIST_PRESS_DELAY, Screen, SectionTitle, TONES, type IconName, type Tone } from '../../components/ui';
import { listActiveAssignments, type ActiveAssignment } from '../../db/devices';
import { DEFAULT_SETTINGS, getDataSince, getLastExportAt, getSettings } from '../../db/settings';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { backupMessage, backupStatus } from '../../lib/backupReminder';
import { describeDaysLeft, diffDays, formatDate, formatShortDate, formatTime, todayStr } from '../../lib/dates';
import {
  getPermissionState,
  loadPlanProducts,
  requestPermission,
  rescheduleReminders,
  type PermissionState,
} from '../../lib/notifications';
import { planReminders, statusForDay, type PlanProduct } from '../../lib/reminderPlan';
import { formatQty, KIND_LABEL, isStockKind } from '../../lib/stock';
import { colors, font, radius } from '../../theme';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
/** 窗口至少这么宽（平板、电脑）时四个数字排一行，手机上两行两列 */
const TILES_ONE_ROW_MIN_WIDTH = 600;

function openProduct(product: PlanProduct) {
  if (product.id !== undefined) router.push({ pathname: '/stock/[id]', params: { id: String(product.id) } });
}

function kindLabel(product: PlanProduct): string {
  return isStockKind(product.kind) ? KIND_LABEL[product.kind] : '';
}

export default function RemindersScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const windowSize = useWindowDimensions();
  const tilesInOneRow = windowSize.width >= TILES_ONE_ROW_MIN_WIDTH;
  const officeFilter = office.filterId;
  const showOffice = office.multiple && officeFilter === null;
  const loader = useCallback(async () => {
    const [settings, products, active, permission, lastExportAt, dataSince] = await Promise.all([
      getSettings(db),
      loadPlanProducts(db, officeFilter),
      listActiveAssignments(db, officeFilter),
      getPermissionState().catch((): PermissionState => 'undetermined'),
      getLastExportAt(db),
      getDataSince(db),
    ]);
    return { settings, products, active, permission, lastExportAt, dataSince };
  }, [db, officeFilter]);
  const [data, reload, loaded] = useFocusData(loader, {
    settings: DEFAULT_SETTINGS,
    products: [] as PlanProduct[],
    active: [] as ActiveAssignment[],
    permission: 'granted' as PermissionState,
    lastExportAt: null as string | null,
    dataSince: null as string | null,
  });
  const { settings, products, active, permission } = data;

  const now = new Date();
  const backup = backupStatus({
    lastExportAt: data.lastExportAt,
    dataSince: data.dataSince,
    reminderDays: settings.backupReminderDays,
    now,
  });
  const today = todayStr(now);
  // 提醒页总是把该注意的都列出来，不受「关闭某类提醒」影响
  const status = statusForDay(products, { ...settings, expiryEnabled: true, lowStockEnabled: true }, today);
  const nextReminder = planReminders(products, settings, now, 60, 1)[0] ?? null;
  const attention = status.expired.length + status.expiring.length + status.lowStock.length;

  async function enableNotifications() {
    const state = await requestPermission();
    if (state === 'denied') Linking.openSettings().catch(() => undefined);
    await rescheduleReminders(db).catch(() => undefined);
    await reload();
  }

  const repeatText = settings.repeatEveryDays === 1 ? '每天' : `每 ${settings.repeatEveryDays} 天`;

  return (
    <Screen>
      <View>
        <Text style={dash.date}>
          {now.getMonth() + 1}月{now.getDate()}日 星期{WEEKDAYS[now.getDay()]}
        </Text>
        <Text style={dash.headline}>
          {!loaded ? ' ' : attention > 0 ? `有 ${attention} 样东西要处理` : '暂时没有要处理的'}
        </Text>
      </View>

      <View style={dash.shortcuts}>
        <Shortcut title="盘点" icon="clipboard-outline" onPress={() => router.push('/stocktake')} />
        <Shortcut title="报表" icon="bar-chart-outline" onPress={() => router.push('/report')} />
      </View>

      {loaded && permission !== 'granted' ? (
        <Card style={dash.permission}>
          <View style={dash.permissionRow}>
            <Ionicons name="notifications-off-outline" size={22} color={colors.warn} />
            <Text style={dash.permissionText}>通知还没开。开启后，快到期和库存不足会在每天 {formatTime(settings.reminderHour, settings.reminderMinute)} 提醒你。</Text>
          </View>
          <Button
            title={permission === 'denied' ? '去系统设置开启' : '开启通知'}
            compact
            onPress={() => enableNotifications().catch(() => undefined)}
            style={dash.noticeButton}
          />
        </Card>
      ) : null}

      {loaded && backup?.due ? (
        <Card style={dash.permission}>
          <View style={dash.permissionRow}>
            <Ionicons name="cloud-upload-outline" size={22} color={colors.warn} />
            <Text style={dash.permissionText}>
              {backupMessage(backup)}。数据只存在这台手机上，导出一份存到 iCloud 云盘或发给自己，手机丢了、换了也能找回来。
            </Text>
          </View>
          <Button title="去导出" compact onPress={() => router.navigate('/settings')} style={dash.noticeButton} />
        </Card>
      ) : null}

      <View style={dash.tiles}>
        <Tile label="已过期" value={status.expired.length} tone="danger" inOneRow={tilesInOneRow} />
        <Tile label="快到期" value={status.expiring.length} tone="warn" inOneRow={tilesInOneRow} />
        <Tile label="库存不足" value={status.lowStock.length} tone="warn" inOneRow={tilesInOneRow} />
        <Tile
          label="借出设备"
          value={active.reduce((sum, item) => sum + item.quantity, 0)}
          tone="info"
          inOneRow={tilesInOneRow}
        />
      </View>

      <Text style={dash.next}>
        {nextReminder
          ? `下次提醒：${formatShortDate(nextReminder.day)} ${formatTime(settings.reminderHour, settings.reminderMinute)}（${repeatText}，到期前 ${settings.expiryLeadDays} 天起）`
          : '近 60 天没有要发的提醒。'}
      </Text>

      {status.expired.length > 0 ? (
        <>
          <SectionTitle title="已过期" />
          <Card style={dash.listCard}>
            {status.expired.map((entry, index) => (
              <Row
                key={`${entry.product.id ?? entry.name}-expired`}
                first={index === 0}
                title={entry.name}
                subtitle={`${kindLabel(entry.product)} · ${formatDate(entry.expiryDate)} 到期 · 这批 ${formatQty(entry.quantity)} ${entry.product.unit}`}
                chip={{ text: describeDaysLeft(entry.daysLeft), tone: 'danger' }}
                onPress={() => openProduct(entry.product)}
              />
            ))}
          </Card>
        </>
      ) : null}

      {status.expiring.length > 0 ? (
        <>
          <SectionTitle title="快到期" />
          <Card style={dash.listCard}>
            {status.expiring.map((entry, index) => (
              <Row
                key={`${entry.product.id ?? entry.name}-expiring`}
                first={index === 0}
                title={entry.name}
                subtitle={`${kindLabel(entry.product)} · ${formatDate(entry.expiryDate)} 到期 · 这批 ${formatQty(entry.quantity)} ${entry.product.unit}`}
                chip={{ text: describeDaysLeft(entry.daysLeft), tone: 'warn' }}
                onPress={() => openProduct(entry.product)}
              />
            ))}
          </Card>
        </>
      ) : null}

      {status.lowStock.length > 0 ? (
        <>
          <SectionTitle title="库存不足" />
          <Card style={dash.listCard}>
            {status.lowStock.map((entry, index) => (
              <Row
                key={`${entry.product.id ?? entry.name}-low`}
                first={index === 0}
                title={entry.name}
                subtitle={`${kindLabel(entry.product)} · 下限 ${formatQty(entry.product.lowStockThreshold ?? 0)} ${entry.unit}`}
                chip={{ text: `剩 ${formatQty(entry.qty)} ${entry.unit}`, tone: entry.qty <= 0 ? 'danger' : 'warn' }}
                onPress={() => openProduct(entry.product)}
              />
            ))}
          </Card>
        </>
      ) : null}

      {active.length > 0 ? (
        <>
          <SectionTitle title="借出中的设备" />
          <Card style={dash.listCard}>
            {active.map((item, index) => (
              <Row
                key={item.id}
                first={index === 0}
                title={`${item.person} · ${item.deviceName}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`}
                subtitle={[
                  showOffice && office.officeName(item.officeId),
                  item.category,
                  item.deviceModel,
                  `${formatDate(item.issuedOn)} 领取`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                chip={{ text: `${Math.max(0, diffDays(today, item.issuedOn))} 天`, tone: 'neutral' }}
                onPress={() => router.push({ pathname: '/device/[id]', params: { id: String(item.deviceId) } })}
              />
            ))}
          </Card>
        </>
      ) : null}

      {loaded && attention === 0 && active.length === 0 ? (
        <Card style={dash.allGood}>
          <Ionicons name="checkmark-circle-outline" size={28} color={colors.ok} />
          <Text style={dash.allGoodText}>
            {products.length === 0
              ? '还没有录入东西。去「食品」「日用品」扫码入库，或在「设备」里登记电脑和配件。'
              : '没有过期、快到期或库存不足的东西。'}
          </Text>
        </Card>
      ) : null}
    </Screen>
  );
}

/** 常用入口（盘点、报表）：白底圆角小块，上面图标、下面文字 */
function Shortcut({ title, icon, onPress }: { title: string; icon: IconName; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [dash.shortcut, pressed && dash.shortcutPressed]}
    >
      <Ionicons name={icon} size={22} color={colors.accent} />
      <Text style={dash.shortcutText}>{title}</Text>
    </Pressable>
  );
}

/** 统计小方块：有数时用这个状态的浅色做底、深色写数字；是 0 时白底灰字 */
function Tile({ label, value, tone, inOneRow }: { label: string; value: number; tone: Tone; inOneRow: boolean }) {
  const palette = TONES[tone];
  const active = value > 0;
  return (
    <View style={[dash.tile, inOneRow ? dash.tileOneRow : dash.tileTwoColumns, active && { backgroundColor: palette.bg }]}>
      <Text style={[dash.tileValue, { color: active ? palette.fg : colors.faint }]}>{value}</Text>
      <Text style={dash.tileLabel}>{label}</Text>
    </View>
  );
}

function Row({
  title,
  subtitle,
  chip,
  first,
  onPress,
}: {
  title: string;
  subtitle: string;
  chip: { text: string; tone: Tone };
  first: boolean;
  onPress: () => void;
}) {
  // 卡片本身不留内边距、超出部分裁掉，按下的底色铺满整行（到卡片边缘，圆角也跟着）；分隔线单独画，左边留空、右边到头
  return (
    <>
      {first ? null : <View style={dash.rowDivider} />}
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [dash.row, pressed && { backgroundColor: colors.surfaceSunken }]}
      >
        <View style={dash.rowMain}>
          <Text style={dash.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={dash.rowSub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Chip text={chip.text} tone={chip.tone} />
        <Ionicons name="chevron-forward" size={16} color={colors.faint} />
      </Pressable>
    </>
  );
}

const dash = StyleSheet.create({
  date: { fontSize: font.small, color: colors.muted, fontWeight: '500' },
  headline: { fontSize: 26, fontWeight: '800', color: colors.ink, marginTop: 2 },
  permission: { backgroundColor: colors.warnSoft },
  permissionRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  permissionText: { flex: 1, fontSize: font.small, color: colors.ink, lineHeight: 20 },
  noticeButton: { alignSelf: 'flex-start' },
  shortcuts: { flexDirection: 'row', gap: 8 },
  shortcut: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
  shortcutPressed: { backgroundColor: colors.surfaceSunken },
  shortcutText: { fontSize: font.small, color: colors.ink },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    flexGrow: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 12,
    gap: 4,
  },
  // 两列：每块略小于一半，剩下的由 flexGrow 补齐；一行四块同理
  tileTwoColumns: { flexBasis: '45%' },
  tileOneRow: { flexBasis: '22%' },
  tileValue: { fontSize: font.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tileLabel: { fontSize: font.small, color: colors.muted },
  next: { fontSize: font.small, color: colors.muted, lineHeight: 19 },
  listCard: { padding: 0, gap: 0, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 56,
    paddingVertical: 10,
    paddingLeft: 16,
    paddingRight: 12,
  },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 16 },
  rowMain: { flex: 1, minWidth: 0, gap: 2, marginRight: 4 },
  rowTitle: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  rowSub: { fontSize: font.small, color: colors.muted },
  allGood: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  allGoodText: { flex: 1, fontSize: font.small, color: colors.muted, lineHeight: 20 },
});
