/**
 * 备份文件格式与校验（纯函数，有单测）。
 *
 * 备份是一个 JSON 文件，包含食品 / 日用品（含批次和出入库记录）、设备（含领用记录、人员名单和部门）和提醒设置，
 * 可以只导出其中几类（scope）、其中几个办公点（offices）；导入时也可以只替换其中几个办公点的几类。
 * 办公点在不同手机上按名称对应。
 * 导入时先完整校验，有任何一处不对就整份拒绝，并告诉用户是哪一条、哪个字段，
 * 不会出现「导入一半」的情况。
 */

import { looksLikeEmail, type PersonEntry } from '../db/people';
import { DEFAULT_SETTINGS, type AppSettings } from '../db/settings';
import { isValidDateStr, todayStr, type ShelfLifeUnit } from './dates';
import { validatePacks, type PackUnit } from './packs';
import { roundQty } from './stock';
import { isScene, type Scene } from './terms';
import { validateAccessories, type Accessory } from './warranty';

export const BACKUP_APP = 'item-keeper';
/**
 * 备份格式版本号，当前为 7（1.5.0 起：办公点、分类范围、包装规格、入库价格、设备发票号和芯片 / 内存 / 硬盘）。
 * 更早的格式没有正式使用过，不再兼容，导入时直接提示。
 * 以后改格式要升这个号：旧版 App 读到新号会拒绝，免得它按自己的理解把数据替换掉。
 */
export const BACKUP_FORMAT = 7;
export const OFFICE_NAME_LIMIT = 20;
/** 人员名单的姓名、备注、邮箱和部门名称最多几个字（和 db/people.ts 一样） */
export const PERSON_NAME_LIMIT = 20;
export const PERSON_NOTE_LIMIT = 100;
export const PERSON_EMAIL_LIMIT = 100;
export const DEPARTMENT_NAME_LIMIT = 20;

export type BackupScope = 'food' | 'daily' | 'devices' | 'settings';
export const ALL_SCOPES: BackupScope[] = ['food', 'daily', 'devices', 'settings'];
export const SCOPE_LABEL: Record<BackupScope, string> = {
  food: '食品',
  daily: '日用品',
  devices: '设备',
  settings: '设置',
};

/** 去重并按固定顺序排列。 */
export function normalizeScope(scope: readonly BackupScope[]): BackupScope[] {
  return ALL_SCOPES.filter((item) => scope.includes(item));
}

export function isFullScope(scope: readonly BackupScope[]): boolean {
  return ALL_SCOPES.every((item) => scope.includes(item));
}
const MAX_BACKUP_CHARS = 30 * 1024 * 1024;

export type BackupBatch = { quantity: number; expiryDate: string | null; addedOn: string; note: string | null };

export type BackupMovement = {
  type: 'in' | 'out' | 'adjust';
  delta: number;
  expiryDate: string | null;
  happenedAt: string;
  note: string | null;
  inputQty: number | null;
  inputUnit: string | null;
  /** 入库单价（按 inputUnit 计）和总价，没填为 null */
  unitPrice: number | null;
  totalPrice: number | null;
};

export type BackupProduct = {
  /** 办公点名称 */
  office: string;
  kind: 'food' | 'daily';
  barcode: string | null;
  name: string;
  /** 分类（1.9.5 起）：老备份里没有，导入后是没选。老备份里的 brand（品牌）导入时不读 */
  category: string | null;
  spec: string | null;
  unit: string;
  location: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  /** 保质期（1.9.0 起）：没填的不写；老备份里没有，导入后是没填 */
  shelfLifeAmount?: number | null;
  shelfLifeUnit?: ShelfLifeUnit | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  packs: PackUnit[];
  batches: BackupBatch[];
  movements: BackupMovement[];
};

export type BackupAssignment = {
  person: string;
  quantity: number;
  issuedOn: string;
  returnedOn: string | null;
  note: string | null;
};

export type BackupDevice = {
  /** 办公点名称 */
  office: string;
  category: string;
  name: string;
  model: string | null;
  serialNo: string | null;
  quantity: number;
  note: string | null;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  invoiceNo: string | null;
  /** 电脑的芯片、内存、硬盘 */
  chip: string | null;
  memory: string | null;
  storage: string | null;
  /** 每件设备配的配件 */
  accessories: Accessory[];
  createdAt: string;
  updatedAt: string;
  assignments: BackupAssignment[];
};

export type BackupData = {
  app: typeof BACKUP_APP;
  format: number;
  exportedAt: string;
  /** 这份备份包含哪些分类 */
  scope: BackupScope[];
  /** scope 不含 settings 时为 null */
  settings: AppSettings | null;
  /**
   * 在哪个场景（家庭 / 办公）导出的：导出时总是写（不管选了哪些分类）。导入只导到当前场景、不改场景，
   * 这个字段只用来在导入前提示「这份备份是在「办公」场景导出的」。旧文件可能没有（以前只在含设置时写）。
   * 鸿蒙版写法一样。没加格式版本号：旧版本 App 不认识这个字段，直接忽略。
   */
  scene?: Scene;
  /** 文件里有哪些办公点（含空的），按原顺序 */
  offices: string[];
  products: BackupProduct[];
  devices: BackupDevice[];
  /**
   * 人员名单（员工名单 / 家庭成员），按名单里的顺序：含设备分类时才有。
   * 导入勾了设备时按姓名合并进当前场景的名单；旧文件没有就不动名单。鸿蒙版写法一样：
   * [{ name, email, department, note }]，没有的写 null；department 是部门名。
   * 读文件时某一项缺了（旧文件没有 email、department）就不带这一项，合并时不动本机的；明确为 null 时清空。
   */
  people?: PersonEntry[];
  /**
   * 部门（只有办公场景的界面用）：当前库的全部部门名，按排序，包括还没有人的；含设备分类时才有。
   * 导入勾了设备时先按名称合并（没有的加上，不删本机多出来的），再合并人员；旧文件没有就不动部门。
   */
  departments?: string[];
};

export type OfficeSummary = {
  name: string;
  food: number;
  daily: number;
  devices: number;
};

export type BackupSummary = {
  exportedAt: string;
  scope: BackupScope[];
  offices: OfficeSummary[];
  food: number;
  daily: number;
  devices: number;
  batches: number;
  movements: number;
  assignments: number;
  /** 名单里几个人；文件里没有名单为 0 */
  people: number;
  /** 几个部门；文件里没有为 0 */
  departments: number;
};

// ---------- 导出 ----------

type SourceProduct = Omit<BackupProduct, 'batches' | 'movements' | 'packs' | 'office'> & { id: number; officeId: number };
type SourcePack = PackUnit & { productId: number };
type SourceBatch = BackupBatch & { productId: number };
type SourceMovement = BackupMovement & { productId: number };
type SourceDevice = Omit<BackupDevice, 'assignments' | 'accessories' | 'office'> & { id: number; officeId: number };
type SourceAccessory = Accessory & { deviceId: number };
type SourceAssignment = BackupAssignment & { deviceId: number };

export type BackupSource = {
  settings: AppSettings;
  /** 当前场景 */
  scene: Scene;
  offices: { id: number; name: string }[];
  products: SourceProduct[];
  packs: SourcePack[];
  batches: SourceBatch[];
  movements: SourceMovement[];
  devices: SourceDevice[];
  accessories: SourceAccessory[];
  assignments: SourceAssignment[];
  /** 人员名单，按名单里的顺序 */
  people: PersonEntry[];
  /** 部门名，按排序（含还没有人的） */
  departments: string[];
};

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const list = groups.get(key(item)) ?? [];
    list.push(item);
    groups.set(key(item), list);
  }
  return groups;
}

/**
 * officeIds 为 null 时导出所有办公点。
 */
export function buildBackup(
  source: BackupSource,
  now: Date = new Date(),
  scope: readonly BackupScope[] = ALL_SCOPES,
  officeIds: readonly number[] | null = null,
): BackupData {
  const included = normalizeScope(scope);
  const offices = source.offices.filter((office) => officeIds === null || officeIds.includes(office.id));
  const officeName = new Map(offices.map((office) => [office.id, office.name]));
  const packsByProduct = groupBy(source.packs, (pack) => pack.productId);
  const batchesByProduct = groupBy(source.batches, (batch) => batch.productId);
  const movementsByProduct = groupBy(source.movements, (movement) => movement.productId);
  const assignmentsByDevice = groupBy(source.assignments, (assignment) => assignment.deviceId);
  const accessoriesByDevice = groupBy(source.accessories, (accessory) => accessory.deviceId);

  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: now.toISOString(),
    scope: included,
    settings: included.includes('settings') ? source.settings : null,
    scene: source.scene,
    offices: offices.map((office) => office.name),
    products: source.products
      .filter((product) => included.includes(product.kind) && officeName.has(product.officeId))
      .map(({ id, ...product }) => ({
      office: officeName.get(product.officeId) ?? '',
      kind: product.kind,
      barcode: product.barcode,
      name: product.name,
      category: product.category,
      spec: product.spec,
      unit: product.unit,
      location: product.location,
      lowStockThreshold: product.lowStockThreshold,
      expiryLeadDays: product.expiryLeadDays,
      ...(product.shelfLifeAmount && product.shelfLifeUnit
        ? { shelfLifeAmount: product.shelfLifeAmount, shelfLifeUnit: product.shelfLifeUnit }
        : {}),
      note: product.note,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      packs: (packsByProduct.get(id) ?? []).map((pack) => ({ unit: pack.unit, size: pack.size, barcode: pack.barcode })),
      batches: (batchesByProduct.get(id) ?? [])
        .filter((batch) => batch.quantity > 0)
        .map((batch) => ({
          quantity: batch.quantity,
          expiryDate: batch.expiryDate,
          addedOn: batch.addedOn,
          note: batch.note,
        })),
      movements: (movementsByProduct.get(id) ?? []).map((movement) => ({
        type: movement.type,
        delta: movement.delta,
        expiryDate: movement.expiryDate,
        happenedAt: movement.happenedAt,
        note: movement.note,
        inputQty: movement.inputQty,
        inputUnit: movement.inputUnit,
        unitPrice: movement.unitPrice,
        totalPrice: movement.totalPrice,
      })),
    })),
    devices: (included.includes('devices') ? source.devices : [])
      .filter((device) => officeName.has(device.officeId))
      .map(({ id, ...device }) => ({
      office: officeName.get(device.officeId) ?? '',
      category: device.category,
      name: device.name,
      model: device.model,
      serialNo: device.serialNo,
      quantity: device.quantity,
      note: device.note,
      purchaseDate: device.purchaseDate,
      warrantyUntil: device.warrantyUntil,
      invoiceNo: device.invoiceNo,
      chip: device.chip,
      memory: device.memory,
      storage: device.storage,
      accessories: (accessoriesByDevice.get(id) ?? []).map((accessory) => ({
        name: accessory.name,
        quantity: accessory.quantity,
      })),
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
      assignments: (assignmentsByDevice.get(id) ?? []).map((assignment) => ({
        person: assignment.person,
        quantity: assignment.quantity,
        issuedOn: assignment.issuedOn,
        returnedOn: assignment.returnedOn,
        note: assignment.note,
      })),
    })),
    ...(included.includes('devices')
      ? {
          people: (source.people ?? []).map((person) => ({
            name: person.name,
            email: person.email ?? null,
            department: person.department ?? null,
            note: person.note ?? null,
          })),
          departments: [...(source.departments ?? [])],
        }
      : {}),
  };
}

export function summarizeBackup(data: BackupData): BackupSummary {
  return {
    exportedAt: data.exportedAt,
    scope: data.scope,
    offices: data.offices.map((name) => ({
      name,
      food: data.products.filter((product) => product.office === name && product.kind === 'food').length,
      daily: data.products.filter((product) => product.office === name && product.kind === 'daily').length,
      devices: data.devices.filter((device) => device.office === name).length,
    })),
    food: data.products.filter((product) => product.kind === 'food').length,
    daily: data.products.filter((product) => product.kind === 'daily').length,
    devices: data.devices.length,
    batches: data.products.reduce((sum, product) => sum + product.batches.length, 0),
    movements: data.products.reduce((sum, product) => sum + product.movements.length, 0),
    assignments: data.devices.reduce((sum, device) => sum + device.assignments.length, 0),
    people: data.people?.length ?? 0,
    departments: data.departments?.length ?? 0,
  };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 文件名里不能出现的字符换成下划线。 */
function safeFilePart(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, '_');
}

/**
 * 全部：item-keeper-backup-20261118-0930.json；部分分类：item-keeper-food-devices-20261118-0930.json；
 * 只导出一个办公点时带上它的名字：item-keeper-北京-food-20261118-0930.json
 */
export function backupFileName(
  now: Date = new Date(),
  scope: readonly BackupScope[] = ALL_SCOPES,
  officeNames: readonly string[] | null = null,
): string {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  const part = isFullScope(scope) ? 'backup' : normalizeScope(scope).join('-');
  const office = officeNames && officeNames.length === 1 ? `${safeFilePart(officeNames[0])}-` : '';
  return `item-keeper-${office}${part}-${stamp}.json`;
}

export type KeptProduct = { name: string; kind: 'food' | 'daily'; barcodes: string[] };

/**
 * 只替换部分分类时，导进来的物品条码不能和手机上保留下来的（没被替换的分类里的）物品撞。
 * 撞了返回给用户看的说明，没问题返回 null。
 */
export function findBarcodeConflict(incoming: BackupProduct[], kept: KeptProduct[]): string | null {
  const owner = new Map<string, KeptProduct>();
  for (const product of kept) for (const code of product.barcodes) owner.set(code, product);
  for (const product of incoming) {
    const codes = [product.barcode, ...product.packs.map((pack) => pack.barcode)].filter((code): code is string => !!code);
    for (const code of codes) {
      const existing = owner.get(code);
      if (existing) {
        return `条码 ${code} 在备份的「${product.name}」和手机上${SCOPE_LABEL[existing.kind]}里的「${existing.name}」重复，没法导入；可以先改掉其中一个的条码`;
      }
    }
  }
  return null;
}

// ---------- 导入校验 ----------

class BackupError extends Error {}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(where: string, message: string): never {
  throw new BackupError(where ? `${where}：${message}` : message);
}

function optText(value: unknown, where: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(where, `${field}应该是文字`);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function reqText(value: unknown, where: string, field: string): string {
  const text = optText(value, where, field);
  if (!text) fail(where, `缺少${field}`);
  return text;
}

function optDate(value: unknown, where: string, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidDateStr(value as string)) fail(where, `${field}「${String(value)}」不是有效日期（应为 2026-01-31 这种格式）`);
  return value as string;
}

function reqDate(value: unknown, where: string, field: string): string {
  const date = optDate(value, where, field);
  if (!date) fail(where, `缺少${field}`);
  return date;
}

function optNumber(value: unknown, where: string, field: string, min: number, max: number, integer = false): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(where, `${field}「${String(value)}」不对`);
  }
  return value;
}

function timestamp(value: unknown, fallback: string): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return fallback;
}

function list(value: unknown, where: string, field: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(where, `${field}应该是列表`);
  return value;
}

function parseSettings(value: unknown): AppSettings {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (isObj(value)) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      if (typeof value[key] === typeof DEFAULT_SETTINGS[key]) settings[key] = value[key];
    }
  }
  return settings as AppSettings;
}

/** 每项都要写办公点，且必须在文件的办公点名单里。 */
function parseOffice(raw: Obj, where: string, offices: string[]): string {
  const office = reqText(raw.office, where, '办公点');
  if (!offices.includes(office)) fail(where, `办公点「${office}」不在文件的办公点名单里`);
  return office;
}

function parseProduct(raw: unknown, index: number, exportedAt: string, offices: string[]): BackupProduct {
  let where = `第 ${index + 1} 个物品`;
  if (!isObj(raw)) fail(where, '格式不对');
  const name = reqText(raw.name, where, '名称');
  where = `${where}「${name}」`;
  const office = parseOffice(raw, where, offices);
  if (raw.kind !== 'food' && raw.kind !== 'daily') fail(where, `类别「${String(raw.kind)}」应为 food 或 daily`);

  const batches: BackupBatch[] = [];
  list(raw.batches, where, '批次').forEach((batch, batchIndex) => {
    const at = `${where}的第 ${batchIndex + 1} 批`;
    if (!isObj(batch)) fail(at, '格式不对');
    const quantity = optNumber(batch.quantity, at, '数量', 0, 1e9) ?? fail(at, '缺少数量');
    if (quantity <= 0) return;
    batches.push({
      quantity: roundQty(quantity),
      expiryDate: optDate(batch.expiryDate, at, '过期日期'),
      addedOn: optDate(batch.addedOn, at, '入库日期') ?? exportedAt.slice(0, 10),
      note: optText(batch.note, at, '备注'),
    });
  });

  const movements: BackupMovement[] = list(raw.movements, where, '出入库记录').map((movement, movementIndex) => {
    const at = `${where}的第 ${movementIndex + 1} 条出入库记录`;
    if (!isObj(movement)) fail(at, '格式不对');
    if (movement.type !== 'in' && movement.type !== 'out' && movement.type !== 'adjust') {
      fail(at, `类型「${String(movement.type)}」不对`);
    }
    const delta = optNumber(movement.delta, at, '数量变化', -1e9, 1e9) ?? fail(at, '缺少数量变化');
    if (typeof movement.happenedAt !== 'string' || Number.isNaN(Date.parse(movement.happenedAt))) {
      fail(at, '时间不对');
    }
    return {
      type: movement.type,
      delta: roundQty(delta),
      expiryDate: optDate(movement.expiryDate, at, '过期日期'),
      happenedAt: movement.happenedAt,
      note: optText(movement.note, at, '备注'),
      inputQty: optNumber(movement.inputQty, at, '输入数量', 0, 1e9),
      inputUnit: optText(movement.inputUnit, at, '输入单位'),
      unitPrice: optNumber(movement.unitPrice, at, '单价', 0, 1e9),
      totalPrice: optNumber(movement.totalPrice, at, '总价', 0, 1e12),
    };
  });

  const unit = optText(raw.unit, where, '单位') ?? '件';
  const packs: PackUnit[] = list(raw.packs, where, '包装规格').map((pack, packIndex) => {
    const at = `${where}的第 ${packIndex + 1} 个包装规格`;
    if (!isObj(pack)) fail(at, '格式不对');
    return {
      unit: reqText(pack.unit, at, '包装单位'),
      size: optNumber(pack.size, at, '换算数量', 0, 1e9) ?? fail(at, '缺少换算数量'),
      barcode: optText(pack.barcode, at, '条码'),
    };
  });
  const packError = validatePacks(unit, packs);
  if (packError) fail(where, packError);

  return {
    office,
    kind: raw.kind,
    barcode: optText(raw.barcode, where, '条码'),
    name,
    category: optText(raw.category, where, '分类'),
    spec: optText(raw.spec, where, '规格'),
    unit,
    location: optText(raw.location, where, '存放位置'),
    lowStockThreshold: optNumber(raw.lowStockThreshold, where, '库存下限', 0, 1e9),
    expiryLeadDays: optNumber(raw.expiryLeadDays, where, '到期提前天数', 0, 365, true),
    ...parseShelfLife(raw, where),
    note: optText(raw.note, where, '备注'),
    createdAt: timestamp(raw.createdAt, exportedAt),
    updatedAt: timestamp(raw.updatedAt, exportedAt),
    packs,
    batches,
    movements,
  };
}

/** 保质期：数量和单位要么都有要么都没有 */
function parseShelfLife(raw: Record<string, unknown>, where: string): Pick<BackupProduct, 'shelfLifeAmount' | 'shelfLifeUnit'> {
  const amount = optNumber(raw.shelfLifeAmount, where, '保质期', 1, 9999, true);
  const unit = raw.shelfLifeUnit;
  if (amount === null && (unit === undefined || unit === null)) return {};
  if (amount === null || (unit !== 'day' && unit !== 'month' && unit !== 'year')) fail(where, '保质期不对');
  return { shelfLifeAmount: amount, shelfLifeUnit: unit };
}

function parseDevice(raw: unknown, index: number, exportedAt: string, offices: string[]): BackupDevice {
  let where = `第 ${index + 1} 台设备`;
  if (!isObj(raw)) fail(where, '格式不对');
  const name = reqText(raw.name, where, '名称');
  where = `${where}「${name}」`;
  const office = parseOffice(raw, where, offices);
  const quantity = optNumber(raw.quantity, where, '数量', 1, 1e6, true) ?? 1;

  const assignments: BackupAssignment[] = list(raw.assignments, where, '领用记录').map((assignment, assignmentIndex) => {
    const at = `${where}的第 ${assignmentIndex + 1} 条领用记录`;
    if (!isObj(assignment)) fail(at, '格式不对');
    const issuedOn = reqDate(assignment.issuedOn, at, '领取日期');
    const returnedOn = optDate(assignment.returnedOn, at, '退还日期');
    if (returnedOn && returnedOn < issuedOn) fail(at, '退还日期早于领取日期');
    return {
      person: reqText(assignment.person, at, '使用人'),
      quantity: optNumber(assignment.quantity, at, '数量', 1, 1e6, true) ?? 1,
      issuedOn,
      returnedOn,
      note: optText(assignment.note, at, '备注'),
    };
  });

  const outQty = assignments
    .filter((assignment) => !assignment.returnedOn)
    .reduce((sum, assignment) => sum + assignment.quantity, 0);
  if (outQty > quantity) fail(where, `借出 ${outQty} 件，比总数 ${quantity} 件还多`);

  const accessories: Accessory[] = list(raw.accessories, where, '配件').map((accessory, accessoryIndex) => {
    const at = `${where}的第 ${accessoryIndex + 1} 个配件`;
    if (!isObj(accessory)) fail(at, '格式不对');
    return {
      name: reqText(accessory.name, at, '名称'),
      quantity: optNumber(accessory.quantity, at, '数量', 1, 9999, true) ?? 1,
    };
  });
  const accessoryError = validateAccessories(accessories);
  if (accessoryError) fail(where, accessoryError);
  const purchaseDate = optDate(raw.purchaseDate, where, '购买日期');
  const category = optText(raw.category, where, '类别') ?? '其他';
  const deviceConfig = {
    model: optText(raw.model, where, '型号'),
    chip: optText(raw.chip, where, '芯片'),
    memory: optText(raw.memory, where, '内存'),
    storage: optText(raw.storage, where, '硬盘'),
  };
  const warrantyUntil = optDate(raw.warrantyUntil, where, '保修到期日');

  return {
    office,
    category,
    name,
    serialNo: optText(raw.serialNo, where, '序列号'),
    quantity,
    note: optText(raw.note, where, '备注'),
    purchaseDate,
    warrantyUntil,
    invoiceNo: optText(raw.invoiceNo, where, '发票号'),
    ...deviceConfig,
    accessories,
    createdAt: timestamp(raw.createdAt, exportedAt),
    updatedAt: timestamp(raw.updatedAt, exportedAt),
    assignments,
  };
}

/**
 * 人员名单：每人要有姓名（最多 20 个字）；邮箱、部门、备注选填（邮箱要像邮箱、最多 100 个字，部门名最多 20 个字，
 * 备注最多 100 个字）；姓名不分大小写不能重复，邮箱不要求唯一。
 * 缺了的项不带（合并时不动本机的），写了 null 的带 null（合并时清空）。邮箱转成小写。
 */
function parsePeople(value: unknown): PersonEntry[] {
  const seen = new Set<string>();
  return list(value, '', '人员名单').map((raw, index) => {
    let where = `人员名单第 ${index + 1} 个`;
    if (!isObj(raw)) fail(where, '格式不对');
    const name = reqText(raw.name, where, '姓名');
    if (name.length > PERSON_NAME_LIMIT) fail(where, `姓名「${name}」超过 ${PERSON_NAME_LIMIT} 个字`);
    where = `${where}「${name}」`;
    const key = name.toLowerCase();
    if (seen.has(key)) fail('', `人员名单里「${name}」重复了`);
    seen.add(key);
    const entry: PersonEntry = { name };
    if (raw.email !== undefined) {
      const email = optText(raw.email, where, '邮箱')?.toLowerCase() ?? null;
      if (email && email.length > PERSON_EMAIL_LIMIT) fail(where, `邮箱超过 ${PERSON_EMAIL_LIMIT} 个字`);
      if (email && !looksLikeEmail(email)) fail(where, `邮箱「${email}」格式不对`);
      entry.email = email;
    }
    if (raw.department !== undefined) {
      const department = optText(raw.department, where, '部门');
      if (department && department.length > DEPARTMENT_NAME_LIMIT) fail(where, `部门「${department}」超过 ${DEPARTMENT_NAME_LIMIT} 个字`);
      entry.department = department;
    }
    if (raw.note !== undefined) {
      const note = optText(raw.note, where, '备注');
      if (note && note.length > PERSON_NOTE_LIMIT) fail(where, `备注超过 ${PERSON_NOTE_LIMIT} 个字`);
      entry.note = note;
    }
    return entry;
  });
}

/** 部门：名称必填、最多 20 个字，不分大小写不能重复 */
function parseDepartments(value: unknown): string[] {
  const seen = new Set<string>();
  return list(value, '', '部门').map((raw, index) => {
    const name = reqText(raw, `第 ${index + 1} 个部门`, '名称');
    if (name.length > DEPARTMENT_NAME_LIMIT) fail('', `部门名称「${name}」超过 ${DEPARTMENT_NAME_LIMIT} 个字`);
    const key = name.toLowerCase();
    if (seen.has(key)) fail('', `部门「${name}」重复了`);
    seen.add(key);
    return name;
  });
}

export type ParseResult = { ok: true; data: BackupData; summary: BackupSummary } | { ok: false; error: string };

export function parseBackup(text: string): ParseResult {
  try {
    if (text.length > MAX_BACKUP_CHARS) fail('', '文件太大，不像是物品管家的备份');
    let root: unknown;
    try {
      root = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      fail('', '文件内容不是 JSON，不是物品管家的备份文件');
    }
    if (!isObj(root) || root.app !== BACKUP_APP) fail('', '这不是物品管家的备份文件');
    const format = typeof root.format === 'number' ? root.format : 0;
    if (format < 1) fail('', '备份文件缺少版本号，可能已损坏');
    if (format > BACKUP_FORMAT) fail('', '这个备份来自更新版本的 App，请先升级 App 再导入');
    if (format < BACKUP_FORMAT) fail('', '这是旧版本 App 导出的备份，现在不支持了，请对方升级 App 后重新导出');
    const exportedAt = timestamp(root.exportedAt, `${todayStr()}T00:00:00.000Z`);

    const rawScope = list(root.scope, '', '分类');
    if (!rawScope.length) fail('', '备份没写包含哪些分类，可能已损坏');
    for (const item of rawScope) {
      if (!ALL_SCOPES.includes(item as BackupScope)) fail('', `不认识的分类「${String(item)}」`);
    }
    const scope = normalizeScope(rawScope as BackupScope[]);

    const offices = list(root.offices, '', '办公点').map((raw, index) => {
      const name = reqText(raw, `第 ${index + 1} 个办公点`, '名称');
      if (name.length > OFFICE_NAME_LIMIT) fail('', `办公点名称「${name}」超过 ${OFFICE_NAME_LIMIT} 个字`);
      return name;
    });
    if (!offices.length) fail('', '备份没写包含哪些办公点，可能已损坏');
    if (new Set(offices).size !== offices.length) fail('', '备份里的办公点名称有重复');

    const products = list(root.products, '', '物品').map((raw, index) => parseProduct(raw, index, exportedAt, offices));
    const devices = list(root.devices, '', '设备').map((raw, index) => parseDevice(raw, index, exportedAt, offices));
    for (const product of products) {
      if (!scope.includes(product.kind)) fail('', `备份标明不含${SCOPE_LABEL[product.kind]}，里面却有「${product.name}」，文件可能被改坏了`);
    }
    if (devices.length && !scope.includes('devices')) fail('', '备份标明不含设备，里面却有设备，文件可能被改坏了');

    // 物品条码和包装条码在同一个办公点里不能重复
    const barcodeOwner = new Map<string, string>();
    for (const product of products) {
      const place = `${product.office}的`;
      const codes: [string | null, string][] = [
        [product.barcode, `${place}「${product.name}」`],
        ...product.packs.map((pack): [string | null, string] => [pack.barcode, `${place}「${product.name}」的${pack.unit}`]),
      ];
      for (const [code, label] of codes) {
        if (!code) continue;
        const key = `${product.office}\u0000${code}`;
        const owner = barcodeOwner.get(key);
        if (owner) fail('', `条码 ${code} 同时出现在${owner}和${label}`);
        barcodeOwner.set(key, label);
      }
    }

    const data: BackupData = {
      app: BACKUP_APP,
      format,
      exportedAt,
      scope,
      settings: scope.includes('settings') ? parseSettings(root.settings) : null,
      ...(isScene(root.scene) ? { scene: root.scene } : {}),
      offices,
      products,
      devices,
      // 名单、部门跟着设备走：含设备、文件里也有时才读；旧文件没有就不带（导入时不动名单、部门）
      ...(scope.includes('devices') && root.people !== undefined && root.people !== null
        ? { people: parsePeople(root.people) }
        : {}),
      ...(scope.includes('devices') && root.departments !== undefined && root.departments !== null
        ? { departments: parseDepartments(root.departments) }
        : {}),
    };
    return { ok: true, data, summary: summarizeBackup(data) };
  } catch (error) {
    if (error instanceof BackupError) return { ok: false, error: error.message };
    return { ok: false, error: '读备份文件时出错了，文件可能已损坏' };
  }
}
