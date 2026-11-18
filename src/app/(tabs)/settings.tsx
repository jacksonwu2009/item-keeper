import Constants from 'expo-constants';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';

import { TimeField } from '../../components/DateField';
import { IntegerField } from '../../components/NumberField';
import { OfficeManager } from '../../components/OfficeManager';
import { Button, Card, Label, MultiChips, Screen, SectionTitle, Segmented, Sheet, SwitchRow } from '../../components/ui';
import { listDevices } from '../../db/devices';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type AppSettings } from '../../db/settings';
import { listProducts } from '../../db/stock';
import { listOpenStocktakeScopes } from '../../db/stocktake';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { ALL_SCOPES, SCOPE_LABEL, type BackupData, type BackupScope, type BackupSummary } from '../../lib/backup';
import { formatDateTime } from '../../lib/dates';
import { exportBackup, importBackup, pickBackup, readUndoSnapshot, undoLastImport } from '../../lib/dataTransfer';
import { stocktakesClearedByImport, type OpenStocktakeScope } from '../../lib/stocktake';
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

/** 导入时会被替换掉的某个办公点的数据：「食品（现有 8 种）、设备（现有 3 种）」。 */
function describeReplaced(scope: readonly BackupScope[], counts: Counts): string {
  return ALL_SCOPES.filter((item) => scope.includes(item) && item !== 'settings')
    .map((item) => `${SCOPE_LABEL[item as Exclude<BackupScope, 'settings'>]}（现有 ${counts[item as keyof Counts]} 种）`)
    .join('、');
}

const EMPTY_COUNTS: Counts = { food: 0, daily: 0, devices: 0 };

function addCounts(a: Counts, b: Counts): Counts {
  return { food: a.food + b.food, daily: a.daily + b.daily, devices: a.devices + b.devices };
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
  const office = useOffice();
  const loader = useCallback(async () => {
    const [settings, permission, products, devices, undo, openStocktakes] = await Promise.all([
      getSettings(db),
      getPermissionState().catch((): PermissionState => 'undetermined'),
      listProducts(db),
      listDevices(db),
      readUndoSnapshot().catch(() => null),
      listOpenStocktakeScopes(db),
    ]);
    // 每个办公点各有多少：导出、导入时按办公点显示
    const officeCounts: Record<number, Counts> = {};
    const bump = (officeId: number, key: keyof Counts) => {
      officeCounts[officeId] = { ...(officeCounts[officeId] ?? EMPTY_COUNTS) };
      officeCounts[officeId][key] += 1;
    };
    for (const product of products) bump(product.officeId, product.kind);
    for (const device of devices) bump(device.officeId, 'devices');
    return {
      settings,
      permission,
      foodCount: products.filter((product) => product.kind === 'food').length,
      dailyCount: products.filter((product) => product.kind === 'daily').length,
      deviceCount: devices.length,
      officeCounts,
      undo: undo?.summary ?? null,
      openStocktakes,
    };
  }, [db]);
  const [data, reload] = useFocusData(loader, {
    settings: DEFAULT_SETTINGS,
    permission: 'granted' as PermissionState,
    foodCount: 0,
    dailyCount: 0,
    deviceCount: 0,
    officeCounts: {} as Record<number, Counts>,
    undo: null as BackupSummary | null,
    openStocktakes: [] as OpenStocktakeScope[],
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dataNotice, setDataNotice] = useState<DataNotice | null>(null);
  const [busy, setBusy] = useState<'export' | 'pick' | 'import' | 'undo' | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [exportScope, setExportScope] = useState<BackupScope[]>(ALL_SCOPES);
  /** null 表示还没手动选过：默认是当前办公点（看全部时是全部） */
  const [exportOfficeIds, setExportOfficeIds] = useState<number[] | null>(null);
  const [importScope, setImportScope] = useState<BackupScope[]>([]);
  const [importOffices, setImportOffices] = useState<string[]>([]);
  const current = settings ?? data.settings;
  const countsOf = (officeId: number | undefined) => (officeId === undefined ? EMPTY_COUNTS : data.officeCounts[officeId] ?? EMPTY_COUNTS);

  const allOfficeIds = office.offices.map((item) => item.id);
  const chosenExportOffices = (
    exportOfficeIds ?? (office.filterId !== null ? [office.filterId] : allOfficeIds)
  ).filter((id) => allOfficeIds.includes(id));
  const exportAllOffices = chosenExportOffices.length === allOfficeIds.length;
  const exportCounts = chosenExportOffices.reduce((sum, id) => addCounts(sum, countsOf(id)), EMPTY_COUNTS);
  const localOfficeId = (name: string) => office.offices.find((item) => item.name === name)?.id;

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
      const summary = await exportBackup(db, exportScope, exportAllOffices ? null : chosenExportOffices);
      const where = office.multiple && !exportAllOffices ? `${summary.offices.map((item) => item.name).join('、')}：` : '';
      setDataNotice({
        text: `已生成备份（${where}${describeSummary(summary, summary.scope)}）。没存好的话可以再导一次。`,
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
      setImportOffices(picked.result.data.offices);
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
      const { undoSaved } = await importBackup(db, pending.data, { scope: importScope, offices: importOffices });
      setPending(null);
      setSettings(null);
      setDataNotice(
        undoSaved
          ? { text: '已导入，没选的办公点和分类没动。导入前的数据留了一份，可以撤销。', tone: 'ok' }
          : {
              text: '已导入，没选的办公点和分类没动。但导入前的数据没能留底（手机存储可能满了），这次撤销不了。',
              tone: 'error',
            },
      );
      await Promise.all([reload(), office.reload()]);
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
    // 撤销会重建全部物品和设备，进行中的盘点对不上了，都会清掉
    const stocktakeNote = data.openStocktakes.length
      ? `进行中的盘点也会清掉（已录的实盘数不保留）。`
      : '';
    Alert.alert('撤销上次导入？', `会换回导入前的数据（${describeSummary(data.undo)}），导入之后新记的东西会丢掉。${stocktakeNote}`, [
      { text: '取消', style: 'cancel' },
      {
        text: '撤销导入',
        style: 'destructive',
        onPress: async () => {
          setBusy('undo');
          try {
            const restored = await undoLastImport(db);
            setSettings(null);
            await office.reload();
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
      <SectionTitle title="办公点" />
      <OfficeManager />

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
          <IntegerField
            label="到期前几天开始提醒"
            value={current.expiryLeadDays}
            onChange={(value) => (value === null ? undefined : update({ expiryLeadDays: value }))}
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
          <IntegerField
            label="新物品默认库存下限"
            value={current.defaultLowStockThreshold}
            onChange={(value) => (value === null ? undefined : update({ defaultLowStockThreshold: value }))}
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
          数据只存在这台手机上。导出会生成一个文件（.json），用微信、TypeX、隔空投送等发给别的手机，对方在这里导入；换手机、备份也用它。
          {office.multiple ? '每个办公点由一台手机负责记，定期把自己办公点导出发给汇总的人，对方导入时只替换这个办公点。' : ''}
        </Text>
        {office.multiple ? (
          <View style={setStyles.group}>
            <Label>导出哪些办公点</Label>
            <MultiChips
              options={office.offices.map((item) => ({ value: String(item.id), label: item.name }))}
              values={chosenExportOffices.map(String)}
              onChange={(values) => setExportOfficeIds(values.map(Number))}
            />
          </View>
        ) : null}
        <View style={setStyles.group}>
          <Label>导出哪些分类</Label>
          <MultiChips
            options={ALL_SCOPES.map((item) => ({ value: item, label: describeScopeItem(item, exportCounts) }))}
            values={exportScope}
            onChange={setExportScope}
          />
        </View>
        <View style={setStyles.row}>
          <Button
            title={exportScope.length === ALL_SCOPES.length && exportAllOffices ? '导出全部' : '导出所选'}
            icon="share-outline"
            compact
            loading={busy === 'export'}
            disabled={
              (busy !== null && busy !== 'export') || exportScope.length === 0 || chosenExportOffices.length === 0
            }
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
            {pending.summary.offices.map((item) => (
              <Text key={item.name} style={setStyles.body}>
                {item.name}：{describeSummary(item, pending.summary.scope)}
              </Text>
            ))}
            <Text style={setStyles.hint}>
              含 {pending.summary.batches} 个批次、{pending.summary.movements} 条出入库记录、
              {pending.summary.assignments} 条设备领用记录。
            </Text>
          </Card>
          {pending.data.offices.length > 1 ? (
            <View style={setStyles.group}>
              <Label>导入哪些办公点</Label>
              <MultiChips
                options={pending.data.offices.map((name) => ({ value: name, label: name }))}
                values={importOffices}
                onChange={setImportOffices}
              />
            </View>
          ) : null}
          <View style={setStyles.group}>
            <Label>导入哪些分类</Label>
            <MultiChips
              options={pending.summary.scope.map((item) => ({
                value: item,
                label: SCOPE_LABEL[item],
              }))}
              values={importScope}
              onChange={setImportScope}
            />
          </View>
          <Text style={setStyles.warning}>
            {importPlanText({
              scope: importScope,
              fileOffices: pending.data.offices,
              chosenOffices: importOffices,
              countsOf: (name) => countsOf(localOfficeId(name)),
              exists: (name) => localOfficeId(name) !== undefined,
              clearedStocktakes: stocktakesClearedByImport(data.openStocktakes, {
                offices: pending.data.offices.filter((name) => importOffices.includes(name)),
                scope: importScope.filter((item) => pending.summary.scope.includes(item)),
              }),
            })}
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
              disabled={
                importScope.length === 0 ||
                (importOffices.length === 0 && importScope.some((item) => item !== 'settings'))
              }
              onPress={() => runImport()}
            />
          </View>
        </Sheet>
      ) : null}

      <Text style={setStyles.footer}>物品管家 {Constants.expoConfig?.version ?? ''}</Text>
    </Screen>
  );
}

/** 导入前告诉用户会替换掉本机的哪些东西。 */
function importPlanText({
  scope,
  fileOffices,
  chosenOffices,
  countsOf,
  exists,
  clearedStocktakes,
}: {
  scope: BackupScope[];
  fileOffices: string[];
  chosenOffices: string[];
  countsOf: (name: string) => Counts;
  exists: (name: string) => boolean;
  /** 这次导入会清掉进行中盘点的办公点 */
  clearedStocktakes: string[];
}): string {
  if (!scope.length) return '至少选一类。';
  const dataScope = scope.filter((item) => item !== 'settings');
  const names = fileOffices.filter((name) => chosenOffices.includes(name));
  if (dataScope.length && !names.length) return '至少选一个办公点。';
  const parts: string[] = [];
  if (dataScope.length) {
    for (const name of names) {
      parts.push(exists(name) ? `${name}的${describeReplaced(dataScope, countsOf(name))}` : `${name}（本机还没有，会新建）`);
    }
  }
  if (scope.includes('settings')) parts.push('提醒设置');
  const stocktakeNote = clearedStocktakes.length
    ? `会清掉${clearedStocktakes.map((name) => `「${name}」`).join('、')}进行中的盘点（已录的实盘数不保留）。`
    : '';
  return `会替换本机的：${parts.join('；')}。没选的办公点和分类不动。${stocktakeNote}替换前会自动留一份，导错了可以撤销。`;
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
