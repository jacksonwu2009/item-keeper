import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { listOffices } from '../db/offices';
import { listDevices } from '../db/devices';
import { migrateDbIfNeeded } from '../db/schema';
import { getDataSince, getLastExportAt, getSettings, type AppSettings } from '../db/settings';
import { listAllBatches, listProducts } from '../db/stock';
import { BACKUP_REMINDER_SLOTS_PER_SCENE, backupStatus, planBackupReminders } from './backupReminder';
import { withDatabaseLock } from './dbLock';
import {
  ITEM_REMINDER_SLOTS_PER_SCENE,
  mergeScenePlans,
  planReminders,
  planUnchangedUntil,
  type PlanProduct,
  type PlannedReminder,
  type PlanWarranty,
  type ScenePlan,
} from './reminderPlan';
import { getActiveDatabases, otherScene, sceneOfDatabase } from './sceneDatabases';
import { createCoalescedQueue, scheduleSignature } from './reschedule';
import { currentScene, type Scene } from './terms';

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
 * 保修提醒只在家庭场景发：只对家庭场景的库调。
 */
export async function loadPlanWarranties(db: SQLiteDatabase, officeId: number | null = null): Promise<PlanWarranty[]> {
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

/** 排一个场景的提醒要用的数据：各场景用自己库里的提醒设置、上次导出时间 */
type SceneInputs = {
  settings: AppSettings;
  products: PlanProduct[];
  warranties: PlanWarranty[];
  lastExportAt: string | null;
  dataSince: string | null;
};

async function loadSceneInputs(db: SQLiteDatabase, scene: Scene): Promise<SceneInputs> {
  const [settings, products, warranties, lastExportAt, dataSince] = await Promise.all([
    getSettings(db),
    loadPlanProducts(db),
    scene === 'home' ? loadPlanWarranties(db) : Promise.resolve([]),
    getLastExportAt(db),
    getDataSince(db),
  ]);
  return { settings, products, warranties, lastExportAt, dataSince };
}

/**
 * 另一个场景的库：另开一个连接，先跑迁移（免得版本落后），读完就关。
 * 只有当前场景的库会被改，另一个库在切回去之前不会变，读过一次就记下来，换了场景再重新读。
 */
let otherCache: { databaseName: string; inputs: SceneInputs } | null = null;

async function loadOtherSceneInputs(databaseName: string, scene: Scene): Promise<SceneInputs> {
  if (otherCache?.databaseName === databaseName) return otherCache.inputs;
  const inputs = await withDatabaseLock(databaseName, async () => {
    const db = await openDatabaseAsync(databaseName, { useNewConnection: true });
    try {
      await migrateDbIfNeeded(db);
      return await loadSceneInputs(db, scene);
    } finally {
      await db.closeAsync().catch(() => undefined);
    }
  });
  otherCache = { databaseName, inputs };
  return inputs;
}

/**
 * 另一个场景排好的提醒：输入还是同一份（otherCache 没换）、还没到计划会变的时刻（planUnchangedUntil），直接用上次排的。
 * 每次重排都只有当前场景要重新算。
 */
let otherPlanCache: { inputs: SceneInputs; from: number; until: number; plan: ScenePlan } | null = null;

function planOtherScene(scene: Scene, inputs: SceneInputs, now: Date): ScenePlan {
  const time = now.getTime();
  const cached = otherPlanCache;
  if (cached && cached.inputs === inputs && time >= cached.from && time < cached.until) return cached.plan;
  const plan = planScene(scene, inputs, now);
  const until = planUnchangedUntil(now, inputs.settings);
  otherPlanCache = until === null ? null : { inputs, from: time, until, plan };
  return plan;
}

function planScene(scene: Scene, inputs: SceneInputs, now: Date): ScenePlan {
  const { settings } = inputs;
  return {
    scene,
    items: planReminders(inputs.products, settings, now, 60, ITEM_REMINDER_SLOTS_PER_SCENE, inputs.warranties),
    backup: planBackupReminders(
      backupStatus({ lastExportAt: inputs.lastExportAt, dataSince: inputs.dataSince, reminderDays: settings.backupReminderDays, now }),
      settings,
      now,
      BACKUP_REMINDER_SLOTS_PER_SCENE,
    ),
  };
}

/** 上次排进系统的通知（scheduleSignature）；App 每次启动是 null，启动后第一次一定整份重排 */
let lastScheduled: string | null = null;

/** 两个场景的提醒都排：db 是当前场景的库，另一个场景的库另外打开读 */
async function rescheduleNow(db: SQLiteDatabase): Promise<PlannedReminder[]> {
  const databases = getActiveDatabases();
  const scene = (databases && sceneOfDatabase(databases, db.databasePath ?? '')) ?? currentScene();
  const other = otherScene(scene);
  const otherName = databases?.[other];
  // 换了场景：以前读过的「另一个库」现在是当前库（刚被改过），作废
  if (otherCache && otherCache.databaseName !== otherName) otherCache = null;
  const now = new Date();
  const plans: ScenePlan[] = [planScene(scene, await loadSceneInputs(db, scene), now)];
  if (otherName) {
    // 另一个库读不出来时只排当前场景的，别让当前场景的提醒也发不出去
    const inputs = await loadOtherSceneInputs(otherName, other).catch(() => null);
    if (inputs) plans.push(planOtherScene(other, inputs, now));
  }
  const plan = mergeScenePlans(plans);
  const permission = await getPermissionState();
  // 算出来的通知和上次排进系统的完全一样（权限也没变）：系统里排着的就是对的，不用取消了重排
  const signature = scheduleSignature(plan, permission);
  if (signature === lastScheduled) return plan;
  if (permission !== 'granted') {
    lastScheduled = signature;
    return plan;
  }

  // 先清掉记录：下面排到一半出错时，下次照样整份重排
  lastScheduled = null;
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
  lastScheduled = signature;
  return plan;
}

/**
 * 重新排未来的提醒（家庭、办公两个场景都排）。db 是当前场景的库，数据一变就调；多次调用会排队依次执行，
 * 避免「取消全部」和「逐条排程」交错。前面已经有一次在排队、还没开始的，这次不再追加（用这次的 db，结果和那次一样）。
 */
export function rescheduleReminders(db: SQLiteDatabase): Promise<PlannedReminder[]> {
  return coalescedReschedule(db);
}

const coalescedReschedule = createCoalescedQueue(rescheduleNow);

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
