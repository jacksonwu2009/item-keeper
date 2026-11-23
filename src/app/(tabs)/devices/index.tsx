import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { SwipeRow, UndoBar } from '../../../components/SwipeRow';
import { Chip, ChoiceChips, Empty, LARGE_TITLE_SCROLL_INSET, LIST_PRESS_DELAY, ListActions, SearchField, Segmented } from '../../../components/ui';
import {
  deleteDevice,
  listActiveAssignments,
  listDevices,
  type ActiveAssignment,
  type DeviceSummary,
} from '../../../db/devices';
import { useFocusData } from '../../../hooks/useFocusData';
import { usePendingDelete } from '../../../hooks/usePendingDelete';
import { useOffice } from '../../../hooks/useOffice';
import { useScene } from '../../../hooks/useScene';
import { diffDays, formatDate, todayStr } from '../../../lib/dates';
import { describeConfig } from '../../../lib/devicePresets';
import { rescheduleReminders } from '../../../lib/notifications';
import { warrantyStatus } from '../../../lib/warranty';
import { colors, font, radius } from '../../../theme';

type ListMode = 'device' | 'person';
/** 办公场景按借出、在库筛；家庭场景按保修筛 */
type Filter = 'all' | 'out' | 'in' | 'warrantySoon' | 'warrantyExpired';
const HOME_FILTERS: Filter[] = ['all', 'warrantySoon', 'warrantyExpired'];
const OFFICE_FILTERS: Filter[] = ['all', 'out', 'in'];

export default function DevicesScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene } = useScene();
  // 家庭场景：没有领用、按使用人和借出 / 在库，改成看保修
  const home = scene === 'home';
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
  const [chosenMode, setMode] = useState<ListMode>('device');
  // 提醒页点「借出设备」过来：切到按使用人看（at 每次不一样，再点一次也会切）
  const params = useLocalSearchParams<{ view?: string; at?: string }>();
  const [handledAt, setHandledAt] = useState<string | undefined>(undefined);
  if (params.view === 'person' && params.at !== handledAt) {
    setHandledAt(params.at);
    setMode('person');
  }
  const [chosenFilter, setFilter] = useState<Filter>('all');
  const mode: ListMode = home ? 'device' : chosenMode;
  // 换了场景，另一个场景的筛选就不算了
  const filter: Filter = (home ? HOME_FILTERS : OFFICE_FILTERS).includes(chosenFilter) ? chosenFilter : 'all';
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const today = todayStr();

  const deletion = usePendingDelete<number>(
    (id) => deleteDevice(db, id),
    () => {
      // 家庭场景有保修提醒，删掉的设备不再提醒
      rescheduleReminders(db).catch(() => undefined);
      return reload();
    },
  );
  // 等撤销的那台设备在两种视图、顶部统计里都先拿掉
  const pendingId = deletion.pending?.key;
  const devices = useMemo(() => allDevices.filter((device) => device.id !== pendingId), [allDevices, pendingId]);
  const active = useMemo(() => allActive.filter((item) => item.deviceId !== pendingId), [allActive, pendingId]);

  const deviceSections = useMemo(() => {
    const matched = devices.filter((device) => {
      if (filter === 'out' && device.outQty <= 0) return false;
      if (filter === 'in' && device.quantity - device.outQty <= 0) return false;
      if (filter === 'warrantySoon' && warrantyStatus(device.warrantyUntil, today)?.level !== 'soon') return false;
      if (filter === 'warrantyExpired' && warrantyStatus(device.warrantyUntil, today)?.level !== 'expired') return false;
      if (!keyword) return true;
      return [
        device.name,
        device.model,
        describeConfig(device),
        device.serialNo,
        device.invoiceNo,
        device.category,
        device.holders,
      ]
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
  }, [devices, filter, keyword, today]);

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
  const totalQty = devices.reduce((sum, device) => sum + device.quantity, 0);
  const warrantySoon = devices.filter((device) => warrantyStatus(device.warrantyUntil, today)?.level === 'soon').length;

  const header = (
    <View style={deviceStyles.header}>
      <ListActions
        scanTitle="扫码录入"
        onScan={() => router.push({ pathname: '/scan', params: { mode: 'device' } })}
        onAdd={() => router.push('/device/new')}
      />
      {devices.length > 0 ? (
        <>
          {/* 照鸿蒙版的顺序：搜索框、按设备 / 按使用人、筛选，统计数字贴着下面的列表 */}
          <SearchField
            placeholder={home ? '搜索名称、型号、序列号或谁在用' : mode === 'device' ? '搜索名称、型号、序列号或使用人' : '搜索使用人或设备'}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
          {home ? null : (
            <Segmented
              options={[
                { value: 'device', label: '按设备' },
                { value: 'person', label: '按使用人' },
              ]}
              value={mode}
              onChange={setMode}
            />
          )}
          {home ? (
            <ChoiceChips
              options={[
                { value: 'all', label: '全部' },
                { value: 'warrantySoon', label: '保修快到期' },
                { value: 'warrantyExpired', label: '已过保' },
              ]}
              value={filter}
              onChange={setFilter}
            />
          ) : mode === 'device' ? (
            <ChoiceChips
              options={[
                { value: 'all', label: '全部' },
                { value: 'out', label: '有借出' },
                { value: 'in', label: '有在库' },
              ]}
              value={filter}
              onChange={setFilter}
            />
          ) : null}
          <Text style={deviceStyles.summary}>
            {home
              ? `共 ${devices.length} 种设备，${totalQty} 件${warrantySoon ? `；${warrantySoon} 种保修 30 天内到期` : ''}`
              : `共 ${devices.length} 种设备，${totalQty} 件；借出 ${totalOut} 件`}
          </Text>
          {mode === 'device' ? <Text style={deviceStyles.gestureHint}>点开看详情，长按编辑，向左滑删除</Text> : null}
        </>
      ) : null}
    </View>
  );

  const empty = !loaded ? undefined : devices.length === 0 ? (
    <Empty
      icon="laptop-outline"
      title="还没有设备"
      text={
        home
          ? '把电视、冰箱、手机、电脑这些登记进来，记下哪天买的、保修到哪天；保修快到期时会提醒。'
          : '把电脑、显示器、键鼠这些登记进来，记下型号和数量；谁领走、哪天领、哪天还，都在设备详情里登记。'
      }
    />
  ) : (
    <Empty
      icon={mode === 'person' ? 'people-outline' : 'search-outline'}
      title={mode === 'person' && !keyword ? '现在没有人借着设备' : '没有符合条件的'}
    />
  );

  const undoBar = deletion.pending ? (
    <UndoBar
      text={home ? `已删除「${deletion.pending.label}」` : `已删除「${deletion.pending.label}」和它的领用记录`}
      onUndo={deletion.undo}
    />
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
          contentInsetAdjustmentBehavior={LARGE_TITLE_SCROLL_INSET}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={deviceStyles.sectionTitle}>
              {section.title} · {section.data.reduce((sum, item) => sum + item.quantity, 0)} 件
            </Text>
          )}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/device/[id]', params: { id: String(item.deviceId) } })}
              unstable_pressDelay={LIST_PRESS_DELAY}
              style={({ pressed }) => [deviceStyles.row, deviceStyles.personRow, pressed && deviceStyles.rowPressed]}
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
        contentInsetAdjustmentBehavior={LARGE_TITLE_SCROLL_INSET}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <Text style={deviceStyles.sectionTitle}>{section.title}</Text>}
        renderItem={({ item }) => {
          const available = item.quantity - item.outQty;
          const warranty = warrantyStatus(item.warrantyUntil, today);
          return (
            <SwipeRow
              accessibilityLabel={home ? `${item.name}，共 ${item.quantity} 件` : `${item.name}，在库 ${available} 件，共 ${item.quantity} 件`}
              onPress={() => router.push({ pathname: '/device/[id]', params: { id: String(item.id) } })}
              onLongPress={() => router.push({ pathname: '/device/edit/[id]', params: { id: String(item.id) } })}
              onDelete={() => deletion.remove(item.id, item.name)}
              style={deviceStyles.row}
              pressedStyle={deviceStyles.rowPressed}
              cornerRadius={radius.lg}
            >
              <View style={deviceStyles.rowMain}>
                <Text style={deviceStyles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {showOffice || item.model || item.serialNo || describeConfig(item) ? (
                  <Text style={deviceStyles.meta} numberOfLines={1}>
                    {[
                      showOffice && office.officeName(item.officeId),
                      describeConfig(item),
                      item.model,
                      item.serialNo && `SN ${item.serialNo}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                ) : null}
                {item.holders ? (
                  <Text style={deviceStyles.holders} numberOfLines={1}>
                    {home ? '谁在用' : '使用人'}：{item.holders}
                  </Text>
                ) : null}
                {home && item.purchaseDate ? (
                  <Text style={deviceStyles.meta} numberOfLines={1}>
                    {formatDate(item.purchaseDate)} 买的
                  </Text>
                ) : null}
                {/* 家庭场景保修是重点：没过保的也写保修到哪天 */}
                {warranty && (home || warranty.level !== 'ok') ? (
                  <View style={deviceStyles.warranty}>
                    <Chip
                      text={warranty.text}
                      tone={warranty.level === 'expired' ? 'neutral' : warranty.level === 'soon' ? 'warn' : 'ok'}
                    />
                  </View>
                ) : null}
              </View>
              {home ? (
                item.quantity > 1 ? (
                  <View style={deviceStyles.countBox}>
                    <Text style={deviceStyles.meta}>共 {item.quantity}</Text>
                  </View>
                ) : null
              ) : (
                <View style={deviceStyles.countBox}>
                  <Chip text={`在库 ${available}`} tone={available > 0 ? 'ok' : 'neutral'} />
                  <Text style={deviceStyles.meta}>共 {item.quantity}</Text>
                </View>
              )}
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

// 照鸿蒙版 DevicesTab.ets：每台设备一张白底大圆角卡片，左边名称、配置、使用人，右边「在库」标签和总数；
// 分组标题是卡片外面的灰色小字，离上一组远一点、贴着下面的卡片
const deviceStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  gestureHint: { fontSize: font.small, color: colors.faint, textAlign: 'center' },
  list: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  header: { gap: 12, marginBottom: 4 },
  summary: { fontSize: font.small, color: colors.muted },
  sectionTitle: { fontSize: font.small, fontWeight: '500', color: colors.muted, paddingHorizontal: 4, paddingTop: 12 },
  sectionGap: { height: 8 },
  separator: { height: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 64,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 12,
  },
  // 按使用人那一行右边没有箭头，左右一样留 16
  personRow: { paddingRight: 16 },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rowMain: { flex: 1, gap: 3, minWidth: 0 },
  name: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  meta: { fontSize: font.small, color: colors.muted },
  holders: { fontSize: font.small, color: colors.info },
  warranty: { marginTop: 2 },
  countBox: { alignItems: 'flex-end', gap: 4 },
  dateBox: { alignItems: 'flex-end', gap: 2 },
  dateText: { fontSize: font.small, color: colors.ink, fontVariant: ['tabular-nums'] },
});
