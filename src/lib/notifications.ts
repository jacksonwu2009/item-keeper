import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { listOffices } from '../db/offices';
import { listDevices } from '../db/devices';
import { getDataSince, getLastExportAt, getScene, getSettings } from '../db/settings';
import { listAllBatches, listProducts } from '../db/stock';
import { BACKUP_REMINDER_SLOTS, backupStatus, planBackupReminders } from './backupReminder';
import { planReminders, type PlanProduct, type PlannedReminder, type PlanWarranty } from './reminderPlan';

const CHANNEL_ID = 'reminders';

let handlerInstalled = false;

/** App 启动时调用一次：前台也弹通知，Android 建好通知渠道。 */
export async function setupNotifications(): Promise<void> {
  if (!handlerInstalled) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    handlerInstalled = true;
  }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '到期与库存提醒',
      importance: AndroidImportance.HIGH,
    });
  }
}

export type PermissionState = 'granted' | 'denied' | 'undetermined';

function toState(status: Notifications.NotificationPermissionsStatus): PermissionState {
  if (status.granted) return 'granted';
  const iosStatus = status.ios?.status;
  if (
    iosStatus === IosAuthorizationStatus.PROVISIONAL ||
    iosStatus === IosAuthorizationStatus.EPHEMERAL
  ) {
    return 'granted';
  }
  return status.canAskAgain ? 'undetermined' : 'denied';
}

export async function getPermissionState(): Promise<PermissionState> {
  return toState(await Notifications.getPermissionsAsync());
}

export async function requestPermission(): Promise<PermissionState> {
  return toState(
    await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    }),
  );
}

/**
 * 读出算提醒要用的物品。officeId 为 null 时是所有办公点；
 * 这时如果有不止一个办公点，名字前面加上办公点，通知里分得清是哪儿的东西。
 */
export async function loadPlanProducts(db: SQLiteDatabase, officeId: number | null = null): Promise<PlanProduct[]> {
  const [products, batches, offices] = await Promise.all([
    listProducts(db, undefined, officeId),
    listAllBatches(db),
    listOffices(db),
  ]);
  const prefix = officeId === null && offices.length > 1;
  const officeNames = new Map(offices.map((office) => [office.id, office.name]));
  const byProduct = new Map<number, PlanProduct['batches']>();
  for (const batch of batches) {
    const list = byProduct.get(batch.productId) ?? [];
    list.push({ quantity: batch.quantity, expiryDate: batch.expiryDate });
    byProduct.set(batch.productId, list);
  }
  return products.map((product) => ({
    id: product.id,
    kind: product.kind,
    name: prefix ? `${officeNames.get(product.officeId) ?? ''}·${product.name}` : product.name,
    unit: product.unit,
    totalQty: product.totalQty,
    lowStockThreshold: product.lowStockThreshold,
    expiryLeadDays: product.expiryLeadDays,
    batches: byProduct.get(product.id) ?? [],
  }));
}

/**
 * 家庭场景要提醒保修的设备（有保修到期日的）。和物品一样，看全部地点时、有不止一个地点就在名字前面加地点。
 * 办公场景返回空：保修提醒只在家庭场景发。
 */
export async function loadPlanWarranties(db: SQLiteDatabase, officeId: number | null = null): Promise<PlanWarranty[]> {
  if ((await getScene(db)) !== 'home') return [];
  const [devices, offices] = await Promise.all([listDevices(db, officeId), listOffices(db)]);
  const prefix = officeId === null && offices.length > 1;
  const officeNames = new Map(offices.map((office) => [office.id, office.name]));
  return devices
    .filter((device) => device.warrantyUntil)
    .map((device) => ({
      name: prefix ? `${officeNames.get(device.officeId) ?? ''}·${device.name}` : device.name,
      warrantyUntil: device.warrantyUntil as string,
    }));
}

async function rescheduleNow(db: SQLiteDatabase): Promise<PlannedReminder[]> {
  const [settings, products, warranties, lastExportAt, dataSince] = await Promise.all([
    getSettings(db),
    loadPlanProducts(db),
    loadPlanWarranties(db),
    getLastExportAt(db),
    getDataSince(db),
  ]);
  const now = new Date();
  // iOS 每个 App 最多挂 64 条本地通知：到期/库存提醒 56 条，备份提醒留 4 条
  const backup = planBackupReminders(
    backupStatus({ lastExportAt, dataSince, reminderDays: settings.backupReminderDays, now }),
    settings,
    now,
  );
  const plan = [...planReminders(products, settings, now, 60, 60 - BACKUP_REMINDER_SLOTS, warranties), ...backup].sort(
    (left, right) => left.at.getTime() - right.at.getTime(),
  );
  if ((await getPermissionState()) !== 'granted') return plan;

  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const reminder of plan) {
    await Notifications.scheduleNotificationAsync({
      content: { title: reminder.title, body: reminder.body, data: { url: '/' } },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: reminder.at,
        channelId: CHANNEL_ID,
      },
    });
  }
  return plan;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * 重新排未来的提醒。数据一变就调；多次调用会排队依次执行，
 * 避免「取消全部」和「逐条排程」交错。
 */
export function rescheduleReminders(db: SQLiteDatabase): Promise<PlannedReminder[]> {
  const next = queue.then(() => rescheduleNow(db));
  queue = next.catch(() => undefined);
  return next;
}

export async function sendTestNotification(): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: { title: '测试通知', body: '能看到这条，说明提醒能正常送达。' },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 3,
      channelId: CHANNEL_ID,
    },
  });
}
