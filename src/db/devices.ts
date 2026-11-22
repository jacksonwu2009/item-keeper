import type { SQLiteDatabase } from 'expo-sqlite';

import { todayStr } from '../lib/dates';
import type { Accessory } from '../lib/warranty';

export const DEVICE_CATEGORIES = ['笔记本', '台式机', '显示器', '键盘', '鼠标', '耳机', '扩展坞', '充电器', '手机', '平板', '其他'];

export type Device = {
  id: number;
  officeId: number;
  category: string;
  name: string;
  model: string | null;
  serialNo: string | null;
  quantity: number;
  note: string | null;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  /** 发票号 */
  invoiceNo: string | null;
  /** 电脑的芯片、内存、硬盘，如 M3 Pro、18G、512G；不是电脑为 null */
  chip: string | null;
  memory: string | null;
  storage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeviceSummary = Device & {
  /** 正在被领用（还没退还）的数量 */
  outQty: number;
  /** 当前使用人，用「、」连接 */
  holders: string | null;
};

export type DeviceAssignment = {
  id: number;
  deviceId: number;
  person: string;
  quantity: number;
  issuedOn: string;
  returnedOn: string | null;
  note: string | null;
};

export type ActiveAssignment = DeviceAssignment & {
  officeId: number;
  deviceName: string;
  deviceModel: string | null;
  category: string;
};

export type DeviceInput = {
  officeId: number;
  category: string;
  name: string;
  model: string | null;
  serialNo: string | null;
  quantity: number;
  note: string | null;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  /** 发票号 */
  invoiceNo: string | null;
  chip: string | null;
  memory: string | null;
  storage: string | null;
  /** 每件设备配的配件 */
  accessories: Accessory[];
};

export type AssignmentInput = {
  person: string;
  quantity: number;
  issuedOn: string;
  returnedOn: string | null;
  note: string | null;
};

const DEVICE_COLUMNS = `
  d.id, d.office_id AS officeId, d.category, d.name, d.model, d.serial_no AS serialNo, d.quantity, d.note,
  d.purchase_date AS purchaseDate, d.warranty_until AS warrantyUntil, d.invoice_no AS invoiceNo,
  d.chip, d.memory, d.storage,
  d.created_at AS createdAt, d.updated_at AS updatedAt`;

const ASSIGNMENT_COLUMNS = `
  a.id, a.device_id AS deviceId, a.person, a.quantity, a.issued_on AS issuedOn,
  a.returned_on AS returnedOn, a.note`;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** officeId 为 null 时列出所有办公点的。 */
export async function listDevices(db: SQLiteDatabase, officeId: number | null = null): Promise<DeviceSummary[]> {
  return db.getAllAsync<DeviceSummary>(
    `SELECT ${DEVICE_COLUMNS},
            COALESCE(SUM(CASE WHEN a.returned_on IS NULL THEN a.quantity END), 0) AS outQty,
            GROUP_CONCAT(CASE WHEN a.returned_on IS NULL THEN a.person END, '、') AS holders
       FROM device d
       LEFT JOIN device_assignment a ON a.device_id = d.id
      WHERE ? IS NULL OR d.office_id = ?
      GROUP BY d.id
      ORDER BY d.category, d.name COLLATE NOCASE`,
    [officeId, officeId],
  );
}

export async function getDevice(db: SQLiteDatabase, id: number): Promise<Device | null> {
  return db.getFirstAsync<Device>(`SELECT ${DEVICE_COLUMNS} FROM device d WHERE d.id = ?`, [id]);
}

export async function listAssignments(db: SQLiteDatabase, deviceId: number): Promise<DeviceAssignment[]> {
  return db.getAllAsync<DeviceAssignment>(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM device_assignment a
      WHERE a.device_id = ?
      ORDER BY a.returned_on IS NOT NULL, a.issued_on DESC, a.id DESC`,
    [deviceId],
  );
}

export async function getAssignment(db: SQLiteDatabase, id: number): Promise<DeviceAssignment | null> {
  return db.getFirstAsync<DeviceAssignment>(`SELECT ${ASSIGNMENT_COLUMNS} FROM device_assignment a WHERE a.id = ?`, [
    id,
  ]);
}

export async function listActiveAssignments(
  db: SQLiteDatabase,
  officeId: number | null = null,
): Promise<ActiveAssignment[]> {
  return db.getAllAsync<ActiveAssignment>(
    `SELECT ${ASSIGNMENT_COLUMNS}, d.name AS deviceName, d.model AS deviceModel, d.category, d.office_id AS officeId
       FROM device_assignment a JOIN device d ON d.id = a.device_id
      WHERE a.returned_on IS NULL AND (? IS NULL OR d.office_id = ?)
      ORDER BY a.person, a.issued_on`,
    [officeId, officeId],
  );
}

export async function listPeople(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ person: string }>(
    `SELECT person FROM device_assignment GROUP BY person ORDER BY MAX(issued_on) DESC, MAX(id) DESC LIMIT 20`,
  );
  return rows.map((row) => row.person);
}

function deviceParams(input: DeviceInput) {
  return [
    input.officeId,
    input.category.trim() || '其他',
    input.name.trim(),
    emptyToNull(input.model),
    emptyToNull(input.serialNo),
    Math.max(1, Math.floor(input.quantity)),
    emptyToNull(input.note),
    input.purchaseDate,
    input.warrantyUntil,
    emptyToNull(input.invoiceNo),
    emptyToNull(input.chip),
    emptyToNull(input.memory),
    emptyToNull(input.storage),
  ];
}

export async function listAccessories(db: SQLiteDatabase, deviceId: number): Promise<Accessory[]> {
  return db.getAllAsync<Accessory>('SELECT name, quantity FROM device_accessory WHERE device_id = ? ORDER BY sort, id', [
    deviceId,
  ]);
}

export async function listAllAccessories(db: SQLiteDatabase): Promise<(Accessory & { deviceId: number })[]> {
  return db.getAllAsync<Accessory & { deviceId: number }>(
    'SELECT device_id AS deviceId, name, quantity FROM device_accessory ORDER BY device_id, sort, id',
  );
}

async function saveAccessories(db: SQLiteDatabase, deviceId: number, accessories: Accessory[]): Promise<void> {
  await db.runAsync('DELETE FROM device_accessory WHERE device_id = ?', [deviceId]);
  let sort = 0;
  for (const item of accessories) {
    await db.runAsync('INSERT INTO device_accessory (device_id, name, quantity, sort) VALUES (?, ?, ?, ?)', [
      deviceId,
      item.name.trim(),
      Math.max(1, Math.floor(item.quantity)),
      sort++,
    ]);
  }
}

export async function createDevice(db: SQLiteDatabase, input: DeviceInput): Promise<number> {
  let deviceId = 0;
  await db.withTransactionAsync(async () => {
    const now = nowIso();
    const result = await db.runAsync(
      `INSERT INTO device
         (office_id, category, name, model, serial_no, quantity, note, purchase_date, warranty_until, invoice_no,
          chip, memory, storage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...deviceParams(input), now, now],
    );
    deviceId = result.lastInsertRowId;
    await saveAccessories(db, deviceId, input.accessories);
  });
  return deviceId;
}

export async function updateDevice(db: SQLiteDatabase, id: number, input: DeviceInput): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE device SET office_id = ?, category = ?, name = ?, model = ?, serial_no = ?, quantity = ?, note = ?,
              purchase_date = ?, warranty_until = ?, invoice_no = ?, chip = ?, memory = ?, storage = ?, updated_at = ?
        WHERE id = ?`,
      [...deviceParams(input), nowIso(), id],
    );
    await saveAccessories(db, id, input.accessories);
  });
}

/** 按序列号找设备（不管大小写）；officeId 为 null 时在所有办公点里找。 */
export async function findDeviceBySerial(
  db: SQLiteDatabase,
  serialNo: string,
  officeId: number | null = null,
): Promise<Device | null> {
  const serial = serialNo.trim();
  if (!serial) return null;
  return db.getFirstAsync<Device>(
    `SELECT ${DEVICE_COLUMNS} FROM device d
      WHERE d.serial_no = ? COLLATE NOCASE AND (? IS NULL OR d.office_id = ?)
      ORDER BY d.id LIMIT 1`,
    [serial, officeId, officeId],
  );
}

export type DeviceTemplate = {
  category: string;
  name: string;
  model: string | null;
  chip: string | null;
  memory: string | null;
  storage: string | null;
  accessories: Accessory[];
  /** 登记过几次 */
  uses: number;
};

/**
 * 登记过的「类别 + 名称 + 型号 + 配置」组合，用得多的、最近的排前面；新增设备时直接选。
 * 配件取这个组合最近登记的那一台的。
 */
export async function listDeviceTemplates(db: SQLiteDatabase, limit = 8): Promise<DeviceTemplate[]> {
  const rows = await db.getAllAsync<Omit<DeviceTemplate, 'accessories'> & { latestId: number }>(
    `SELECT category, name, model, chip, memory, storage, COUNT(*) AS uses, MAX(id) AS latestId
       FROM device
      GROUP BY category, name COLLATE NOCASE, model, chip, memory, storage
      ORDER BY uses DESC, latestId DESC
      LIMIT ?`,
    [limit],
  );
  const templates: DeviceTemplate[] = [];
  for (const { latestId, ...row } of rows) {
    templates.push({ ...row, accessories: await listAccessories(db, latestId) });
  }
  return templates;
}

export async function deleteDevice(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM device WHERE id = ?', [id]);
}

export async function outQuantity(db: SQLiteDatabase, deviceId: number, excludeAssignmentId?: number): Promise<number> {
  const row = await db.getFirstAsync<{ outQty: number }>(
    `SELECT COALESCE(SUM(quantity), 0) AS outQty FROM device_assignment
      WHERE device_id = ? AND returned_on IS NULL AND id != ?`,
    [deviceId, excludeAssignmentId ?? -1],
  );
  return row?.outQty ?? 0;
}

/** 领用。超出在库数量时抛错，错误信息直接给用户看。 */
export async function issueDevice(db: SQLiteDatabase, deviceId: number, input: AssignmentInput): Promise<void> {
  const device = await getDevice(db, deviceId);
  if (!device) throw new Error('设备不存在');
  const available = device.quantity - (await outQuantity(db, deviceId));
  if (input.quantity > available) throw new Error(`在库只剩 ${available} 件，不能领用 ${input.quantity} 件`);
  await db.runAsync(
    `INSERT INTO device_assignment (device_id, person, quantity, issued_on, returned_on, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [deviceId, input.person.trim(), Math.max(1, Math.floor(input.quantity)), input.issuedOn, input.returnedOn, emptyToNull(input.note)],
  );
  await db.runAsync('UPDATE device SET updated_at = ? WHERE id = ?', [nowIso(), deviceId]);
}

/** 退还。只退一部分时，把这条记录拆成「已退还」和「仍在用」两条。 */
export async function returnDevice(
  db: SQLiteDatabase,
  assignmentId: number,
  returnedOn: string,
  quantity?: number,
): Promise<void> {
  const assignment = await getAssignment(db, assignmentId);
  if (!assignment) throw new Error('领用记录不存在');
  if (assignment.returnedOn) return;
  if (returnedOn < assignment.issuedOn) throw new Error('退还日期不能早于领取日期');
  const returnQty = quantity === undefined ? assignment.quantity : Math.floor(quantity);
  if (returnQty < 1 || returnQty > assignment.quantity) throw new Error(`退还数量应在 1 到 ${assignment.quantity} 之间`);

  await db.withTransactionAsync(async () => {
    if (returnQty === assignment.quantity) {
      await db.runAsync('UPDATE device_assignment SET returned_on = ? WHERE id = ?', [returnedOn, assignmentId]);
    } else {
      await db.runAsync('UPDATE device_assignment SET quantity = ? WHERE id = ?', [
        assignment.quantity - returnQty,
        assignmentId,
      ]);
      await db.runAsync(
        `INSERT INTO device_assignment (device_id, person, quantity, issued_on, returned_on, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [assignment.deviceId, assignment.person, returnQty, assignment.issuedOn, returnedOn, assignment.note],
      );
    }
    await db.runAsync('UPDATE device SET updated_at = ? WHERE id = ?', [nowIso(), assignment.deviceId]);
  });
}

/** 「谁在用」最多几个字（和人员名字差不多长） */
export const HOLDER_NAME_MAX = 20;

/**
 * 家庭场景的「谁在用」：没还的领用记录都按今天还掉（开始日期在今天之后的按开始那天），person 不为空时再记一条
 * 1 件、今天开始的领用。和现在一样的一个人就什么都不做。数据还是领用记录，切回办公场景时显示成这个人领用中。
 */
export async function setDeviceHolder(
  db: SQLiteDatabase,
  deviceId: number,
  person: string | null,
  today: string = todayStr(),
): Promise<void> {
  const name = person?.trim() ? person.trim() : null;
  const open = await db.getAllAsync<{ id: number; person: string; issuedOn: string }>(
    'SELECT id, person, issued_on AS issuedOn FROM device_assignment WHERE device_id = ? AND returned_on IS NULL',
    [deviceId],
  );
  if (name && open.length === 1 && open[0].person === name) return;
  if (!name && open.length === 0) return;
  // 办公场景记的使用人没限长；只在要新记一条时查
  if (name && name.length > HOLDER_NAME_MAX) throw new Error(`名字最多 ${HOLDER_NAME_MAX} 个字`);
  await db.withTransactionAsync(async () => {
    for (const row of open) {
      await db.runAsync('UPDATE device_assignment SET returned_on = ? WHERE id = ?', [
        row.issuedOn > today ? row.issuedOn : today,
        row.id,
      ]);
    }
    if (name) {
      await db.runAsync(
        'INSERT INTO device_assignment (device_id, person, quantity, issued_on, returned_on, note) VALUES (?, ?, 1, ?, NULL, NULL)',
        [deviceId, name, today],
      );
    }
    await db.runAsync('UPDATE device SET updated_at = ? WHERE id = ?', [nowIso(), deviceId]);
  });
}

export async function updateAssignment(db: SQLiteDatabase, id: number, input: AssignmentInput): Promise<void> {
  const assignment = await getAssignment(db, id);
  if (!assignment) throw new Error('领用记录不存在');
  if (input.returnedOn && input.returnedOn < input.issuedOn) throw new Error('退还日期不能早于领取日期');
  if (!input.returnedOn) {
    const device = await getDevice(db, assignment.deviceId);
    const available = (device?.quantity ?? 0) - (await outQuantity(db, assignment.deviceId, id));
    if (input.quantity > available) throw new Error(`在库只剩 ${available} 件，不能领用 ${input.quantity} 件`);
  }
  await db.runAsync(
    `UPDATE device_assignment SET person = ?, quantity = ?, issued_on = ?, returned_on = ?, note = ? WHERE id = ?`,
    [input.person.trim(), Math.max(1, Math.floor(input.quantity)), input.issuedOn, input.returnedOn, emptyToNull(input.note), id],
  );
}

export async function deleteAssignment(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM device_assignment WHERE id = ?', [id]);
}
