import Constants from 'expo-constants';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Linking, Share, StyleSheet, Text, View } from 'react-native';

import { TimeField } from '../../components/DateField';
import { Button, Card, Label, Screen, SectionTitle, Segmented, Stepper, SwitchRow } from '../../components/ui';
import { listAssignments, listDevices } from '../../db/devices';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type AppSettings } from '../../db/settings';
import { listBatches, listProducts } from '../../db/stock';
import { useFocusData } from '../../hooks/useFocusData';
import { todayStr } from '../../lib/dates';
import {
  getPermissionState,
  requestPermission,
  rescheduleReminders,
  sendTestNotification,
  type PermissionState,
} from '../../lib/notifications';
import { colors, font } from '../../theme';

const REPEAT_OPTIONS = [
  { value: 1, label: '每天' },
  { value: 2, label: '每2天' },
  { value: 3, label: '每3天' },
  { value: 7, label: '每周' },
];

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const loader = useCallback(async () => {
    const [settings, permission, products, devices] = await Promise.all([
      getSettings(db),
      getPermissionState().catch((): PermissionState => 'undetermined'),
      listProducts(db),
      listDevices(db),
    ]);
    return {
      settings,
      permission,
      foodCount: products.filter((product) => product.kind === 'food').length,
      dailyCount: products.filter((product) => product.kind === 'daily').length,
      deviceCount: devices.length,
    };
  }, [db]);
  const [data, reload] = useFocusData(loader, {
    settings: DEFAULT_SETTINGS,
    permission: 'granted' as PermissionState,
    foodCount: 0,
    dailyCount: 0,
    deviceCount: 0,
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = settings ?? data.settings;

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

  async function exportBackup() {
    const products = await listProducts(db);
    const devices = await listDevices(db);
    const backup = {
      app: 'item-keeper',
      exportedAt: new Date().toISOString(),
      settings: current,
      products: await Promise.all(
        products.map(async (product) => ({ ...product, batches: await listBatches(db, product.id) })),
      ),
      devices: await Promise.all(
        devices.map(async (device) => ({ ...device, assignments: await listAssignments(db, device.id) })),
      ),
    };
    await Share.share({ title: `物品管家备份 ${todayStr()}`, message: JSON.stringify(backup, null, 2) });
  }

  return (
    <Screen>
      <SectionTitle title="提醒" />
      <Card>
        <SwitchRow
          title="到期提醒"
          description="食品、日用品快到期和已过期时提醒"
          value={current.expiryEnabled}
          onChange={(value) => update({ expiryEnabled: value })}
        />
        <SwitchRow
          title="库存提醒"
          description="库存降到下限时提醒补货"
          value={current.lowStockEnabled}
          onChange={(value) => update({ lowStockEnabled: value })}
        />
        <View style={setStyles.group}>
          <Label>到期前几天开始提醒</Label>
          <Stepper
            value={current.expiryLeadDays}
            onChange={(value) => update({ expiryLeadDays: value })}
            min={0}
            max={90}
            suffix="天"
          />
          <Text style={setStyles.hint}>单个物品可以在编辑页里另设天数。</Text>
        </View>
        <View style={setStyles.group}>
          <Label>多久提醒一次</Label>
          <Segmented
            options={REPEAT_OPTIONS}
            value={current.repeatEveryDays}
            onChange={(value) => update({ repeatEveryDays: value })}
          />
          <Text style={setStyles.hint}>问题没处理之前按这个间隔重复提醒；到期当天一定会提醒。</Text>
        </View>
        <TimeField
          label="提醒时间"
          hour={current.reminderHour}
          minute={current.reminderMinute}
          onChange={(hour, minute) => update({ reminderHour: hour, reminderMinute: minute })}
        />
      </Card>

      <SectionTitle title="通知权限" />
      <Card>
        <Text style={setStyles.body}>
          {data.permission === 'granted'
            ? '通知已开启。'
            : data.permission === 'denied'
              ? '通知被关掉了，需要去系统设置里打开。'
              : '还没允许通知，提醒发不出来。'}
        </Text>
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
      <Card>
        <View style={setStyles.group}>
          <Label>新物品默认库存下限</Label>
          <Stepper
            value={current.defaultLowStockThreshold}
            onChange={(value) => update({ defaultLowStockThreshold: value })}
            min={0}
            max={99}
          />
        </View>
        <SwitchRow
          title="扫码后联网查商品名"
          description="只把条码发给 Open Food Facts 开放商品库；国产商品可能查不到，手填一次后本机就记住了。"
          value={current.onlineLookup}
          onChange={(value) => update({ onlineLookup: value })}
        />
      </Card>

      <SectionTitle title="数据" />
      <Card>
        <Text style={setStyles.body}>
          食品 {data.foodCount} 种 · 日用品 {data.dailyCount} 种 · 设备 {data.deviceCount} 种
        </Text>
        <Text style={setStyles.hint}>数据只存在这台手机上。换手机或卸载前，先导出一份备份。</Text>
        <View style={setStyles.row}>
          <Button title="导出备份" icon="share-outline" compact variant="secondary" onPress={() => exportBackup().catch(() => undefined)} />
        </View>
      </Card>

      <Text style={setStyles.footer}>物品管家 {Constants.expoConfig?.version ?? ''}</Text>
    </Screen>
  );
}

const setStyles = StyleSheet.create({
  group: { gap: 8 },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  body: { fontSize: font.body, color: colors.ink },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  footer: { fontSize: font.small, color: colors.faint, textAlign: 'center', marginTop: 8 },
});
