import Constants from 'expo-constants';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';

import { TimeField } from '../../components/DateField';
import { Button, Card, Label, MultiChips, Screen, SectionTitle, Segmented, Sheet, Stepper, SwitchRow } from '../../components/ui';
import { listDevices } from '../../db/devices';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type AppSettings } from '../../db/settings';
import { listProducts } from '../../db/stock';
import { useFocusData } from '../../hooks/useFocusData';
import { ALL_SCOPES, SCOPE_LABEL, type BackupData, type BackupScope, type BackupSummary } from '../../lib/backup';
import { formatDateTime } from '../../lib/dates';
import { exportBackup, importBackup, pickBackup, readUndoSnapshot, undoLastImport } from '../../lib/dataTransfer';
import {
  getPermissionState,
  requestPermission,
  rescheduleReminders,
  sendTestNotification,
  type PermissionState,
} from '../../lib/notifications';
import { colors, font } from '../../theme';

type Counts = Pick<BackupSummary, 'food' | 'daily' | 'devices'>;

/** 某个分类的说法：「食品 3 种」「提醒设置」。 */
function describeScopeItem(scope: BackupScope, counts: Counts): string {
  return scope === 'settings' ? SCOPE_LABEL.settings : `${SCOPE_LABEL[scope]} ${counts[scope]} 种`;
}

/** 列出所选分类：「食品 3 种、设备 1 种、提醒设置」。 */
function describeSummary(counts: Counts, scope: readonly BackupScope[] = ['food', 'daily', 'devices']): string {
  return ALL_SCOPES.filter((item) => scope.includes(item))
    .map((item) => describeScopeItem(item, counts))
    .join('、');
}

/** 导入时会被替换掉的手机上的数据：「食品（现有 8 种）、提醒设置」。 */
function describeReplaced(scope: readonly BackupScope[], counts: Counts): string {
  return ALL_SCOPES.filter((item) => scope.includes(item))
    .map((item) => (item === 'settings' ? SCOPE_LABEL.settings : `${SCOPE_LABEL[item]}（现有 ${counts[item]} 种）`))
    .join('、');
}

type PendingImport = { fileName: string; data: BackupData; summary: BackupSummary };
type DataNotice = { text: string; tone: 'ok' | 'error' };

const REPEAT_OPTIONS = [
  { value: 1, label: '每天' },
  { value: 2, label: '每2天' },
  { value: 3, label: '每3天' },
  { value: 7, label: '每周' },
];

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const loader = useCallback(async () => {
    const [settings, permission, products, devices, undo] = await Promise.all([
      getSettings(db),
      getPermissionState().catch((): PermissionState => 'undetermined'),
      listProducts(db),
      listDevices(db),
      readUndoSnapshot().catch(() => null),
    ]);
    return {
      settings,
      permission,
      foodCount: products.filter((product) => product.kind === 'food').length,
      dailyCount: products.filter((product) => product.kind === 'daily').length,
      deviceCount: devices.length,
      undo: undo?.summary ?? null,
    };
  }, [db]);
  const [data, reload] = useFocusData(loader, {
    settings: DEFAULT_SETTINGS,
    permission: 'granted' as PermissionState,
    foodCount: 0,
    dailyCount: 0,
    deviceCount: 0,
    undo: null as BackupSummary | null,
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dataNotice, setDataNotice] = useState<DataNotice | null>(null);
  const [busy, setBusy] = useState<'export' | 'pick' | 'import' | 'undo' | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [exportScope, setExportScope] = useState<BackupScope[]>(ALL_SCOPES);
  const [importScope, setImportScope] = useState<BackupScope[]>([]);
  const current = settings ?? data.settings;
  const phoneCounts: Counts = { food: data.foodCount, daily: data.dailyCount, devices: data.deviceCount };

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

  async function runExport() {
    setBusy('export');
    setDataNotice(null);
    try {
      const summary = await exportBackup(db, exportScope);
      setDataNotice({
        text: `已生成备份（${describeSummary(summary, summary.scope)}）。没存好的话可以再导一次。`,
        tone: 'ok',
      });
    } catch (error) {
      setDataNotice({ text: error instanceof Error ? error.message : '导出失败，请重试', tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function runPick() {
    setBusy('pick');
    setDataNotice(null);
    try {
      const picked = await pickBackup();
      if (!picked) return;
      if (!picked.result.ok) {
        setDataNotice({ text: `没法导入「${picked.fileName}」：${picked.result.error}`, tone: 'error' });
        return;
      }
      setPending({ fileName: picked.fileName, data: picked.result.data, summary: picked.result.summary });
      setImportScope(picked.result.summary.scope);
    } catch (error) {
      setDataNotice({ text: error instanceof Error ? error.message : '选文件时出错了，请重试', tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!pending) return;
    setBusy('import');
    try {
      await importBackup(db, pending.data, importScope);
      setPending(null);
      setSettings(null);
      setDataNotice({
        text: `已导入（${describeSummary(pending.summary, importScope)}），没选的分类没动。导入前的数据留了一份，可以撤销。`,
        tone: 'ok',
      });
      await reload();
    } catch (error) {
      setPending(null);
      setDataNotice({
        text: `导入失败，手机上的数据没有改动。${error instanceof Error ? error.message : ''}`,
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  }

  function confirmUndo() {
    if (!data.undo) return;
    Alert.alert('撤销上次导入？', `会换回导入前的数据（${describeSummary(data.undo)}），导入之后新记的东西会丢掉。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '撤销导入',
        style: 'destructive',
        onPress: async () => {
          setBusy('undo');
          try {
            const restored = await undoLastImport(db);
            setSettings(null);
            setDataNotice(
              restored ? { text: '已换回导入前的数据。', tone: 'ok' } : { text: '找不到导入前的数据。', tone: 'error' },
            );
            await reload();
          } catch {
            setDataNotice({ text: '撤销失败，手机上的数据没有改动。', tone: 'error' });
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
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

      <SectionTitle title="导入导出" />
      <Card>
        <Text style={setStyles.hint}>
          数据只存在这台手机上。导出会生成一个备份文件（.json），可以存到「文件」、网盘或发给自己；换手机时在新手机上导入它。
          可以只导出、只导入其中几类。
        </Text>
        <View style={setStyles.group}>
          <Label>导出哪些</Label>
          <MultiChips
            options={ALL_SCOPES.map((item) => ({ value: item, label: describeScopeItem(item, phoneCounts) }))}
            values={exportScope}
            onChange={setExportScope}
          />
        </View>
        <View style={setStyles.row}>
          <Button
            title={exportScope.length === ALL_SCOPES.length ? '导出全部' : '导出所选'}
            icon="share-outline"
            compact
            loading={busy === 'export'}
            disabled={(busy !== null && busy !== 'export') || exportScope.length === 0}
            onPress={() => runExport()}
          />
          <Button
            title="从备份导入"
            icon="download-outline"
            compact
            variant="secondary"
            loading={busy === 'pick'}
            disabled={busy !== null && busy !== 'pick'}
            onPress={() => runPick()}
          />
        </View>
        {dataNotice ? (
          <Text style={[setStyles.hint, { color: dataNotice.tone === 'ok' ? colors.ok : colors.danger }]}>
            {dataNotice.text}
          </Text>
        ) : null}
        {data.undo ? (
          <View style={setStyles.undo}>
            <Text style={setStyles.hint}>
              {formatDateTime(data.undo.exportedAt)} 导入过一次备份，导入前的全部数据（{describeSummary(data.undo)}）还留着。
            </Text>
            <View style={setStyles.row}>
              <Button
                title="撤销上次导入"
                icon="arrow-undo-outline"
                compact
                variant="ghost"
                loading={busy === 'undo'}
                disabled={busy !== null && busy !== 'undo'}
                onPress={confirmUndo}
              />
            </View>
          </View>
        ) : null}
      </Card>

      {pending ? (
        <Sheet visible title="确认导入" onClose={() => (busy === 'import' ? undefined : setPending(null))}>
          <Card>
            <Text style={setStyles.body} numberOfLines={2}>
              {pending.fileName}
            </Text>
            <Text style={setStyles.hint}>备份时间：{formatDateTime(pending.summary.exportedAt)}</Text>
            <Text style={setStyles.body}>备份里有：{describeSummary(pending.summary, pending.summary.scope)}</Text>
            <Text style={setStyles.hint}>
              含 {pending.summary.batches} 个批次、{pending.summary.movements} 条出入库记录、
              {pending.summary.assignments} 条设备领用记录。
            </Text>
          </Card>
          <View style={setStyles.group}>
            <Label>导入哪些</Label>
            <MultiChips
              options={pending.summary.scope.map((item) => ({
                value: item,
                label: describeScopeItem(item, pending.summary),
              }))}
              values={importScope}
              onChange={setImportScope}
            />
          </View>
          <Text style={setStyles.warning}>
            {importScope.length
              ? `会替换手机上的：${describeReplaced(importScope, phoneCounts)}。没选的分类不动。替换前会自动留一份，导错了可以撤销。`
              : '至少选一类。'}
          </Text>
          <View style={setStyles.row}>
            <Button
              title="取消"
              variant="secondary"
              style={setStyles.flex}
              disabled={busy === 'import'}
              onPress={() => setPending(null)}
            />
            <Button
              title="替换并导入"
              style={setStyles.flex}
              loading={busy === 'import'}
              disabled={importScope.length === 0}
              onPress={() => runImport()}
            />
          </View>
        </Sheet>
      ) : null}

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
  undo: { gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: 10 },
  warning: { fontSize: font.small, color: colors.warn, lineHeight: 20 },
  flex: { flex: 1 },
});
