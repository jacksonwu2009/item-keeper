import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { DateField } from '../../components/DateField';
import { ListCard, ListRow } from '../../components/ListRows';
import { IntegerField } from '../../components/NumberField';
import { needsRosterAdd, PersonPicker } from '../../components/PersonPicker';
import {
  Button,
  Card,
  Chip,
  Empty,
  Field,
  GroupCard,
  InfoRow,
  Screen,
  SectionTitle,
  Sheet,
} from '../../components/ui';
import {
  deleteAssignment,
  deleteDevice,
  getDevice,
  issueDevice,
  listAssignments,
  listAccessories,
  listPeople,
  returnDevice,
  setDeviceHolder,
  HOLDER_NAME_MAX,
  updateAssignment,
  type Device,
  type DeviceAssignment,
} from '../../db/devices';
import { ensurePerson, listPersons, PERSON_NAME_MAX, type Person } from '../../db/people';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { useScene, useTerms } from '../../hooks/useScene';
import { diffDays, formatDate, todayStr } from '../../lib/dates';
import { hasComputerConfig } from '../../lib/devicePresets';
import { rescheduleReminders } from '../../lib/notifications';
import { describeAccessories, warrantyStatus, type Accessory } from '../../lib/warranty';
import { makeStyles, useColors } from '../../hooks/useTheme';
import { font, radius } from '../../theme';

type SheetState =
  | { type: 'issue' }
  | { type: 'return'; assignment: DeviceAssignment }
  | { type: 'edit'; assignment: DeviceAssignment }
  | { type: 'holder' }
  | null;

export default function DeviceDetailScreen() {
  const colors = useColors();
  const deviceDetail = useDeviceDetailStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene, terms } = useScene();
  // 家庭场景：不登记领用、退还，只记「谁在用」（还是存成领用记录），突出购买和保修
  const home = scene === 'home';
  const { id } = useLocalSearchParams<{ id: string }>();
  const deviceId = Number(id);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loader = useCallback(async () => {
    const [device, assignments, recent, roster, accessories] = await Promise.all([
      getDevice(db, deviceId),
      listAssignments(db, deviceId),
      listPeople(db),
      listPersons(db),
      listAccessories(db, deviceId),
    ]);
    return { device, assignments, recent, roster, accessories };
  }, [db, deviceId]);
  const [{ device, assignments, recent, roster, accessories }, reload, loaded] = useFocusData(loader, {
    device: null as Device | null,
    assignments: [] as DeviceAssignment[],
    recent: [] as string[],
    roster: [] as Person[],
    accessories: [] as Accessory[],
  });

  async function afterChange(note: string) {
    setSheet(null);
    setMessage(note);
    await reload();
  }

  /** 勾了「同时加到名单」：记录存好后把这个名字加进名单（面板里已经查过长度，这里出错也不影响已存的记录） */
  async function addToRoster(name: string) {
    await ensurePerson(db, name).catch(() => undefined);
  }

  if (!loaded) return <Stack.Screen options={{ title: '' }} />;
  if (!device) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <Empty icon="help-circle-outline" title="找不到这台设备" text="可能已经被删除了。" />
      </Screen>
    );
  }

  const active = assignments.filter((assignment) => !assignment.returnedOn);
  const history = assignments.filter((assignment) => assignment.returnedOn);
  const outQty = active.reduce((sum, assignment) => sum + assignment.quantity, 0);
  const available = device.quantity - outQty;
  const today = todayStr();
  const warranty = warrantyStatus(device.warrantyUntil, today);
  const accessoryText = accessories.length ? describeAccessories(accessories) : null;
  // 信息里列不列芯片、内存、硬盘：电脑类的，或者填过其中一项
  const showConfig = hasComputerConfig(device.category) || !!device.chip || !!device.memory || !!device.storage;

  function confirmDelete() {
    if (!device) return;
    const what = home ? `「${device.name}」会被删除，不能恢复。` : `「${device.name}」和它的全部领用记录都会被删除，不能恢复。`;
    Alert.alert('删除这台设备？', what, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteDevice(db, device.id);
          rescheduleReminders(db).catch(() => undefined);
          router.back();
        },
      },
    ]);
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: device.name }} />
      <Card style={deviceDetail.summary}>
        <Text style={deviceDetail.category}>{device.category}</Text>
        <Text style={deviceDetail.title}>{device.name}</Text>
        {device.model ? <Text style={deviceDetail.sub}>型号 {device.model}</Text> : null}
        {warranty ? (
          <Chip
            text={warranty.text}
            tone={warranty.level === 'expired' ? 'danger' : warranty.level === 'soon' ? 'warn' : 'ok'}
          />
        ) : null}
        {home ? (
          device.quantity > 1 ? (
            <Text style={deviceDetail.sub}>共 {device.quantity} 件</Text>
          ) : null
        ) : (
          <>
            <View style={deviceDetail.counts}>
              <Count label="总数" value={device.quantity} />
              <Count label="借出" value={outQty} tone={outQty > 0 ? colors.info : undefined} />
              <Count label="在库" value={available} tone={available > 0 ? colors.ok : undefined} />
            </View>
            <Button
              title="登记领用"
              icon="person-add-outline"
              onPress={() => setSheet({ type: 'issue' })}
              disabled={available <= 0}
            />
            {available <= 0 ? <Text style={deviceDetail.hint}>全部借出了，有人退还后才能再领。</Text> : null}
          </>
        )}
        {message ? <Text style={deviceDetail.message}>{message}</Text> : null}
      </Card>

      {home ? (
        <ListCard>
          <ListRow
            title="谁在用"
            value={active.length ? active.map((assignment) => assignment.person).join('、') : '没填'}
            chevron
            onPress={() => setSheet({ type: 'holder' })}
          />
        </ListCard>
      ) : null}

      {home ? null : <SectionTitle title={`正在使用（${active.length}）`} />}
      {home ? null : active.length === 0 ? (
        <Card>
          <Text style={deviceDetail.empty}>没有人在用。</Text>
        </Card>
      ) : (
        <Card style={deviceDetail.listCard}>
          {active.map((assignment, index) => (
            <View key={assignment.id} style={[deviceDetail.assignRow, index > 0 && deviceDetail.divider]}>
              <Pressable style={deviceDetail.assignMain} onPress={() => setSheet({ type: 'edit', assignment })}>
                <Text style={deviceDetail.person}>
                  {assignment.person}
                  {assignment.quantity > 1 ? ` ×${assignment.quantity}` : ''}
                </Text>
                <Text style={deviceDetail.meta}>
                  {formatDate(assignment.issuedOn)} 领取 · 已用 {Math.max(0, diffDays(today, assignment.issuedOn))} 天
                </Text>
                {assignment.note ? <Text style={deviceDetail.meta}>{assignment.note}</Text> : null}
              </Pressable>
              <Button title="退还" compact variant="secondary" onPress={() => setSheet({ type: 'return', assignment })} />
            </View>
          ))}
        </Card>
      )}

      {!home && history.length > 0 ? (
        <>
          <SectionTitle title={`领用记录（${history.length}）`} />
          <Card style={deviceDetail.listCard}>
            {history.map((assignment, index) => (
              <Pressable
                key={assignment.id}
                onPress={() => setSheet({ type: 'edit', assignment })}
                style={[deviceDetail.assignRow, index > 0 && deviceDetail.divider]}
              >
                <View style={deviceDetail.assignMain}>
                  <Text style={deviceDetail.person}>
                    {assignment.person}
                    {assignment.quantity > 1 ? ` ×${assignment.quantity}` : ''}
                  </Text>
                  <Text style={deviceDetail.meta}>
                    {formatDate(assignment.issuedOn)} 领取 → {formatDate(assignment.returnedOn)} 退还
                  </Text>
                </View>
                <View style={deviceDetail.rowTag}>
                  <Chip text="已退还" tone="neutral" />
                </View>
              </Pressable>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle title="信息" />
      <GroupCard>
        {office.multiple ? <InfoRow label={terms.place} value={office.officeName(device.officeId)} /> : null}
        <InfoRow label="类别" value={device.category} />
        <InfoRow label="型号" value={device.model ?? '—'} />
        {showConfig ? <InfoRow label="芯片" value={device.chip ?? '—'} /> : null}
        {showConfig ? <InfoRow label="内存" value={device.memory ?? '—'} /> : null}
        {showConfig ? <InfoRow label="硬盘" value={device.storage ?? '—'} /> : null}
        <InfoRow label="序列号" value={device.serialNo ?? '—'} />
        <InfoRow label="购买日期" value={formatDate(device.purchaseDate)} />
        <InfoRow label="发票号" value={device.invoiceNo ?? '—'} />
        <InfoRow label="保修到期" value={device.warrantyUntil ? formatDate(device.warrantyUntil) : '没记录'} />
        <InfoRow label={device.quantity > 1 ? '配件（每件）' : '配件'} value={accessoryText ?? '没有'} />
        {device.note ? <InfoRow label="备注" value={device.note} /> : null}
      </GroupCard>

      <View style={deviceDetail.actions}>
        <Button
          title="编辑"
          icon="create-outline"
          variant="secondary"
          onPress={() => router.push({ pathname: '/device/edit/[id]', params: { id: String(device.id) } })}
          style={deviceDetail.flex}
        />
        <Button title="删除" icon="trash-outline" variant="danger" onPress={confirmDelete} style={deviceDetail.flex} />
      </View>

      {sheet?.type === 'holder' ? (
        <HolderSheet
          current={active.length === 1 ? active[0].person : ''}
          hasHolder={active.length > 0}
          roster={roster}
          recent={recent}
          onClose={() => setSheet(null)}
          onSubmit={async (person, addPerson) => {
            await setDeviceHolder(db, device.id, person);
            if (person && addPerson) await addToRoster(person);
            await afterChange(person ? `已改成：${person.trim()}在用` : '已清空谁在用');
          }}
        />
      ) : null}
      {sheet?.type === 'issue' ? (
        <AssignmentSheet
          title="登记领用"
          roster={roster}
          recent={recent}
          maxQuantity={available}
          accessoryText={accessoryText}
          onClose={() => setSheet(null)}
          onSubmit={async (input, addPerson) => {
            await issueDevice(db, device.id, input);
            if (addPerson) await addToRoster(input.person);
            await afterChange(`已登记：${input.person} 领取 ${input.quantity} 件`);
          }}
        />
      ) : null}
      {sheet?.type === 'edit' ? (
        <AssignmentSheet
          title="修改领用记录"
          roster={roster}
          recent={recent}
          maxQuantity={sheet.assignment.returnedOn ? device.quantity : available + sheet.assignment.quantity}
          initial={sheet.assignment}
          onClose={() => setSheet(null)}
          onSubmit={async (input, addPerson) => {
            await updateAssignment(db, sheet.assignment.id, input);
            if (addPerson) await addToRoster(input.person);
            await afterChange('领用记录已更新');
          }}
          onDelete={async () => {
            await deleteAssignment(db, sheet.assignment.id);
            await afterChange('领用记录已删除');
          }}
        />
      ) : null}
      {sheet?.type === 'return' ? (
        <ReturnSheet
          assignment={sheet.assignment}
          accessoryText={accessoryText}
          onClose={() => setSheet(null)}
          onSubmit={async (returnedOn, quantity) => {
            await returnDevice(db, sheet.assignment.id, returnedOn, quantity);
            await afterChange(`已登记：${sheet.assignment.person} 退还 ${quantity} 件`);
          }}
        />
      ) : null}
    </Screen>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const deviceDetail = useDeviceDetailStyles();
  return (
    <View style={deviceDetail.count}>
      <Text style={[deviceDetail.countValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={deviceDetail.countLabel}>{label}</Text>
    </View>
  );
}

/**
 * 家庭场景的「谁在用」：填个名字（或从家庭成员里点选），不用日期、不用归还；清空就是没人在用。
 * 名字不在家庭成员里时可以顺手加进去（默认勾上）。
 */
function HolderSheet({
  current,
  hasHolder,
  roster,
  recent,
  onClose,
  onSubmit,
}: {
  current: string;
  hasHolder: boolean;
  roster: Person[];
  recent: string[];
  onClose: () => void;
  /** addToRoster：保存时把这个名字一起加进家庭成员 */
  onSubmit: (person: string | null, addToRoster: boolean) => Promise<void>;
}) {
  const deviceDetail = useDeviceDetailStyles();
  const [name, setName] = useState(current);
  // 已经有人在用时先不勾「同时加到家庭成员」，要加自己勾
  const [addToRoster, setAddToRoster] = useState(!current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(person: string | null) {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(person, !!person && addToRoster && needsRosterAdd(roster, person));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '没存上，请重试');
      setBusy(false);
    }
  }

  return (
    <Sheet visible title="谁在用" onClose={onClose}>
      <Field label="名字" value={name} onChangeText={setName} placeholder="如 爸爸、孩子" maxLength={HOLDER_NAME_MAX} />
      <PersonPicker
        value={name}
        onChange={setName}
        roster={roster}
        recent={recent}
        addToRoster={addToRoster}
        onAddToRosterChange={setAddToRoster}
      />
      <Text style={deviceDetail.hint}>不用填日期，也不用归还；换人直接改名字，没人用就清空。</Text>
      {error ? <Text style={deviceDetail.error}>{error}</Text> : null}
      <View style={deviceDetail.actions}>
        <Button title="清空" variant="secondary" disabled={!hasHolder || busy} onPress={() => submit(null)} style={deviceDetail.flex} />
        <Button title="保存" loading={busy} disabled={!name.trim()} onPress={() => submit(name)} style={deviceDetail.flex} />
      </View>
    </Sheet>
  );
}

function AssignmentSheet({
  title,
  roster,
  recent,
  maxQuantity,
  accessoryText,
  initial,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  /** 员工名单 */
  roster: Person[];
  /** 最近用过的名字（名单空时列这些） */
  recent: string[];
  maxQuantity: number;
  /** 随设备一起领走的配件说明，领用时提示一下 */
  accessoryText?: string | null;
  initial?: DeviceAssignment;
  onClose: () => void;
  /** addToRoster：保存时把使用人一起加进员工名单 */
  onSubmit: (
    input: {
      person: string;
      quantity: number;
      issuedOn: string;
      returnedOn: string | null;
      note: string | null;
    },
    addToRoster: boolean,
  ) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const deviceDetail = useDeviceDetailStyles();
  const terms = useTerms();
  const [person, setPerson] = useState(initial?.person ?? '');
  // 修改已有记录时先不勾「同时加到员工名单」，要加自己勾
  const [addToRoster, setAddToRoster] = useState(!initial);
  const [quantity, setQuantity] = useState<number | null>(initial?.quantity ?? 1);
  const [issuedOn, setIssuedOn] = useState<string | null>(initial?.issuedOn ?? todayStr());
  const [returnedOn, setReturnedOn] = useState<string | null>(initial?.returnedOn ?? null);
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (!person.trim()) return setError('请填写使用人');
    if (quantity === null) return setError(`请填数量（1 到 ${Math.max(1, maxQuantity)}）`);
    if (!issuedOn) return setError('请选择领取日期');
    if (returnedOn && returnedOn < issuedOn) return setError('退还日期不能早于领取日期');
    const addPerson = addToRoster && needsRosterAdd(roster, person);
    if (addPerson && person.trim().length > PERSON_NAME_MAX) {
      return setError(`名字超过 ${PERSON_NAME_MAX} 个字，加不进${terms.roster}；可以去掉「同时加到${terms.roster}」的勾`);
    }
    setBusy(true);
    try {
      await onSubmit({ person, quantity, issuedOn, returnedOn, note: note || null }, addPerson);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible title={title} onClose={onClose}>
      {accessoryText && !initial ? (
        <View style={deviceDetail.accessoryNote}>
          <Text style={deviceDetail.accessoryNoteText}>随设备一起领走：{accessoryText}</Text>
        </View>
      ) : null}
      <Field label="使用人" required value={person} onChangeText={setPerson} placeholder="姓名或工号" />
      <PersonPicker
        value={person}
        onChange={setPerson}
        roster={roster}
        recent={recent}
        addToRoster={addToRoster}
        onAddToRosterChange={setAddToRoster}
      />
      {maxQuantity > 1 || (initial?.quantity ?? 1) > 1 ? (
        <IntegerField
          label="数量"
          value={quantity}
          onChange={setQuantity}
          min={1}
          max={Math.max(1, maxQuantity)}
          suffix="件"
          hint={`最多 ${Math.max(1, maxQuantity)} 件`}
        />
      ) : null}
      <DateField label="领取日期" required value={issuedOn} onChange={setIssuedOn} />
      {initial ? (
        <DateField
          label="退还日期"
          value={returnedOn}
          onChange={setReturnedOn}
          clearable
          placeholder="还没退还"
          minimumDate={issuedOn}
        />
      ) : null}
      <Field label="备注" value={note} onChangeText={setNote} placeholder="如 含充电器、外设" />
      {error ? <Text style={deviceDetail.error}>{error}</Text> : null}
      <View style={deviceDetail.actions}>
        {onDelete ? (
          <Button
            title="删除记录"
            variant="danger"
            style={deviceDetail.flex}
            onPress={() =>
              Alert.alert('删除这条领用记录？', '删掉后在库数量会按没领过来算。', [
                { text: '取消', style: 'cancel' },
                { text: '删除', style: 'destructive', onPress: () => onDelete() },
              ])
            }
          />
        ) : null}
        <Button title="保存" onPress={submit} loading={busy} style={deviceDetail.flex} />
      </View>
    </Sheet>
  );
}

function ReturnSheet({
  assignment,
  accessoryText,
  onClose,
  onSubmit,
}: {
  assignment: DeviceAssignment;
  /** 退还时提示核对的配件 */
  accessoryText: string | null;
  onClose: () => void;
  onSubmit: (returnedOn: string, quantity: number) => Promise<void>;
}) {
  const deviceDetail = useDeviceDetailStyles();
  const [returnedOn, setReturnedOn] = useState<string | null>(todayStr());
  const [quantity, setQuantity] = useState<number | null>(assignment.quantity);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Sheet visible title={`${assignment.person} 退还`} onClose={onClose}>
      <Text style={deviceDetail.meta}>{formatDate(assignment.issuedOn)} 领取</Text>
      {accessoryText ? (
        <View style={deviceDetail.accessoryNote}>
          <Text style={deviceDetail.accessoryNoteText}>
            请核对配件{assignment.quantity > 1 ? '（每件）' : ''}：{accessoryText}
          </Text>
        </View>
      ) : null}
      <DateField
        label="退还日期"
        required
        value={returnedOn}
        onChange={setReturnedOn}
        minimumDate={assignment.issuedOn}
      />
      {assignment.quantity > 1 ? (
        <IntegerField
          label="退还数量"
          value={quantity}
          onChange={setQuantity}
          min={1}
          max={assignment.quantity}
          suffix="件"
          hint={`领了 ${assignment.quantity} 件，没还的继续算在名下`}
        />
      ) : null}
      {error ? <Text style={deviceDetail.error}>{error}</Text> : null}
      <Button
        title="确认退还"
        loading={busy}
        onPress={async () => {
          setError(null);
          if (!returnedOn) return setError('请选择退还日期');
          if (quantity === null) return setError(`请填退还数量（1 到 ${assignment.quantity}）`);
          setBusy(true);
          try {
            await onSubmit(returnedOn, quantity);
          } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : '保存失败，请重试');
          } finally {
            setBusy(false);
          }
        }}
      />
    </Sheet>
  );
}

// 照鸿蒙版 DeviceDetailPage.ets：顶上一张大卡片（类别、名称、型号、保修、三个大数字、登记领用）；
// 正在使用、领用记录是不留内边距的白卡片，行自己留边距，行间分隔线从左边 16 开始、右边到头；
// 信息是分组卡片。领用、退还面板照 AssignmentSheets.ets：配件提示是浅蓝底的一段话
const useDeviceDetailStyles = makeStyles((colors) => ({
  flex: { flex: 1, minWidth: 0 },
  summary: { gap: 8 },
  category: { fontSize: font.small, color: colors.accent, fontWeight: '700' },
  title: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  sub: { fontSize: font.small, color: colors.muted },
  counts: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    marginVertical: 4,
  },
  count: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 8 },
  countValue: { fontSize: font.title, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  countLabel: { fontSize: font.small, color: colors.muted },
  hint: { fontSize: font.small, color: colors.faint },
  message: { fontSize: font.small, color: colors.ok, fontWeight: '500' },
  empty: { fontSize: font.small, color: colors.muted },
  listCard: { padding: 0, gap: 0, overflow: 'hidden' },
  // 行左边用外边距空出 16：上面的分隔线也就从 16 开始、右边到头
  assignRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingVertical: 8,
    marginLeft: 16,
    paddingRight: 12,
  },
  assignMain: { flex: 1, minWidth: 0, gap: 2, paddingVertical: 4 },
  // 标签自己是靠上对齐的（alignSelf: flex-start），套一层才能和鸿蒙版一样在行里上下居中
  rowTag: { justifyContent: 'center' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  person: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  meta: { fontSize: font.small, color: colors.muted },
  actions: { flexDirection: 'row', gap: 12 },
  error: { fontSize: font.small, color: colors.danger },
  accessoryNote: { backgroundColor: colors.infoSoft, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8 },
  accessoryNoteText: { fontSize: font.small, color: colors.info, lineHeight: 19 },
}));
