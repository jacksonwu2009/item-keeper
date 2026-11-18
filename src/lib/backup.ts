/**
 * 备份文件格式与校验（纯函数，有单测）。
 *
 * 备份是一个 JSON 文件，包含全部食品 / 日用品（含批次和出入库记录）、设备（含领用记录）和设置。
 * 导入时先完整校验，有任何一处不对就整份拒绝，并告诉用户是哪一条、哪个字段，
 * 不会出现「导入一半」的情况。
 */

import { DEFAULT_SETTINGS, type AppSettings } from '../db/settings';
import { isValidDateStr, todayStr } from './dates';
import { roundQty } from './stock';

export const BACKUP_APP = 'item-keeper';
export const BACKUP_FORMAT = 1;
const MAX_BACKUP_CHARS = 30 * 1024 * 1024;

export type BackupBatch = { quantity: number; expiryDate: string | null; addedOn: string; note: string | null };

export type BackupMovement = {
  type: 'in' | 'out' | 'adjust';
  delta: number;
  expiryDate: string | null;
  happenedAt: string;
  note: string | null;
};

export type BackupProduct = {
  kind: 'food' | 'daily';
  barcode: string | null;
  name: string;
  brand: string | null;
  spec: string | null;
  unit: string;
  location: string | null;
  lowStockThreshold: number | null;
  expiryLeadDays: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
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
  category: string;
  name: string;
  model: string | null;
  serialNo: string | null;
  quantity: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  assignments: BackupAssignment[];
};

export type BackupData = {
  app: typeof BACKUP_APP;
  format: number;
  exportedAt: string;
  settings: AppSettings;
  products: BackupProduct[];
  devices: BackupDevice[];
};

export type BackupSummary = {
  exportedAt: string;
  food: number;
  daily: number;
  devices: number;
  batches: number;
  movements: number;
  assignments: number;
};

// ---------- 导出 ----------

type SourceProduct = Omit<BackupProduct, 'batches' | 'movements'> & { id: number };
type SourceBatch = BackupBatch & { productId: number };
type SourceMovement = BackupMovement & { productId: number };
type SourceDevice = Omit<BackupDevice, 'assignments'> & { id: number };
type SourceAssignment = BackupAssignment & { deviceId: number };

export type BackupSource = {
  settings: AppSettings;
  products: SourceProduct[];
  batches: SourceBatch[];
  movements: SourceMovement[];
  devices: SourceDevice[];
  assignments: SourceAssignment[];
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

export function buildBackup(source: BackupSource, now: Date = new Date()): BackupData {
  const batchesByProduct = groupBy(source.batches, (batch) => batch.productId);
  const movementsByProduct = groupBy(source.movements, (movement) => movement.productId);
  const assignmentsByDevice = groupBy(source.assignments, (assignment) => assignment.deviceId);

  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: now.toISOString(),
    settings: source.settings,
    products: source.products.map(({ id, ...product }) => ({
      kind: product.kind,
      barcode: product.barcode,
      name: product.name,
      brand: product.brand,
      spec: product.spec,
      unit: product.unit,
      location: product.location,
      lowStockThreshold: product.lowStockThreshold,
      expiryLeadDays: product.expiryLeadDays,
      note: product.note,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
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
      })),
    })),
    devices: source.devices.map(({ id, ...device }) => ({
      category: device.category,
      name: device.name,
      model: device.model,
      serialNo: device.serialNo,
      quantity: device.quantity,
      note: device.note,
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
  };
}

export function summarizeBackup(data: BackupData): BackupSummary {
  return {
    exportedAt: data.exportedAt,
    food: data.products.filter((product) => product.kind === 'food').length,
    daily: data.products.filter((product) => product.kind === 'daily').length,
    devices: data.devices.length,
    batches: data.products.reduce((sum, product) => sum + product.batches.length, 0),
    movements: data.products.reduce((sum, product) => sum + product.movements.length, 0),
    assignments: data.devices.reduce((sum, device) => sum + device.assignments.length, 0),
  };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function backupFileName(now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `item-keeper-backup-${stamp}.json`;
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

function parseProduct(raw: unknown, index: number, exportedAt: string): BackupProduct {
  let where = `第 ${index + 1} 个物品`;
  if (!isObj(raw)) fail(where, '格式不对');
  const name = reqText(raw.name, where, '名称');
  where = `${where}「${name}」`;
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
    };
  });

  return {
    kind: raw.kind,
    barcode: optText(raw.barcode, where, '条码'),
    name,
    brand: optText(raw.brand, where, '品牌'),
    spec: optText(raw.spec, where, '规格'),
    unit: optText(raw.unit, where, '单位') ?? '件',
    location: optText(raw.location, where, '存放位置'),
    lowStockThreshold: optNumber(raw.lowStockThreshold, where, '库存下限', 0, 1e9),
    expiryLeadDays: optNumber(raw.expiryLeadDays, where, '到期提前天数', 0, 365, true),
    note: optText(raw.note, where, '备注'),
    createdAt: timestamp(raw.createdAt, exportedAt),
    updatedAt: timestamp(raw.updatedAt, exportedAt),
    batches,
    movements,
  };
}

function parseDevice(raw: unknown, index: number, exportedAt: string): BackupDevice {
  let where = `第 ${index + 1} 台设备`;
  if (!isObj(raw)) fail(where, '格式不对');
  const name = reqText(raw.name, where, '名称');
  where = `${where}「${name}」`;
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

  return {
    category: optText(raw.category, where, '类别') ?? '其他',
    name,
    model: optText(raw.model, where, '型号'),
    serialNo: optText(raw.serialNo, where, '序列号'),
    quantity,
    note: optText(raw.note, where, '备注'),
    createdAt: timestamp(raw.createdAt, exportedAt),
    updatedAt: timestamp(raw.updatedAt, exportedAt),
    assignments,
  };
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
    const exportedAt = timestamp(root.exportedAt, `${todayStr()}T00:00:00.000Z`);

    const products = list(root.products, '', '物品').map((raw, index) => parseProduct(raw, index, exportedAt));
    const devices = list(root.devices, '', '设备').map((raw, index) => parseDevice(raw, index, exportedAt));

    const barcodeOwner = new Map<string, string>();
    for (const product of products) {
      if (!product.barcode) continue;
      const owner = barcodeOwner.get(product.barcode);
      if (owner) fail('', `条码 ${product.barcode} 同时出现在「${owner}」和「${product.name}」`);
      barcodeOwner.set(product.barcode, product.name);
    }

    const data: BackupData = {
      app: BACKUP_APP,
      format,
      exportedAt,
      settings: parseSettings(root.settings),
      products,
      devices,
    };
    return { ok: true, data, summary: summarizeBackup(data) };
  } catch (error) {
    if (error instanceof BackupError) return { ok: false, error: error.message };
    return { ok: false, error: '读备份文件时出错了，文件可能已损坏' };
  }
}
