import type { SQLiteDatabase } from 'expo-sqlite';

import type {
  PricedStockIn,
  ReportAssignment,
  ReportBatch,
  ReportDevice,
  ReportMovement,
  ReportProduct,
} from '../lib/report';
import type { Accessory } from '../lib/warranty';
import { listActiveAssignments, listAllAccessories, listDevices } from './devices';
import { listOffices } from './offices';
import { DEFAULT_SETTINGS, getSettings, type AppSettings } from './settings';
import { listProducts } from './stock';

export type ReportSource = {
  settings: AppSettings;
  officeNames: Map<number, string>;
  products: ReportProduct[];
  /** 有库存的批次（导出当前库存用） */
  batches: ReportBatch[];
  /** 时间段内的出入库流水，按时间先后 */
  movements: ReportMovement[];
  /** 时间段结束前所有填了价格的入库（估算损失时找出库前最近一次的进价） */
  priceHistory: PricedStockIn[];
  devices: ReportDevice[];
  accessoriesByDevice: Map<number, Accessory[]>;
  /** 还没退还的领用 */
  assignments: ReportAssignment[];
};

export const EMPTY_REPORT_SOURCE: ReportSource = {
  settings: DEFAULT_SETTINGS,
  officeNames: new Map(),
  products: [],
  batches: [],
  movements: [],
  priceHistory: [],
  devices: [],
  accessoriesByDevice: new Map(),
  assignments: [],
};

/**
 * 报表要的数据一次取回：几条整表查询，汇总在 src/lib/report.ts 里做。
 * officeId 为 null 时是所有办公点；startIso / endIso 是时间段的起点（含）和终点（不含）。
 */
export async function loadReportSource(
  db: SQLiteDatabase,
  officeId: number | null,
  period: { startIso: string; endIso: string },
): Promise<ReportSource> {
  const [settings, offices, products, batches, movements, priceHistory, devices, accessories, assignments] =
    await Promise.all([
      getSettings(db),
      listOffices(db),
      listProducts(db, undefined, officeId),
      db.getAllAsync<ReportBatch>(
        `SELECT b.product_id AS productId, b.quantity, b.expiry_date AS expiryDate, b.added_on AS addedOn
           FROM stock_batch b JOIN stock_product p ON p.id = b.product_id
          WHERE b.quantity > 0 AND (? IS NULL OR p.office_id = ?)
          ORDER BY b.product_id, b.expiry_date IS NULL, b.expiry_date, b.id`,
        [officeId, officeId],
      ),
      db.getAllAsync<ReportMovement>(
        `SELECT m.id, m.product_id AS productId, p.office_id AS officeId, p.kind, p.category, p.name AS productName, p.unit,
                m.type, m.delta, m.happened_at AS happenedAt, m.note, m.input_qty AS inputQty,
                m.input_unit AS inputUnit, m.unit_price AS unitPrice, m.total_price AS totalPrice
           FROM stock_movement m JOIN stock_product p ON p.id = m.product_id
          WHERE (? IS NULL OR p.office_id = ?) AND m.happened_at >= ? AND m.happened_at < ?
          ORDER BY m.happened_at, m.id`,
        [officeId, officeId, period.startIso, period.endIso],
      ),
      db.getAllAsync<PricedStockIn>(
        `SELECT m.product_id AS productId, m.delta, m.input_qty AS inputQty, m.unit_price AS unitPrice,
                m.total_price AS totalPrice, m.happened_at AS happenedAt
           FROM stock_movement m JOIN stock_product p ON p.id = m.product_id
          WHERE m.type = 'in' AND m.delta > 0 AND (m.unit_price IS NOT NULL OR m.total_price IS NOT NULL)
            AND (? IS NULL OR p.office_id = ?) AND m.happened_at < ?
          ORDER BY m.happened_at, m.id`,
        [officeId, officeId, period.endIso],
      ),
      listDevices(db, officeId),
      listAllAccessories(db),
      listActiveAssignments(db, officeId),
    ]);

  const accessoriesByDevice = new Map<number, Accessory[]>();
  for (const accessory of accessories) {
    const list = accessoriesByDevice.get(accessory.deviceId) ?? [];
    list.push({ name: accessory.name, quantity: accessory.quantity });
    accessoriesByDevice.set(accessory.deviceId, list);
  }

  return {
    settings,
    officeNames: new Map(offices.map((office) => [office.id, office.name])),
    products: products.map((product) => ({
      id: product.id,
      officeId: product.officeId,
      kind: product.kind,
      category: product.category,
      name: product.name,
      barcode: product.barcode,
      unit: product.unit,
      location: product.location,
      lowStockThreshold: product.lowStockThreshold,
      expiryLeadDays: product.expiryLeadDays,
      totalQty: product.totalQty,
      nearestExpiry: product.nearestExpiry,
    })),
    batches,
    movements,
    priceHistory,
    devices: devices.map((device) => ({
      id: device.id,
      officeId: device.officeId,
      category: device.category,
      name: device.name,
      model: device.model,
      serialNo: device.serialNo,
      invoiceNo: device.invoiceNo,
      chip: device.chip,
      memory: device.memory,
      storage: device.storage,
      quantity: device.quantity,
      outQty: device.outQty,
      holders: device.holders,
      purchaseDate: device.purchaseDate,
      warrantyUntil: device.warrantyUntil,
    })),
    accessoriesByDevice,
    assignments: assignments.map((assignment) => ({ person: assignment.person, quantity: assignment.quantity })),
  };
}
