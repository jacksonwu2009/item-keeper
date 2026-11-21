import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { describeLastExport } from '../../../components/BackupManager';
import { TimePickerSheet } from '../../../components/DateField';
import { IntegerField } from '../../../components/NumberField';
import { Footnote, ListCard, ListRow, ToggleRow } from '../../../components/ListRows';
import { Button, Card, Screen, SectionTitle, Segmented, Sheet } from '../../../components/ui';
import { DEFAULT_SETTINGS, getLastExportAt, getSettings, saveSettings, type AppSettings } from '../../../db/settings';
import { useFocusData } from '../../../hooks/useFocusData';
import { useOffice } from '../../../hooks/useOffice';
import { formatTime } from '../../../lib/dates';
import {
  getPermissionState,
  requestPermission,
  rescheduleReminders,
  sendTestNotification,
  type PermissionState,
} from '../../../lib/notifications';
import { colors, font } from '../../../theme';

const REPEAT_OPTIONS = [
  { value: 1, label: '每天' },
  { value: 2, label: '每2天' },
  { value: 3, label: '每3天' },
  { value: 7, label: '每周' },
];

/** 「多久提醒一次」一行右边：选项里有的用选项的说法，别的天数（比如导入来的）写「每 N 天」 */
function repeatLabel(days: number): string {
  return REPEAT_OPTIONS.find((option) => option.value === days)?.label ?? `每 ${days} 天`;
}

/** 「到期前几天开始提醒」一行右边：0 天就是到期当天（和鸿蒙版一样的说法） */
function expiryLeadSummary(days: number): string {
  return days > 0 ? `到期前 ${days} 天` : '到期当天';
}

/** 备份提醒一行右边：0 是不提醒（和鸿蒙版一样的说法） */
function backupReminderSummary(days: number): string {
  return days > 0 ? `超过 ${days} 天提醒` : '不提醒';
}

const EXPIRY_LEAD_HINT = '单个物品可以在编辑页里另设天数。';
const REPEAT_HINT = '问题没处理之前按这个间隔重复提醒；到期当天一定会提醒。';
const BACKUP_REMINDER_HINT = '填 0 不提醒。在「导入导出」里分类、办公点都全选，点「导出全部」导出才算备份过。';

/** 点一行打开的改值面板：到期前几天、多久提醒一次、提醒时间、备份提醒天数、新物品默认库存下限 */
type ValueSheet = 'expiryLead' | 'repeat' | 'time' | 'backupDays' | 'lowStock';

/**
 * 设置页，结构照鸿蒙版 SettingsTab：一项一行，开关在行内，数值、频率、时间点开底部面板改（面板里还是原来的输入框、分段、时间框，
 * 改了马上存，和原来一样）；办公点、导入导出各是一行，点进单独的页面。
 * 分组顺序：办公点 → 提醒 → 通知 → 录入 → 数据。
 */
export default function SettingsScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const loader = useCallback(async () => {
    const [settings, permission, lastExportAt] = await Promise.all([
      getSettings(db),
      getPermissionState().catch((): PermissionState => 'undetermined'),
      getLastExportAt(db),
    ]);
    return { settings, permission, lastExportAt };
  }, [db]);
  const [data, reload] = useFocusData(loader, {
    settings: DEFAULT_SETTINGS,
    permission: 'granted' as PermissionState,
    lastExportAt: null as string | null,
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // 重新读到设置时（回到这页；导入导出页导入了提醒设置也会换掉库里的值），丢掉本页刚改时记的值，以库里读到的为准。
  // 原来导入在本页里做，导入完直接清掉；挪到单独的页面后改成在这里清
  const [loadedSettings, setLoadedSettings] = useState(data.settings);
  if (loadedSettings !== data.settings) {
    setLoadedSettings(data.settings);
    setSettings(null);
  }
  const [notice, setNotice] = useState<string | null>(null);
  const [valueSheet, setValueSheet] = useState<ValueSheet | null>(null);
  const current = settings ?? data.settings;
  /** 到期提醒、库存提醒至少开着一个：「多久提醒一次」「提醒时间」才用得上 */
  const reminderOn = current.expiryEnabled || current.lowStockEnabled;

  async function update(patch: Partial<AppSettings>) {
    setSettings({ ...current, ...patch });
    await saveSettings(db, patch);
    rescheduleReminders(db).catch(() => undefined);
  }

  async function enableNotifications() {
    const state = await requestPermission();
    if (state === 'denied') await Linking.openSettings();
    await rescheduleReminders(db).catch(() => undefined);
    await reload();
  }

  const closeSheet = () => setValueSheet(null);

  return (
    <Screen largeTitle>
      <SectionTitle title="办公点" />
      <ListCard>
        <ListRow
          title="管理办公点"
          subtitle="食品、日用品、设备都归到某个办公点下"
          value={`${office.offices.length} 个`}
          chevron
          onPress={() => router.push('/offices')}
        />
      </ListCard>

      {/* 每个开关下面只放它自己的设置：关掉就收起来，库存提醒没有自己的设置，下面不接别的行 */}
      <SectionTitle title="提醒" />
      <ListCard>
        <ToggleRow
          title="到期提醒"
          description="食品、日用品快到期和已过期时提醒"
          value={current.expiryEnabled}
          onChange={(value) => update({ expiryEnabled: value })}
        />
        {current.expiryEnabled ? (
          <ListRow
            title="到期前几天开始提醒"
            subtitle={EXPIRY_LEAD_HINT}
            value={expiryLeadSummary(current.expiryLeadDays)}
            chevron
            onPress={() => setValueSheet('expiryLead')}
          />
        ) : null}
        <ToggleRow
          title="库存提醒"
          description="库存降到下限时提醒补货"
          value={current.lowStockEnabled}
          onChange={(value) => update({ lowStockEnabled: value })}
        />
      </ListCard>

      {/* 多久一次、几点提醒是到期提醒和库存提醒共用的：单独一组，两个都关着时整组不显示 */}
      {reminderOn ? (
        <>
          <SectionTitle title="什么时候提醒" />
          <View style={setStyles.group}>
            <ListCard>
              <ListRow
                title="多久提醒一次"
                value={repeatLabel(current.repeatEveryDays)}
                chevron
                onPress={() => setValueSheet('repeat')}
              />
              <ListRow
                title="提醒时间"
                value={formatTime(current.reminderHour, current.reminderMinute)}
                chevron
                onPress={() => setValueSheet('time')}
              />
            </ListCard>
            <Footnote>{REPEAT_HINT}</Footnote>
          </View>
        </>
      ) : null}

      <SectionTitle title="通知" />
      <Card>
        <View style={setStyles.permissionRow}>
          <Ionicons
            name={data.permission === 'granted' ? 'notifications-outline' : 'warning-outline'}
            size={18}
            color={data.permission === 'granted' ? colors.ok : colors.warn}
          />
          <Text style={setStyles.body}>
            {data.permission === 'granted'
              ? '通知已开启。'
              : data.permission === 'denied'
                ? '通知被关掉了，需要去系统设置里打开。'
                : '还没允许通知，提醒发不出来。'}
          </Text>
        </View>
        <View style={setStyles.row}>
          {data.permission !== 'granted' ? (
            <Button
              title={data.permission === 'denied' ? '去系统设置' : '开启通知'}
              compact
              onPress={() => enableNotifications().catch(() => undefined)}
            />
          ) : (
            <Button
              title="发一条测试通知"
              compact
              variant="secondary"
              onPress={() =>
                sendTestNotification()
                  .then(() => setNotice('3 秒后会收到一条测试通知。'))
                  .catch(() => setNotice('测试通知没发出去，请检查通知权限。'))
              }
            />
          )}
        </View>
        {notice ? <Text style={setStyles.hint}>{notice}</Text> : null}
      </Card>

      <SectionTitle title="录入" />
      <ListCard>
        <ListRow
          title="新物品默认库存下限"
          value={String(current.defaultLowStockThreshold)}
          chevron
          onPress={() => setValueSheet('lowStock')}
        />
        <ToggleRow
          title="扫码后联网查商品名"
          description="只把条码发给 Open Food Facts 开放商品库；国产商品可能查不到，手填一次后本机就记住了。"
          value={current.onlineLookup}
          onChange={(value) => update({ onlineLookup: value })}
        />
      </ListCard>

      <SectionTitle title="数据" />
      <ListCard>
        <ListRow
          title="导入导出"
          subtitle={describeLastExport(data.lastExportAt)}
          chevron
          onPress={() => router.push('/backup')}
        />
        <ListRow
          title="超过几天没导出备份就提醒"
          value={backupReminderSummary(current.backupReminderDays)}
          chevron
          onPress={() => setValueSheet('backupDays')}
        />
      </ListCard>

      <Text style={setStyles.footer}>物品管家 {Constants.expoConfig?.version ?? ''}</Text>

      {/* 改值面板：里面的输入框、分段、时间框和原来设置页里的一样，改了马上存；关掉面板行上就是新值 */}
      {valueSheet === 'expiryLead' ? (
        <Sheet visible title="到期前几天开始提醒" onClose={closeSheet}>
          <IntegerField
            accessibilityLabel="到期前几天开始提醒"
            value={current.expiryLeadDays}
            onChange={(value) => (value === null ? undefined : update({ expiryLeadDays: value }))}
            min={0}
            max={90}
            suffix="天"
            hint={EXPIRY_LEAD_HINT}
          />
        </Sheet>
      ) : null}
      {valueSheet === 'repeat' ? (
        <Sheet visible title="多久提醒一次" onClose={closeSheet}>
          <View style={setStyles.group}>
            <Segmented
              options={REPEAT_OPTIONS}
              value={current.repeatEveryDays}
              onChange={(value) => update({ repeatEveryDays: value })}
            />
            <Text style={setStyles.hint}>{REPEAT_HINT}</Text>
          </View>
        </Sheet>
      ) : null}
      {/* 提醒时间：点一行直接弹时、分滚轮 */}
      {valueSheet === 'time' ? (
        <TimePickerSheet
          title="提醒时间"
          hour={current.reminderHour}
          minute={current.reminderMinute}
          onChange={(hour, minute) => update({ reminderHour: hour, reminderMinute: minute })}
          onClose={closeSheet}
        />
      ) : null}
      {valueSheet === 'backupDays' ? (
        <Sheet visible title="超过几天没导出备份就提醒" onClose={closeSheet}>
          <IntegerField
            accessibilityLabel="超过几天没导出备份就提醒"
            value={current.backupReminderDays}
            onChange={(value) => (value === null ? undefined : update({ backupReminderDays: value }))}
            min={0}
            max={365}
            step={10}
            suffix="天"
            hint={BACKUP_REMINDER_HINT}
          />
        </Sheet>
      ) : null}
      {valueSheet === 'lowStock' ? (
        <Sheet visible title="新物品默认库存下限" onClose={closeSheet}>
          <IntegerField
            accessibilityLabel="新物品默认库存下限"
            value={current.defaultLowStockThreshold}
            onChange={(value) => (value === null ? undefined : update({ defaultLowStockThreshold: value }))}
            min={0}
            max={99}
          />
        </Sheet>
      ) : null}
    </Screen>
  );
}

const setStyles = StyleSheet.create({
  group: { gap: 8 },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  body: { flex: 1, fontSize: font.body, color: colors.ink },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  footer: { fontSize: font.small, color: colors.faint, textAlign: 'center', marginTop: 8 },
});
