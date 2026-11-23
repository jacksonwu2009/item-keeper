import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, type ReactNode } from 'react';

import { ReminderCard, ReminderRow } from '../../components/ReminderRows';
import { Empty, Screen } from '../../components/ui';
import { listDevices, type DeviceSummary } from '../../db/devices';
import { DEFAULT_SETTINGS, getSettings } from '../../db/settings';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { useScene } from '../../hooks/useScene';
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
} from '../../lib/reminderList';
import { statusForDay, type PlanProduct } from '../../lib/reminderPlan';

function openProduct(product: PlanProduct) {
  if (product.id !== undefined) router.push({ pathname: '/stock/[id]', params: { id: String(product.id) } });
}

/** 提醒页某一组的完整列表（提醒页每组只显示前几样）。看的是右上角选的办公点，和提醒页一样 */
export default function ReminderGroupScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const { scene } = useScene();
  const params = useLocalSearchParams<{ group?: string }>();
  const group = isReminderGroup(params.group) ? params.group : 'expired';
  const officeFilter = office.filterId;
  const showOffice = office.multiple && officeFilter === null;
  const loader = useCallback(async () => {
    const [settings, products, devices] = await Promise.all([
      getSettings(db),
      loadPlanProducts(db, officeFilter),
      group === 'warranty' ? listDevices(db, officeFilter) : Promise.resolve([] as DeviceSummary[]),
    ]);
    return { settings, products, devices };
  }, [db, officeFilter, group]);
  const [data, , loaded] = useFocusData(loader, {
    settings: DEFAULT_SETTINGS,
    products: [] as PlanProduct[],
    devices: [] as DeviceSummary[],
  });

  const today = todayStr();
  // 和提醒页一样：不管关没关某类提醒，都列出来
  const status = statusForDay(data.products, { ...data.settings, expiryEnabled: true, lowStockEnabled: true }, today);
  const title = REMINDER_GROUP_TITLES[group];

  let rows: ReactNode[] = [];
  if (group === 'expired' || group === 'expiring') {
    const entries = status[group];
    const showKind = showKindFor(entries);
    rows = entries.map((entry, index) => {
      const text = expiryRowText(entry, today, showKind);
      return (
        <ReminderRow
          key={`${entry.product.id ?? entry.name}-${entry.expiryDate}`}
          first={index === 0}
          title={entry.name}
          subtitle={text.subtitle}
          chip={{ text: text.chip, tone: group === 'expired' ? 'danger' : 'warn' }}
          onPress={() => openProduct(entry.product)}
        />
      );
    });
  } else if (group === 'lowStock') {
    const entries = sortLowStock(status.lowStock);
    const showKind = showKindFor(entries);
    rows = entries.map((entry, index) => {
      const text = lowStockRowText(entry, showKind);
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
    });
  } else if (scene === 'home') {
    rows = warrantySoonDevices(data.devices, today).map(({ device, daysLeft }, index) => (
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
    ));
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: loaded ? `${title}（${rows.length}）` : title }} />
      {!loaded ? null : rows.length ? (
        <ReminderCard>{rows}</ReminderCard>
      ) : (
        <Empty icon="checkmark-circle-outline" title={group === 'warranty' ? '现在没有保修快到期的设备' : `现在没有${title}的`} />
      )}
    </Screen>
  );
}
