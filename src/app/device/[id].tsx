import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { DateField } from '../../components/DateField';
import { IntegerField } from '../../components/NumberField';
import {
  Button,
  Card,
  Chip,
  ChoiceChips,
  Empty,
  Field,
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
  updateAssignment,
  type Device,
  type DeviceAssignment,
} from '../../db/devices';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { diffDays, formatDate, todayStr } from '../../lib/dates';
import { describeAccessories, warrantyStatus, type Accessory } from '../../lib/warranty';
import { colors, font, radius } from '../../theme';

type SheetState =
  | { type: 'issue' }
  | { type: 'return'; assignment: DeviceAssignment }
  | { type: 'edit'; assignment: DeviceAssignment }
  | null;

export default function DeviceDetailScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const { id } = useLocalSearchParams<{ id: string }>();
  const deviceId = Number(id);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loader = useCallback(async () => {
    const [device, assignments, people, accessories] = await Promise.all([
      getDevice(db, deviceId),
      listAssignments(db, deviceId),
      listPeople(db),
      listAccessories(db, deviceId),
    ]);
    return { device, assignments, people, accessories };
  }, [db, deviceId]);
  const [{ device, assignments, people, accessories }, reload, loaded] = useFocusData(loader, {
    device: null as Device | null,
    assignments: [] as DeviceAssignment[],
    people: [] as string[],
    accessories: [] as Accessory[],
  });

  async function afterChange(note: string) {
    setSheet(null);
    setMessage(note);
    await reload();
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

  function confirmDelete() {
    if (!device) return;
    Alert.alert('删除这台设备？', `「${device.name}」和它的全部领用记录都会被删除，不能恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteDevice(db, device.id);
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
            icon="shield-checkmark-outline"
          />
        ) : null}
        <View style={deviceDetail.counts}>
          <Count label="总数" value={device.quantity} />
          <Count label="借出" value={outQty} tone={outQty > 0 ? colors.info : undefined} />
          <Count label="在库" value={available} tone={available > 0 ? colors.ok : colors.faint} />
        </View>
        <Button
          title="登记领用"
          icon="person-add-outline"
          onPress={() => setSheet({ type: 'issue' })}
          disabled={available <= 0}
        />
        {available <= 0 ? <Text style={deviceDetail.hint}>全部借出了，有人退还后才能再领。</Text> : null}
        {message ? <Text style={deviceDetail.message}>{message}</Text> : null}
      </Card>

      <SectionTitle title={`正在使用（${active.length}）`} />
      {active.length === 0 ? (
        <Card>
          <Text style={deviceDetail.sub}>没有人在用。</Text>
        </Card>
      ) : (
        <Card style={deviceDetail.listCard}>
          {active.map((assignment, index) => (
            <View key={assignment.id} style={[deviceDetail.assignRow, index > 0 && deviceDetail.divider]}>
              <Pressable style={deviceDetail.flex} onPress={() => setSheet({ type: 'edit', assignment })}>
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

      {history.length > 0 ? (
        <>
          <SectionTitle title={`领用记录（${history.length}）`} />
          <Card style={deviceDetail.listCard}>
            {history.map((assignment, index) => (
              <Pressable
                key={assignment.id}
                onPress={() => setSheet({ type: 'edit', assignment })}
                style={[deviceDetail.assignRow, index > 0 && deviceDetail.divider]}
              >
                <View style={deviceDetail.flex}>
                  <Text style={deviceDetail.person}>
                    {assignment.person}
                    {assignment.quantity > 1 ? ` ×${assignment.quantity}` : ''}
                  </Text>
                  <Text style={deviceDetail.meta}>
                    {formatDate(assignment.issuedOn)} 领取 → {formatDate(assignment.returnedOn)} 退还
                  </Text>
                </View>
                <Chip text="已退还" tone="neutral" />
              </Pressable>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle title="信息" />
      <Card>
        {office.multiple ? <InfoRow label="办公点" value={office.officeName(device.officeId)} /> : null}
        <InfoRow label="类别" value={device.category} />
        <InfoRow label="型号" value={device.model ?? '—'} />
        <InfoRow label="序列号" value={device.serialNo ?? '—'} />
        <InfoRow label="购买日期" value={formatDate(device.purchaseDate)} />
        <InfoRow label="保修到期" value={device.warrantyUntil ? formatDate(device.warrantyUntil) : '没记录'} />
        <InfoRow label={device.quantity > 1 ? '配件（每件）' : '配件'} value={accessoryText ?? '没有'} />
        {device.note ? <InfoRow label="备注" value={device.note} /> : null}
      </Card>

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

      {sheet?.type === 'issue' ? (
        <AssignmentSheet
          title="登记领用"
          people={people}
          maxQuantity={available}
          accessoryText={accessoryText}
          onClose={() => setSheet(null)}
          onSubmit={async (input) => {
            await issueDevice(db, device.id, input);
            await afterChange(`已登记：${input.person} 领取 ${input.quantity} 件`);
          }}
        />
      ) : null}
      {sheet?.type === 'edit' ? (
        <AssignmentSheet
          title="修改领用记录"
          people={people}
          maxQuantity={sheet.assignment.returnedOn ? device.quantity : available + sheet.assignment.quantity}
          initial={sheet.assignment}
          onClose={() => setSheet(null)}
          onSubmit={async (input) => {
            await updateAssignment(db, sheet.assignment.id, input);
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
  return (
    <View style={deviceDetail.count}>
      <Text style={[deviceDetail.countValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={deviceDetail.countLabel}>{label}</Text>
    </View>
  );
}

function AssignmentSheet({
  title,
  people,
  maxQuantity,
  accessoryText,
  initial,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  people: string[];
  maxQuantity: number;
  /** 随设备一起领走的配件说明，领用时提示一下 */
  accessoryText?: string | null;
  initial?: DeviceAssignment;
  onClose: () => void;
  onSubmit: (input: {
    person: string;
    quantity: number;
    issuedOn: string;
    returnedOn: string | null;
    note: string | null;
  }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [person, setPerson] = useState(initial?.person ?? '');
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
    setBusy(true);
    try {
      await onSubmit({ person, quantity, issuedOn, returnedOn, note: note || null });
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
      {people.length ? (
        <ChoiceChips options={people.map((value) => ({ value, label: value }))} value={person} onChange={setPerson} />
      ) : null}
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

const deviceDetail = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  summary: { gap: 8 },
  category: { fontSize: font.tiny + 1, color: colors.accent, fontWeight: '700', letterSpacing: 1 },
  title: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  sub: { fontSize: font.small, color: colors.muted },
  counts: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.sm,
    paddingVertical: 10,
    marginVertical: 4,
  },
  count: { flex: 1, alignItems: 'center' },
  countValue: { fontSize: 24, fontWeight: '800', color: colors.ink, fontVariant: ['tabular-nums'] },
  countLabel: { fontSize: font.small, color: colors.muted },
  hint: { fontSize: font.small, color: colors.faint },
  message: { fontSize: font.small, color: colors.ok, fontWeight: '600' },
  listCard: { paddingVertical: 4, gap: 0 },
  assignRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  person: { fontSize: font.body, fontWeight: '600', color: colors.ink },
  meta: { fontSize: font.small, color: colors.muted, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 10 },
  error: { fontSize: font.small, color: colors.danger },
  accessoryNote: { backgroundColor: colors.infoSoft, borderRadius: radius.sm, padding: 10 },
  accessoryNoteText: { fontSize: font.small, color: colors.info, lineHeight: 19 },
});
