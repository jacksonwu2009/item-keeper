import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { ReminderRow } from '../../components/ReminderRows';
import { Empty, type Tone } from '../../components/ui';
import { listDevices, type DeviceSummary } from '../../db/devices';
import { listOffices } from '../../db/offices';
import { getSettings, type AppSettings } from '../../db/settings';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { useScene } from '../../hooks/useScene';
import { makeStyles } from '../../hooks/useTheme';
import { todayStr } from '../../lib/dates';
import { loadPlanProducts } from '../../lib/notifications';
import {
  expiryRowText,
  isReminderGroup,
  lowStockRowText,
  REMINDER_GROUP_TITLES,
  shortDateIn,
  showKindFor,
  sortLowStock,
  warrantyChipText,
  warrantySoonDevices,
  type ReminderGroup,
} from '../../lib/reminderList';
import { statusForDay, type PlanProduct } from '../../lib/reminderPlan';
import { radius } from '../../theme';

/**
 * 列表的一行（读数据时就算好，滚动时不再算）：点了打开物品或设备详情；
 * first、last：这一行在卡片的顶上、底下（带圆角，第一行不画分隔线）
 */
type ReminderItem = {
  key: string;
  title: string;
  subtitle: string;
  chip: { text: string; tone: Tone };
  open: { pathname: '/stock/[id]' | '/device/[id]'; id: number } | null;
  first: boolean;
  last: boolean;
};

const NO_ITEMS: ReminderItem[] = [];

function productTarget(product: PlanProduct): ReminderItem['open'] {
  return product.id === undefined ? null : { pathname: '/stock/[id]', id: product.id };
}

/**
 * 这一组的各行：和提醒页一样，不管关没关某类提醒都列出来；排序同提醒页（过期按天数，库存不足按 sortLowStock，保修按剩几天）。
 * 保修快到期只在家用场景有；全部办公点、不止一个办公点时说明前面加办公点名（officeNames）
 */
function reminderItems(
  group: ReminderGroup,
  products: PlanProduct[],
  settings: AppSettings,
  devices: DeviceSummary[],
  homeScene: boolean,
  officeNames: Map<number, string> | null,
): ReminderItem[] {
  const today = todayStr();
  let items: Omit<ReminderItem, 'first' | 'last'>[] = [];
  if (group === 'expired' || group === 'expiring' || group === 'lowStock') {
    const status = statusForDay(products, { ...settings, expiryEnabled: true, lowStockEnabled: true }, today);
    if (group === 'lowStock') {
      const entries = sortLowStock(status.lowStock);
      const showKind = showKindFor(entries);
      items = entries.map((entry) => {
        const text = lowStockRowText(entry, showKind);
        return {
          key: `${entry.product.id ?? entry.name}-low`,
          title: entry.name,
          subtitle: text.subtitle,
          chip: { text: text.chip, tone: entry.qty <= 0 ? 'danger' : 'warn' },
          open: productTarget(entry.product),
        };
      });
    } else {
      const entries = status[group];
      const showKind = showKindFor(entries);
      items = entries.map((entry) => {
        const text = expiryRowText(entry, today, showKind);
        return {
          key: `${entry.product.id ?? entry.name}-${entry.expiryDate}`,
          title: entry.name,
          subtitle: text.subtitle,
          chip: { text: text.chip, tone: group === 'expired' ? 'danger' : 'warn' },
          open: productTarget(entry.product),
        };
      });
    }
  } else if (homeScene) {
    items = warrantySoonDevices(devices, today).map(({ device, daysLeft }) => ({
      key: String(device.id),
      title: device.name,
      subtitle: [
        officeNames && (officeNames.get(device.officeId) ?? ''),
        device.category,
        device.warrantyUntil && `保修到 ${shortDateIn(device.warrantyUntil, today)}`,
      ]
        .filter(Boolean)
        .join(' · '),
      chip: { text: warrantyChipText(daysLeft), tone: 'warn' },
      open: { pathname: '/device/[id]', id: device.id },
    }));
  }
  return items.map((item, index) => ({ ...item, first: index === 0, last: index === items.length - 1 }));
}

/**
 * 提醒页某一组的完整列表（提醒页每组只显示前几样）。看的是右上角选的办公点，和提醒页一样。
 * 一组可能几百上千样：FlatList 只画屏幕上看得见的几行；各行在读数据时算好（loader 里），滚动、重画时不再算。
 */
export default function ReminderGroupScreen() {
  const pageStyles = usePageStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene } = useScene();
  const params = useLocalSearchParams<{ group?: string }>();
  const group = isReminderGroup(params.group) ? params.group : 'expired';
  const officeFilter = office.filterId;
  const showOffice = office.multiple && officeFilter === null;
  const homeScene = scene === 'home';
  const loader = useCallback(async () => {
    const warranty = group === 'warranty';
    const [settings, products, devices, offices] = await Promise.all([
      getSettings(db),
      warranty ? Promise.resolve([] as PlanProduct[]) : loadPlanProducts(db, officeFilter),
      warranty ? listDevices(db, officeFilter) : Promise.resolve([] as DeviceSummary[]),
      warranty && showOffice ? listOffices(db) : Promise.resolve(null),
    ]);
    const officeNames = offices ? new Map(offices.map((item) => [item.id, item.name])) : null;
    return { items: reminderItems(group, products, settings, devices, homeScene, officeNames) };
  }, [db, officeFilter, group, homeScene, showOffice]);
  const [data, , loaded] = useFocusData(loader, { items: NO_ITEMS });
  const title = REMINDER_GROUP_TITLES[group];

  return (
    <View style={pageStyles.screen}>
      <Stack.Screen options={{ title: loaded ? `${title}（${data.items.length}）` : title }} />
      <FlatList
        style={pageStyles.screen}
        contentContainerStyle={pageStyles.listContent}
        data={loaded ? data.items : NO_ITEMS}
        keyExtractor={itemKey}
        renderItem={renderItem}
        ListEmptyComponent={
          loaded ? (
            <Empty icon="checkmark-circle-outline" title={group === 'warranty' ? '现在没有保修快到期的设备' : `现在没有${title}的`} />
          ) : undefined
        }
        initialNumToRender={20}
        windowSize={11}
      />
    </View>
  );
}

function itemKey(item: ReminderItem): string {
  return item.key;
}

const renderItem: ListRenderItem<ReminderItem> = ({ item }) => <ReminderListRow item={item} />;

function openItem(item: ReminderItem) {
  if (item.open) router.push({ pathname: item.open.pathname, params: { id: String(item.open.id) } });
}

/**
 * 一行：第一行带上圆角、最后一行带下圆角，一组连起来就是原来那张白卡片（ReminderCard）；分隔线由 ReminderRow 画（第一行不画）。
 * memo：重新读数据前已经画好的行不重画
 */
const ReminderListRow = memo(function ReminderListRow({ item }: { item: ReminderItem }) {
  const pageStyles = usePageStyles();
  return (
    <View style={[pageStyles.rowCard, item.first ? pageStyles.rowCardFirst : pageStyles.rowCardJoined, item.last && pageStyles.rowCardLast]}>
      <ReminderRow first={item.first} title={item.title} subtitle={item.subtitle} chip={item.chip} onPress={() => openItem(item)} />
    </View>
  );
});

const usePageStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  // 和原来的 Screen 一样四周留 16、底下留 40
  listContent: { padding: 16, paddingBottom: 40 },
  // 各行连成一张卡片（ReminderCard 的样子：白底、大圆角、不留内边距）
  rowCard: { backgroundColor: colors.surface, overflow: 'hidden' },
  rowCardFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  // 列表里每行各自排版，高度不是整像素时两行之间会漏出一条 1 像素的底色：后一行往上叠一像素盖住
  rowCardJoined: { marginTop: -StyleSheet.hairlineWidth },
  rowCardLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
}));
