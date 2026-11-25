import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback } from 'react';
import { Linking, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { Text } from '../../../components/Text';

import { ReminderCard, ReminderMoreRow, ReminderRow } from '../../../components/ReminderRows';
import { Button, Card, Screen, SectionTitle, toneColors, type IconName, type Tone } from '../../../components/ui';
import { listActiveAssignments, listDevices, type ActiveAssignment, type DeviceSummary } from '../../../db/devices';
import { DEFAULT_SETTINGS, getDataSince, getLastExportAt, getSettings } from '../../../db/settings';
import { useFocusData } from '../../../hooks/useFocusData';
import { useOffice } from '../../../hooks/useOffice';
import { useScene } from '../../../hooks/useScene';
import { backupMessage, backupStatus } from '../../../lib/backupReminder';
import { formatShortDate, formatTime, todayStr } from '../../../lib/dates';
import {
  getPermissionState,
  loadPlanProducts,
  loadPlanWarranties,
  requestPermission,
  rescheduleReminders,
  type PermissionState,
} from '../../../lib/notifications';
import {
  expiryRowText,
  lowStockRowText,
  previewOf,
  REMINDER_GROUP_TITLES,
  shortDateIn,
  showKindFor,
  sortLowStock,
  warrantyChipText,
  warrantySoonDevices,
  type ReminderGroup,
} from '../../../lib/reminderList';
import {
  planReminders,
  statusForDay,
  type DayStatus,
  type ExpiryEntry,
  type LowStockEntry,
  type PlannedReminder,
  type PlanProduct,
  type PlanWarranty,
} from '../../../lib/reminderPlan';
import { makeStyles, useColors } from '../../../hooks/useTheme';
import { font, radius } from '../../../theme';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
/** 窗口至少这么宽（平板、电脑）时四个数字排一行，手机上两行两列 */
const TILES_ONE_ROW_MIN_WIDTH = 600;

function openProduct(product: PlanProduct) {
  if (product.id !== undefined) router.push({ pathname: '/stock/[id]', params: { id: String(product.id) } });
}

/** 打开某一组的完整列表（提醒页每组只显示前几样） */
function openGroup(group: ReminderGroup) {
  router.push({ pathname: '/reminders/[group]', params: { group } });
}

/** 借出中的设备不在提醒页逐台列：打开设备页，按使用人看（at 让再点一次也会切过去） */
function openBorrowedDevices() {
  router.navigate({ pathname: '/devices', params: { view: 'person', at: String(Date.now()) } });
}

/** 还没读到数据时：没有要提醒的 */
const EMPTY_PLAN: {
  today: string;
  status: DayStatus;
  lowStock: LowStockEntry[];
  nextReminder: PlannedReminder | null;
  warrantySoon: { device: DeviceSummary; daysLeft: number }[];
} = {
  today: todayStr(),
  status: { expiring: [], expired: [], lowStock: [], due: false },
  lowStock: [],
  nextReminder: null,
  warrantySoon: [],
};

export default function RemindersScreen() {
  const colors = useColors();
  const dash = useDashStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene } = useScene();
  // 家庭场景：设备不看借出，看保修快到期的
  const home = scene === 'home';
  const windowSize = useWindowDimensions();
  const tilesInOneRow = windowSize.width >= TILES_ONE_ROW_MIN_WIDTH;
  const officeFilter = office.filterId;
  const showOffice = office.multiple && officeFilter === null;
  const loader = useCallback(async () => {
    const [settings, products, active, devices, warranties, permission, lastExportAt, dataSince] = await Promise.all([
      getSettings(db),
      loadPlanProducts(db, officeFilter),
      listActiveAssignments(db, officeFilter),
      listDevices(db, officeFilter),
      home ? loadPlanWarranties(db, officeFilter) : Promise.resolve([]),
      getPermissionState().catch((): PermissionState => 'undetermined'),
      getLastExportAt(db),
      getDataSince(db),
    ]);
    // 提醒状态、下次提醒在读完数据时算好（不是每次渲染都排一遍 60 天的计划）；回到前台、数据变了都会重读重算
    const now = new Date();
    const today = todayStr(now);
    // 提醒页总是把该注意的都列出来，不受「关闭某类提醒」影响
    const status = statusForDay(products, { ...settings, expiryEnabled: true, lowStockEnabled: true }, today);
    const plan = {
      today,
      status,
      lowStock: sortLowStock(status.lowStock),
      nextReminder: planReminders(products, settings, now, 60, 1, warranties)[0] ?? null,
      warrantySoon: home ? warrantySoonDevices(devices, today) : [],
    };
    return { settings, products, active, devices, warranties, permission, lastExportAt, dataSince, plan };
  }, [db, officeFilter, home]);
  const [data, reload, loaded] = useFocusData(loader, {
    settings: DEFAULT_SETTINGS,
    products: [] as PlanProduct[],
    active: [] as ActiveAssignment[],
    devices: [] as DeviceSummary[],
    warranties: [] as PlanWarranty[],
    permission: 'granted' as PermissionState,
    lastExportAt: null as string | null,
    dataSince: null as string | null,
    plan: EMPTY_PLAN,
  });
  const { settings, products, active, permission } = data;
  const { today, status, lowStock, nextReminder, warrantySoon } = data.plan;

  const now = new Date();
  const backup = backupStatus({
    lastExportAt: data.lastExportAt,
    dataSince: data.dataSince,
    reminderDays: settings.backupReminderDays,
    now,
  });
  const attention = status.expired.length + status.expiring.length + status.lowStock.length + warrantySoon.length;

  async function enableNotifications() {
    const state = await requestPermission();
    if (state === 'denied') Linking.openSettings().catch(() => undefined);
    await rescheduleReminders(db).catch(() => undefined);
    await reload();
  }

  const repeatText = settings.repeatEveryDays === 1 ? '每天' : `每 ${settings.repeatEveryDays} 天`;

  return (
    <Screen largeTitle>
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
              {backupMessage(backup)}。数据只存在这台手机上，导出一份存到{Platform.OS === 'ios' ? ' iCloud 云盘' : '网盘'}或发给自己，手机丢了、换了也能找回来。
            </Text>
          </View>
          {/* 导入导出现在是设置里点进去的单独页面，直接打开它 */}
          <Button title="去导出" compact onPress={() => router.push('/backup')} style={dash.noticeButton} />
        </Card>
      ) : null}

      <View style={dash.tiles}>
        <Tile label="已过期" value={status.expired.length} tone="danger" inOneRow={tilesInOneRow} onPress={() => openGroup('expired')} />
        <Tile label="快到期" value={status.expiring.length} tone="warn" inOneRow={tilesInOneRow} onPress={() => openGroup('expiring')} />
        <Tile label="库存不足" value={lowStock.length} tone="warn" inOneRow={tilesInOneRow} onPress={() => openGroup('lowStock')} />
        <Tile
          label={home ? '快过保' : '借出设备'}
          value={home ? warrantySoon.length : active.reduce((sum, item) => sum + item.quantity, 0)}
          tone={home ? 'warn' : 'info'}
          inOneRow={tilesInOneRow}
          onPress={() => (home ? openGroup('warranty') : openBorrowedDevices())}
        />
      </View>

      <Text style={dash.next}>
        {nextReminder
          ? `下次提醒：${formatShortDate(nextReminder.day)} ${formatTime(settings.reminderHour, settings.reminderMinute)}（${repeatText}，到期前 ${settings.expiryLeadDays} 天起）`
          : '近 60 天没有要发的提醒。'}
      </Text>

      {/* 每组只显示前几样，其余点「查看全部」；借出中的设备不是待办，不在这里逐台列（上面的数字块点了去设备页） */}
      <ExpirySection group="expired" entries={status.expired} today={today} tone="danger" />
      <ExpirySection group="expiring" entries={status.expiring} today={today} tone="warn" />

      {lowStock.length > 0 ? (
        <>
          <SectionTitle title={REMINDER_GROUP_TITLES.lowStock} />
          <ReminderCard>
            {previewOf(lowStock).shown.map((entry, index) => {
              const text = lowStockRowText(entry, showKindFor(lowStock));
              return (
                <ReminderRow
                  key={`${entry.product.id ?? entry.name}-low`}
                  first={index === 0}
                  title={entry.name}
                  subtitle={text.subtitle}
                  chip={{ text: text.chip, tone: entry.qty <= 0 ? 'danger' : 'warn' }}
                  onPress={() => openProduct(entry.product)}
                />
              );
            })}
            {previewOf(lowStock).hidden > 0 ? <ReminderMoreRow total={lowStock.length} onPress={() => openGroup('lowStock')} /> : null}
          </ReminderCard>
        </>
      ) : null}

      {home && warrantySoon.length > 0 ? (
        <>
          <SectionTitle title={REMINDER_GROUP_TITLES.warranty} />
          <ReminderCard>
            {previewOf(warrantySoon).shown.map(({ device, daysLeft }, index) => (
              <ReminderRow
                key={device.id}
                first={index === 0}
                title={device.name}
                subtitle={[
                  showOffice && office.officeName(device.officeId),
                  device.category,
                  device.warrantyUntil && `保修到 ${shortDateIn(device.warrantyUntil, today)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                chip={{ text: warrantyChipText(daysLeft), tone: 'warn' }}
                onPress={() => router.push({ pathname: '/device/[id]', params: { id: String(device.id) } })}
              />
            ))}
            {previewOf(warrantySoon).hidden > 0 ? (
              <ReminderMoreRow total={warrantySoon.length} onPress={() => openGroup('warranty')} />
            ) : null}
          </ReminderCard>
        </>
      ) : null}

      {loaded && attention === 0 ? (
        <Card style={dash.allGood}>
          <Ionicons name="checkmark-circle-outline" size={28} color={colors.ok} />
          <Text style={dash.allGoodText}>
            {products.length === 0
              ? home
                ? '还没有录入东西。去「食品」「日用品」扫码入库，或在「设备」里登记家电和数码产品。'
                : '还没有录入东西。去「食品」「日用品」扫码入库，或在「设备」里登记电脑和配件。'
              : '没有过期、快到期或库存不足的东西。'}
          </Text>
        </Card>
      ) : null}
    </Screen>
  );
}

/** 常用入口（盘点、报表）：白底圆角小块，上面图标、下面文字 */
function Shortcut({ title, icon, onPress }: { title: string; icon: IconName; onPress: () => void }) {
  const colors = useColors();
  const dash = useDashStyles();
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

/** 统计小方块：有数时用这个状态的浅色做底、深色写数字，点了滚到下面对应的一组；是 0 时白底灰字，不能点（下面也没有这一组） */
function Tile({
  label,
  value,
  tone,
  inOneRow,
  onPress,
}: {
  label: string;
  value: number;
  tone: Tone;
  inOneRow: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const dash = useDashStyles();
  const palette = toneColors(colors, tone);
  const active = value > 0;
  const boxStyle = [dash.tile, inOneRow ? dash.tileOneRow : dash.tileTwoColumns, active && { backgroundColor: palette.bg }];
  const content = (
    <>
      <Text style={[dash.tileValue, { color: active ? palette.fg : colors.faint }]}>{value}</Text>
      <Text style={dash.tileLabel}>{label}</Text>
    </>
  );
  if (!active) return <View style={boxStyle}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value}`}
      onPress={onPress}
      style={({ pressed }) => [...boxStyle, pressed && dash.tilePressed]}
    >
      {content}
    </Pressable>
  );
}

/** 已过期、快到期一组：前几样 + 「查看全部」 */
function ExpirySection({
  group,
  entries,
  today,
  tone,
}: {
  group: 'expired' | 'expiring';
  entries: ExpiryEntry[];
  today: string;
  tone: Tone;
}) {
  if (!entries.length) return null;
  const showKind = showKindFor(entries);
  const { shown, hidden } = previewOf(entries);
  return (
    <>
      <SectionTitle title={REMINDER_GROUP_TITLES[group]} />
      <ReminderCard>
        {shown.map((entry, index) => {
          const text = expiryRowText(entry, today, showKind);
          return (
            <ReminderRow
              key={`${entry.product.id ?? entry.name}-${entry.expiryDate}-${group}`}
              first={index === 0}
              title={entry.name}
              subtitle={text.subtitle}
              chip={{ text: text.chip, tone }}
              onPress={() => openProduct(entry.product)}
            />
          );
        })}
        {hidden > 0 ? <ReminderMoreRow total={entries.length} onPress={() => openGroup(group)} /> : null}
      </ReminderCard>
    </>
  );
}

const useDashStyles = makeStyles((colors) => ({
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
  // 按下时稍微变暗，表示能点
  tilePressed: { opacity: 0.7 },
  tileOneRow: { flexBasis: '22%' },
  tileValue: { fontSize: font.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tileLabel: { fontSize: font.small, color: colors.muted },
  next: { fontSize: font.small, color: colors.muted, lineHeight: 19 },
  allGood: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  allGoodText: { flex: 1, fontSize: font.small, color: colors.muted, lineHeight: 20 },
}));
