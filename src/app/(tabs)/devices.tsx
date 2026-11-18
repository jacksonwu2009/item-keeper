import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { SwipeRow, UndoBar } from '../../components/SwipeRow';
import { Button, Chip, Empty, Field, Segmented } from '../../components/ui';
import {
  deleteDevice,
  listActiveAssignments,
  listDevices,
  type ActiveAssignment,
  type DeviceSummary,
} from '../../db/devices';
import { useFocusData } from '../../hooks/useFocusData';
import { usePendingDelete } from '../../hooks/usePendingDelete';
import { useOffice } from '../../hooks/useOffice';
import { diffDays, formatDate, todayStr } from '../../lib/dates';
import { warrantyStatus } from '../../lib/warranty';
import { colors, font, radius } from '../../theme';

type ListMode = 'device' | 'person';
type Filter = 'all' | 'out' | 'in';

export default function DevicesScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const officeFilter = office.filterId;
  const showOffice = office.multiple && officeFilter === null;
  const loader = useCallback(async () => {
    const [devices, active] = await Promise.all([
      listDevices(db, officeFilter),
      listActiveAssignments(db, officeFilter),
    ]);
    return { devices, active };
  }, [db, officeFilter]);
  const [{ devices: allDevices, active: allActive }, reload, loaded] = useFocusData(loader, {
    devices: [] as DeviceSummary[],
    active: [] as ActiveAssignment[],
  });
  const [mode, setMode] = useState<ListMode>('device');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const today = todayStr();

  const deletion = usePendingDelete<number>(
    (id) => deleteDevice(db, id),
    () => reload(),
  );
  // 等撤销的那台设备在两种视图、顶部统计里都先拿掉
  const pendingId = deletion.pending?.key;
  const devices = useMemo(() => allDevices.filter((device) => device.id !== pendingId), [allDevices, pendingId]);
  const active = useMemo(() => allActive.filter((item) => item.deviceId !== pendingId), [allActive, pendingId]);

  const deviceSections = useMemo(() => {
    const matched = devices.filter((device) => {
      if (filter === 'out' && device.outQty <= 0) return false;
      if (filter === 'in' && device.quantity - device.outQty <= 0) return false;
      if (!keyword) return true;
      return [device.name, device.model, device.serialNo, device.category, device.holders]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
    const groups = new Map<string, DeviceSummary[]>();
    for (const device of matched) {
      const list = groups.get(device.category) ?? [];
      list.push(device);
      groups.set(device.category, list);
    }
    return Array.from(groups, ([title, data]) => ({ title, data }));
  }, [devices, filter, keyword]);

  const personSections = useMemo(() => {
    const groups = new Map<string, ActiveAssignment[]>();
    for (const assignment of active) {
      const haystack = [assignment.person, assignment.deviceName, assignment.deviceModel].filter(Boolean).join(' ');
      if (keyword && !haystack.toLowerCase().includes(keyword)) continue;
      const list = groups.get(assignment.person) ?? [];
      list.push(assignment);
      groups.set(assignment.person, list);
    }
    return Array.from(groups, ([title, data]) => ({ title, data }));
  }, [active, keyword]);

  const totalOut = active.reduce((sum, assignment) => sum + assignment.quantity, 0);

  const header = (
    <View style={deviceStyles.header}>
      <Button title="新增设备" icon="add" onPress={() => router.push('/device/new')} />
      {devices.length > 0 ? (
        <>
          <Text style={deviceStyles.summary}>
            共 {devices.length} 种设备，{devices.reduce((sum, device) => sum + device.quantity, 0)} 件；借出 {totalOut}{' '}
            件
          </Text>
          <Segmented
            options={[
              { value: 'device', label: '按设备' },
              { value: 'person', label: '按使用人' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <Field
            placeholder={mode === 'device' ? '搜索名称、型号、序列号或使用人' : '搜索使用人或设备'}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
          {mode === 'device' ? <Text style={deviceStyles.gestureHint}>点开看详情，长按编辑，向左滑删除</Text> : null}
          {mode === 'device' ? (
            <Segmented
              options={[
                { value: 'all', label: '全部' },
                { value: 'out', label: '有借出' },
                { value: 'in', label: '有在库' },
              ]}
              value={filter}
              onChange={setFilter}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );

  const empty = !loaded ? undefined : devices.length === 0 ? (
    <Empty
      icon="laptop-outline"
      title="还没有设备"
      text="把电脑、显示器、键鼠这些登记进来，记下型号和数量；谁领走、哪天领、哪天还，都在设备详情里登记。"
    />
  ) : (
    <Empty
      icon={mode === 'person' ? 'people-outline' : 'search-outline'}
      title={mode === 'person' && !keyword ? '现在没有人借着设备' : '没有符合条件的'}
    />
  );

  const undoBar = deletion.pending ? (
    <UndoBar text={`已删除「${deletion.pending.label}」和它的领用记录`} onUndo={deletion.undo} />
  ) : null;

  if (mode === 'person') {
    return (
      <View style={deviceStyles.screen}>
        <SectionList
          style={deviceStyles.list}
          contentContainerStyle={deviceStyles.content}
          sections={personSections}
          keyExtractor={(item) => String(item.id)}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          keyboardShouldPersistTaps="handled"
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={deviceStyles.sectionTitle}>
              {section.title} · {section.data.reduce((sum, item) => sum + item.quantity, 0)} 件
            </Text>
          )}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/device/[id]', params: { id: String(item.deviceId) } })}
              style={({ pressed }) => [deviceStyles.row, pressed && deviceStyles.rowPressed]}
            >
              <View style={deviceStyles.rowMain}>
                <Text style={deviceStyles.name} numberOfLines={1}>
                  {item.deviceName}
                  {item.quantity > 1 ? ` ×${item.quantity}` : ''}
                </Text>
                <Text style={deviceStyles.meta} numberOfLines={1}>
                  {[showOffice && office.officeName(item.officeId), item.category, item.deviceModel]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <View style={deviceStyles.dateBox}>
                <Text style={deviceStyles.dateText}>{formatDate(item.issuedOn)} 领取</Text>
                <Text style={deviceStyles.meta}>已用 {Math.max(0, diffDays(today, item.issuedOn))} 天</Text>
              </View>
            </Pressable>
          )}
          SectionSeparatorComponent={() => <View style={deviceStyles.sectionGap} />}
          ItemSeparatorComponent={() => <View style={deviceStyles.separator} />}
        />
        {undoBar}
      </View>
    );
  }

  return (
    <View style={deviceStyles.screen}>
      <SectionList
        style={deviceStyles.list}
        contentContainerStyle={deviceStyles.content}
        sections={deviceSections}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <Text style={deviceStyles.sectionTitle}>{section.title}</Text>}
        renderItem={({ item }) => {
          const available = item.quantity - item.outQty;
          const warranty = warrantyStatus(item.warrantyUntil, today);
          return (
            <SwipeRow
              accessibilityLabel={`${item.name}，在库 ${available} 件，共 ${item.quantity} 件`}
              onPress={() => router.push({ pathname: '/device/[id]', params: { id: String(item.id) } })}
              onLongPress={() => router.push({ pathname: '/device/edit/[id]', params: { id: String(item.id) } })}
              onDelete={() => deletion.remove(item.id, item.name)}
              style={deviceStyles.row}
              pressedStyle={deviceStyles.rowPressed}
            >
              <View style={deviceStyles.rowMain}>
                <Text style={deviceStyles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {showOffice || item.model || item.serialNo ? (
                  <Text style={deviceStyles.meta} numberOfLines={1}>
                    {[
                      showOffice && office.officeName(item.officeId),
                      item.model,
                      item.serialNo && `SN ${item.serialNo}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                ) : null}
                {item.holders ? (
                  <Text style={deviceStyles.holders} numberOfLines={1}>
                    使用人：{item.holders}
                  </Text>
                ) : null}
                {warranty && warranty.level !== 'ok' ? (
                  <Chip text={warranty.text} tone={warranty.level === 'expired' ? 'neutral' : 'warn'} />
                ) : null}
              </View>
              <View style={deviceStyles.countBox}>
                <Chip text={`在库 ${available}`} tone={available > 0 ? 'ok' : 'neutral'} />
                <Text style={deviceStyles.meta}>共 {item.quantity}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.faint} />
            </SwipeRow>
          );
        }}
        SectionSeparatorComponent={() => <View style={deviceStyles.sectionGap} />}
        ItemSeparatorComponent={() => <View style={deviceStyles.separator} />}
      />
      {undoBar}
    </View>
  );
}

const deviceStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  gestureHint: { fontSize: font.small, color: colors.faint, textAlign: 'center' },
  list: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  header: { gap: 12, marginBottom: 4 },
  summary: { fontSize: font.small, color: colors.muted },
  sectionTitle: { fontSize: font.small, fontWeight: '700', color: colors.muted, letterSpacing: 0.6, marginTop: 8 },
  sectionGap: { height: 8 },
  separator: { height: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rowMain: { flex: 1, gap: 3, minWidth: 0 },
  name: { fontSize: font.body + 1, fontWeight: '600', color: colors.ink },
  meta: { fontSize: font.small, color: colors.muted },
  holders: { fontSize: font.small, color: colors.info },
  countBox: { alignItems: 'flex-end', gap: 4 },
  dateBox: { alignItems: 'flex-end', gap: 2 },
  dateText: { fontSize: font.small, color: colors.ink, fontVariant: ['tabular-nums'] },
});
