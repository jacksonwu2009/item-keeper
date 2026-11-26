import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect, usePreventRemove } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Text } from './Text';

import { isLabelOcrAvailable } from '../../modules/label-ocr';
import type { AppSettings } from '../db/settings';
import { findByBarcode, listLocations, validShelfLife, type BarcodeMatch, type BatchInput, type StockProductInput } from '../db/stock';
import { barcodeFieldError, isProductBarcode, normalizeBarcodeInput, PRODUCT_BARCODE_ERROR, productBarcodeError } from '../lib/barcode';
import { EMPTY_LOOKUP_FIELDS, lookupBarcode, lookupFieldsOf, mergeLookupFields, type LookupFields } from '../lib/barcodeLookup';
import { CATEGORIES, categoryForKind } from '../lib/categories';
import type { ShelfLife, ShelfLifeUnit } from '../lib/dates';
import { leaveEditPage } from '../lib/discardEdit';
import { planExpiryFill, type ExpiryFill, type ScanTag } from '../lib/labelScan';
import { toBaseQty, validatePacks, type PackUnit } from '../lib/packs';
import { convertPriceUnit, derivePrice, EMPTY_PRICE, storedPriceDraft, type EntryPrice, type PriceDraft } from '../lib/price';
import {
  draftShelfLife,
  firstBatchExpiryFill,
  newProductShelfLife,
  productFormChanged,
  scannedShelfDraft,
  shelfDraftOf,
  shelfLifeError,
  shelfScanTag,
  type ProductFormValues,
} from '../lib/productForm';
import { takeScanResult, takeScanResultWithPrefix } from '../lib/scanHandoff';
import { DEFAULT_UNITS, formatQty, KIND_LABEL, parseQty, type StockKind } from '../lib/stock';
import { makeStyles, useColors } from '../hooks/useTheme';
import { CONTENT_MAX_WIDTH, font, radius } from '../theme';
import { useOffice } from '../hooks/useOffice';
import { CircleIconButton } from './CircleIconButton';
import { ExpiryInput, type ExpiryValue } from './ExpiryInput';
import { LabelCamera, type LabelScanResult } from './LabelCamera';
import { draftPrice, StockInPriceFields, type StockInPriceRecord } from './MovementPriceEditor';
import { NumberField } from './NumberField';
import { OfficeChooser } from './OfficeSwitcher';
import { PriceFields } from './PriceFields';
import { Button, Card, ChoiceChips, Field, Label, Screen, SectionTitle, Segmented } from './ui';
import { UnitQtyField } from './UnitQtyField';

const SCAN_TARGET = 'stock-form-barcode';
const PACK_SCAN_PREFIX = 'stock-form-pack-';
const PACK_SUGGESTIONS = ['箱', '提', '包', '盒', '袋', '件'];

/** openedBarcode：打开表单时这个包装的条码（老数据不合规时提示要改）；barcodeTouched：离开过条码框 */
type PackRow = { key: number; unit: string; sizeText: string; barcode: string; openedBarcode?: string; barcodeTouched?: boolean };

let packRowKey = 0;
function toPackRow(pack: PackUnit): PackRow {
  const barcode = pack.barcode ?? '';
  return { key: ++packRowKey, unit: pack.unit, sizeText: formatQty(pack.size), barcode, openedBarcode: barcode };
}

type LookupState = 'idle' | 'loading' | 'found' | 'notfound';

/** 拍包装识别出来、填进表单的东西（用来标「识别」：值没被改过才标） */
type LabelScanFill = { count: number; name: string | null; spec: string | null; shelfLife: ShelfLife | null };

/** 拍照识别填的格子：值还是认出来的那个就标「识别」；没认出来、还空着就标「没认出来」 */
function scanTagFor(scan: LabelScanFill | null, recognized: string | null, current: string): ScanTag | null {
  if (!scan) return null;
  if (recognized) return current === recognized ? 'recognized' : null;
  return current.trim() ? null : 'missing';
}

export function StockProductForm({
  initial,
  settings,
  withFirstBatch,
  submitLabel,
  onSubmit,
  scanLabelOnOpen = false,
  onUseExisting,
  lastStockIn = null,
  confirmDiscard = false,
}: {
  initial: Partial<StockProductInput> & { kind: StockKind };
  settings: AppSettings;
  withFirstBatch: boolean;
  submitLabel: string;
  /** lastStockInPrice：改了「最近一次入库的价格」才有（null 是清掉价格），没改是 undefined */
  onSubmit: (input: StockProductInput, firstBatch: BatchInput | null, lastStockInPrice?: EntryPrice | null) => Promise<void>;
  /** 一打开就进拍包装识别的相机（扫码页点「没有条码？拍包装识别」进来的） */
  scanLabelOnOpen?: boolean;
  /**
   * 新建时：扫到、输完条码先在本机（这个办公点的物品条码、包装条码）里找，找到了就调这个
   * （新增页直接打开它去入库，不建重复的物品）；本机没有才查网上的商品库。不传就不先查本机（改资料时）
   */
  onUseExisting?: (match: BarcodeMatch) => void;
  /** 改资料时：最近一次入库，在「最近一次入库的价格」里改它的单价、总价，保存时改那条记录 */
  lastStockIn?: StockInPriceRecord | null;
  /** 改资料页：改过任何一格再返回（返回键、左上角返回、手势返回）先问「放弃修改？」；没改过、点「保存」成功后直接离开 */
  confirmDiscard?: boolean;
}) {
  const colors = useColors();
  const formStyles = useFormStyles();
  const db = useSQLiteContext();
  const office = useOffice();
  const [officeId, setOfficeId] = useState(initial.officeId ?? office.defaultId);
  const [kind, setKind] = useState<StockKind>(initial.kind);
  const [barcode, setBarcode] = useState(initial.barcode ?? '');
  const [name, setName] = useState(initial.name ?? '');
  const [category, setCategory] = useState<string | null>(initial.category ?? null);
  const [spec, setSpec] = useState(initial.spec ?? '');
  const [unit, setUnit] = useState(initial.unit ?? '件');
  const [location, setLocation] = useState(initial.location ?? '');
  const [lowStockText, setLowStockText] = useState(
    initial.lowStockThreshold === undefined
      ? String(settings.defaultLowStockThreshold)
      : initial.lowStockThreshold === null
        ? ''
        : String(initial.lowStockThreshold),
  );
  const [leadText, setLeadText] = useState(
    initial.expiryLeadDays === undefined || initial.expiryLeadDays === null ? '' : String(initial.expiryLeadDays),
  );
  const [note, setNote] = useState(initial.note ?? '');
  const [packRows, setPackRows] = useState<PackRow[]>(() => (initial.packs ?? []).map(toPackRow));
  const [qtyText, setQtyText] = useState('1');
  const [entryUnit, setEntryUnit] = useState(initial.unit ?? '件');
  const [priceDraft, setPriceDraft] = useState<PriceDraft>(EMPTY_PRICE);
  const [expiry, setExpiry] = useState<ExpiryValue>({ expiry: null, error: null, shelfLife: null, productionDate: null });
  const [locations, setLocations] = useState<string[]>([]);
  // 保质期：新增、改资料都是单独一格（规格下面），没填时空着、单位默认「个月」；拍包装认出的也填在这一格
  const [shelfText, setShelfText] = useState(() => shelfDraftOf(initial.shelfLife).shelfText);
  const [shelfUnit, setShelfUnit] = useState<ShelfLifeUnit>(() => shelfDraftOf(initial.shelfLife).shelfUnit);
  // 新建时「这次入库」的过期日期人动过没有：没动过时改了保质期那一格，就按新的保质期重新带出来（shelfKey 加 1 换 key）
  const [expiryTouched, setExpiryTouched] = useState(false);
  const [shelfKey, setShelfKey] = useState(0);
  // 拍包装识别（新建、手机上能用时）
  const canScanLabel = withFirstBatch && isLabelOcrAvailable();
  const [labelCameraOpen, setLabelCameraOpen] = useState(scanLabelOnOpen && canScanLabel);
  const [labelScan, setLabelScan] = useState<LabelScanFill | null>(null);
  const [nameCandidates, setNameCandidates] = useState<string[]>([]);
  const [expiryFill, setExpiryFill] = useState<{ key: number; fill: ExpiryFill } | null>(null);
  // 新建时带着扫到的条码进来，并且还没有名称：自动查一次商品名
  const autoLookupCode =
    withFirstBatch &&
    initial.barcode &&
    !initial.name &&
    settings.onlineLookup &&
    isProductBarcode(initial.barcode)
      ? initial.barcode
      : null;
  const [lookup, setLookup] = useState<LookupState>(autoLookupCode ? 'loading' : 'idle');
  const checkLocal = !!onUseExisting;
  // 先查本机：确认过的条码（扫到、输完离开输入框、带进来的）；换了办公点会重查
  const [confirmedCode, setConfirmedCode] = useState(checkLocal ? (initial.barcode ?? '').trim() : '');
  const barcodeRef = useRef(barcode);
  const onUseExistingRef = useRef(onUseExisting);
  // 已经跳去本机那个物品了：不再跳第二次
  const usedExisting = useRef(false);
  // 最近一次入库的价格（改资料时）：改过才保存
  const [lastInDraft, setLastInDraft] = useState<PriceDraft>(() => (lastStockIn ? storedPriceDraft(lastStockIn) : EMPTY_PRICE));
  const [lastInEdited, setLastInEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  // 离开过条码框：之后位数不对也提示（还在输的时候不提示）
  const [barcodeTouched, setBarcodeTouched] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const lookedUp = useRef<string | null>(null);
  // 上一次扫码从商品库带出来的名称、规格：再扫别的条码时，没手动改过的这两项换成新查到的
  const autoFilled = useRef<LookupFields>(EMPTY_LOOKUP_FIELDS);
  const fieldsRef = useRef<LookupFields>({ name, spec });
  useEffect(() => {
    fieldsRef.current = { name, spec };
    barcodeRef.current = barcode;
    onUseExistingRef.current = onUseExisting;
  });

  useEffect(() => {
    listLocations(db).then(setLocations).catch(() => undefined);
  }, [db]);

  /**
   * 查商品库，把结果填进名称、规格（品牌拼进名称）：空着的、还是上一次扫码带出来的换成这次的（这次没查到就清空），
   * 手动填过的不动。只在 await 之后改状态。
   */
  const applyLookup = useCallback(async (code: string) => {
    const info = await lookupBarcode(code);
    if (lookedUp.current !== code) return;
    setLookup(info ? 'found' : 'notfound');
    const next = lookupFieldsOf(info);
    const merged = mergeLookupFields(fieldsRef.current, autoFilled.current, next);
    autoFilled.current = next;
    setName(merged.name);
    setSpec(merged.spec);
  }, []);

  const runLookup = useCallback(
    (code: string) => {
      if (!settings.onlineLookup || !isProductBarcode(code) || lookedUp.current === code) return;
      lookedUp.current = code;
      setLookup('loading');
      applyLookup(code).catch(() => setLookup('notfound'));
    },
    [settings.onlineLookup, applyLookup],
  );

  useEffect(() => {
    // 要先查本机的，查完本机没有再查商品库（见下面）
    if (!autoLookupCode || checkLocal || lookedUp.current === autoLookupCode) return;
    lookedUp.current = autoLookupCode;
    applyLookup(autoLookupCode).catch(() => setLookup('notfound'));
  }, [autoLookupCode, checkLocal, applyLookup]);

  // 先查本机：物品条码、包装条码，只在选的办公点里找；本机有就直接去那个物品（不查商品库）；没有再查商品库
  useEffect(() => {
    if (!checkLocal || !confirmedCode) return;
    let cancelled = false;
    const code = confirmedCode;
    findByBarcode(db, code, officeId)
      .catch(() => null)
      .then((match) => {
        // 查的时候条码框又改了：等改完确认了再查
        if (cancelled || barcodeRef.current.trim() !== code) return;
        if (!match) {
          runLookup(code);
          return;
        }
        if (usedExisting.current) return;
        usedExisting.current = true;
        setLookup('idle');
        onUseExistingRef.current?.(match);
      });
    return () => {
      cancelled = true;
    };
  }, [checkLocal, confirmedCode, officeId, db, runLookup]);

  /** 条码定下来了（扫到、输完）：要先查本机的去查本机，否则直接查商品库；不是商品条码（8–14 位数字）的不查 */
  const confirmBarcode = useCallback(
    (raw: string) => {
      const code = normalizeBarcodeInput(raw);
      if (!isProductBarcode(code)) return;
      if (checkLocal) setConfirmedCode(code);
      else runLookup(code);
    },
    [checkLocal, runLookup],
  );

  // 从扫码页回来时取走扫到的条码
  useFocusEffect(
    useCallback(() => {
      const code = takeScanResult(SCAN_TARGET);
      if (code) {
        setBarcode(code);
        confirmBarcode(code);
      }
      const packScan = takeScanResultWithPrefix(PACK_SCAN_PREFIX);
      if (packScan) {
        const key = Number(packScan.target.slice(PACK_SCAN_PREFIX.length));
        setPackRows((rows) => rows.map((row) => (row.key === key ? { ...row, barcode: packScan.code } : row)));
      }
    }, [confirmBarcode]),
  );

  /** 拍包装识别回来：认出来的填上（名称、规格、保质期直接填，日期、保质期也填进「这次入库」），不保存，等人核对 */
  function applyLabelScan({ label, dates }: LabelScanResult) {
    setLabelCameraOpen(false);
    // 重拍时：上一次照片填的、没改过的换成这一次的（这次没认出就清空）；手动填的不动
    const replace = (current: string, previous: string | null | undefined, next: string | null) =>
      next ?? (previous && current === previous ? '' : current);
    setName((current) => replace(current, labelScan?.name, label.name));
    setSpec((current) => replace(current, labelScan?.spec, label.spec));
    setNameCandidates(label.nameCandidates);
    // 保质期那一格：认出了就填（规则同名称、规格），保存时记进物品资料
    const recognizedShelfLife = validShelfLife(label.shelfLife);
    const shelf = scannedShelfDraft({ shelfText, shelfUnit }, labelScan?.shelfLife ?? null, recognizedShelfLife);
    setShelfText(shelf.shelfText);
    setShelfUnit(shelf.shelfUnit);
    const fill = planExpiryFill({
      dates: dates ?? { production: null, expiry: null, confirmed: false },
      shelfLife: label.shelfLife,
      shelfLifeRecognized: !!label.shelfLife,
      dateElsewhere: label.dateElsewhere,
    });
    if (fill) {
      setExpiryFill((current) => ({ key: (current?.key ?? 0) + 1, fill }));
      // 照片认出的日期填进了过期日期：之后改保质期那一格不再重新带出
      setExpiryTouched(true);
    }
    setLabelScan({
      count: (label.name ? 1 : 0) + (label.spec ? 1 : 0) + (label.shelfLife ? 1 : 0) + (dates?.production || dates?.expiry ? 1 : 0),
      name: label.name,
      spec: label.spec,
      shelfLife: recognizedShelfLife,
    });
  }

  /** 人改保质期那一格（拍包装填的不算）：新建时这一批的过期日期还没动过，就按新的保质期重新带出 */
  function editShelfText(value: string) {
    setShelfText(value);
    if (!expiryTouched) setShelfKey((key) => key + 1);
  }

  function editShelfUnit(value: ShelfLifeUnit) {
    setShelfUnit(value);
    if (!expiryTouched) setShelfKey((key) => key + 1);
  }

  function updatePackRow(key: number, patch: Partial<PackRow>) {
    setPackRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  const lowStockThreshold = lowStockText.trim() === '' ? null : parseQty(lowStockText);
  const leadDays = leadText.trim() === '' ? null : Number(leadText);
  const qty = parseQty(qtyText);
  const baseUnit = unit.trim() || '件';
  const packs: PackUnit[] = packRows.map((row) => ({
    unit: row.unit.trim(),
    size: parseQty(row.sizeText) ?? Number.NaN,
    barcode: normalizeBarcodeInput(row.barcode) || null,
  }));
  const packError = validatePacks(baseUnit, packs);
  // 各个包装的条码框下面显示的提示（规则同物品条码）
  const packBarcodeErrors = new Map(
    packRows.map((row) => [row.key, barcodeFieldError(row.barcode, row.openedBarcode, showErrors || !!row.barcodeTouched)]),
  );
  const usablePacks = packError ? [] : packs;
  const baseQty = qty === null ? null : toBaseQty(qty, entryUnit, baseUnit, usablePacks) ?? qty;
  // 包装规格还在改、选的单位暂时无效时，按最小单位算（和保存时一致）
  const effectiveEntryUnit = usablePacks.some((pack) => pack.unit === entryUnit) ? entryUnit : baseUnit;
  const { price } = derivePrice(priceDraft, qty);

  /** 1 个这种单位等于多少最小单位 */
  function unitSize(entry: string): number {
    return toBaseQty(1, entry, baseUnit, usablePacks) ?? 1;
  }

  function changeEntryUnit(next: string) {
    setPriceDraft((draft) => convertPriceUnit(draft, unitSize(effectiveEntryUnit), unitSize(next)));
    setEntryUnit(next);
  }

  const shelfDraft = { shelfText, shelfUnit };
  const fieldShelfLife: ShelfLife | null = draftShelfLife(shelfDraft);

  const errors = {
    barcode: productBarcodeError(barcode),
    packBarcodes: packRows.some((row) => productBarcodeError(row.barcode)) ? PRODUCT_BARCODE_ERROR : null,
    name: name.trim() ? null : '请填写名称',
    shelfLife: shelfLifeError(shelfDraft),
    lowStock: lowStockText.trim() !== '' && lowStockThreshold === null ? '请填数字，留空表示不提醒' : null,
    lead:
      leadText.trim() !== '' && (!Number.isInteger(leadDays) || (leadDays ?? 0) < 0 || (leadDays ?? 0) > 365)
        ? '请填 0–365 的整数，留空表示用默认设置'
        : null,
    qty: withFirstBatch && qty === null ? '请填数量（可以是 0）' : null,
    expiry: withFirstBatch && (qty ?? 0) > 0 ? expiry.error : null,
    packs: packError,
  };
  const hasErrors = Object.values(errors).some(Boolean);

  // 改资料页：打开时各格的值记一份，返回前和现在的比，改过才问「放弃修改？」（改回原样不算）
  const formValues: ProductFormValues = {
    officeId,
    kind,
    barcode,
    name,
    category,
    spec,
    unit,
    location,
    lowStockText,
    leadText,
    note,
    packs: packRows.map((row) => ({ unit: row.unit, sizeText: row.sizeText, barcode: row.barcode })),
    shelfText,
    shelfUnit,
    lastInPrice: lastInDraft,
  };
  const [openedValues] = useState(formValues);
  // 已经决定离开（点了「放弃」、保存成功）：不再拦
  const [left, setLeft] = useState(false);
  // 点了「保存」、正在保存或已保存：这时离开（保存成功后页面自己返回）不问；保存出错时改回 false
  const savingRef = useRef(false);
  const changed = confirmDiscard && !left && productFormChanged(openedValues, formValues);
  usePreventRemove(changed, ({ repeat }) => {
    leaveEditPage(
      savingRef.current,
      () => {
        setLeft(true);
        repeat();
      },
      (title, message, buttons) => Alert.alert(title, message, buttons),
    );
  });

  async function submit() {
    setShowErrors(true);
    setSubmitError(null);
    if (hasErrors) return;
    setSubmitting(true);
    savingRef.current = true;
    try {
      const lastStockInPrice = lastStockIn && lastInEdited ? draftPrice(lastStockIn, recordUnit, lastInDraft) : undefined;
      await onSubmit(
        {
          officeId,
          kind,
          barcode: normalizeBarcodeInput(barcode) || null,
          name,
          category: categoryForKind(kind, category),
          spec,
          unit,
          location,
          lowStockThreshold,
          expiryLeadDays: leadDays,
          note,
          packs,
          // 「保质期」那一格填的（拍包装认出的也填在那一格）；新建时那一格没填、这一批按「生产日期+保质期」填了，用这一批的
          shelfLife: withFirstBatch ? newProductShelfLife(fieldShelfLife, expiry.shelfLife) : fieldShelfLife,
        },
        withFirstBatch && qty && qty > 0 && baseQty
          ? {
              quantity: baseQty,
              expiryDate: expiry.expiry,
              entry: { qty, unit: effectiveEntryUnit },
              price,
              productionDate: expiry.productionDate,
            }
          : null,
        lastStockInPrice,
      );
    } catch (error) {
      savingRef.current = false;
      setSubmitError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const shown = (message: string | null) => (showErrors ? message : null);
  const unitOptions = Array.from(new Set([...DEFAULT_UNITS[kind], unit].filter(Boolean))).map((value) => ({
    value,
    label: value,
  }));

  // 照鸿蒙版 ProductFormPage.ets：最宽 720 居中；分类、办公点在卡片外面，基本信息、包装规格、这次入库、提醒、备注各一张卡片，
  // 卡片里各项之间 16；输入框右边的扫码是浅主色底的圆按钮
  const nameTag = scanTagFor(labelScan, labelScan?.name ?? null, name);
  const specTag = scanTagFor(labelScan, labelScan?.spec ?? null, spec);
  const otherNames = nameCandidates.filter((candidate) => candidate !== name);
  // 入库记录是按当时的最小单位记的：显示用打开表单时的单位
  const recordUnit = initial.unit ?? '件';

  return (
    <Screen contentStyle={formStyles.page}>
      {labelScan ? (
        // 拍包装识别填过了：照效果图，浅蓝一条，说明标了「识别」的是认出来的，可以重拍
        <View style={formStyles.scanBanner}>
          <Ionicons name="document-text-outline" size={28} color={colors.info} />
          <View style={formStyles.scanBannerText}>
            <Text style={formStyles.scanBannerTitle}>
              {labelScan.count ? `已从照片填入 ${labelScan.count} 项，请核对` : '照片里没认出能填的，请手动填'}
            </Text>
            <Text style={formStyles.scanBannerSub}>标了「识别」的格子是照片里认出来的，点开能改</Text>
          </View>
          <Button title="重拍" icon="camera-outline" variant="secondary" compact onPress={() => setLabelCameraOpen(true)} />
        </View>
      ) : canScanLabel ? (
        // 新增物品时常驻的入口：扫码进来、手动添加、有没有条码都能拍
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="拍包装识别"
          onPress={() => setLabelCameraOpen(true)}
          style={({ pressed }) => [formStyles.scanBanner, formStyles.scanEntryBanner, pressed && formStyles.pressed]}
        >
          <Ionicons name="camera-outline" size={28} color={colors.accent} />
          <View style={formStyles.scanBannerText}>
            <Text style={[formStyles.scanBannerTitle, formStyles.scanEntryTitle]}>拍包装识别</Text>
            <Text style={formStyles.scanBannerSub}>拍包装背面的标签，自动填名称、规格、保质期和生产日期；没有条码也能用</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.accent} />
        </Pressable>
      ) : null}
      <Segmented
        options={[
          { value: 'food', label: KIND_LABEL.food },
          { value: 'daily', label: KIND_LABEL.daily },
        ]}
        value={kind}
        onChange={(next) => {
          setKind(next);
          // 分类食品、日用品各一套：选过的不属于新的那类就清空（「其他」两边都有，留着）
          setCategory((current) => categoryForKind(next, current));
        }}
      />
      <OfficeChooser value={officeId} onChange={setOfficeId} />

      <Card style={formStyles.card}>
        <Field
          label="条码"
          value={barcode}
          onChangeText={(value) => {
            // 只能是数字：空格（印刷时隔开写的）输入时就去掉
            setBarcode(normalizeBarcodeInput(value));
            setLookup('idle');
          }}
          // 离开输入框、按回车（扫码枪扫完会带回车）时查本机、商品库。网页版不支持 onEndEditing，所以用这两个
          onBlur={() => {
            setBarcodeTouched(true);
            confirmBarcode(barcode);
          }}
          onSubmitEditing={() => {
            setBarcodeTouched(true);
            confirmBarcode(barcode);
          }}
          placeholder="扫码或手动输入，可不填"
          keyboardType="number-pad"
          error={barcodeFieldError(barcode, initial.barcode, showErrors || barcodeTouched)}
          right={
            <CircleIconButton
              icon="barcode-outline"
              label="扫描条码"
              tone="accent"
              size={44}
              // mode=product：扫到的不是商品条码（二维码、带字母的码）不填进来
              onPress={() => router.push({ pathname: '/scan', params: { target: SCAN_TARGET, mode: 'product' } })}
            />
          }
        />
        {/* 拍包装识别填过以后，商品库没查到的那句不再显示（上面横幅已经说了从照片填了什么） */}
        {lookup !== 'idle' && !(labelScan && lookup === 'notfound') ? (
          <Text style={[formStyles.lookup, lookup === 'found' && { color: colors.ok }]}>
            {lookup === 'loading'
              ? '正在查商品库…'
              : lookup === 'found'
                ? '已从商品库带出名称，请核对。'
                : canScanLabel
                  ? '商品库里没查到这个条码，可以用上面的「拍包装识别」，或手动填。'
                  : '商品库里没查到这个条码，请手动填名称。'}
          </Text>
        ) : null}
        <Field
          label="名称"
          required
          value={name}
          onChangeText={setName}
          placeholder="例如 纯牛奶"
          error={shown(errors.name)}
          tag={nameTag}
        />
        {otherNames.length ? (
          <View style={formStyles.candidates}>
            <Text style={formStyles.candidatesLabel}>也可能是：</Text>
            {otherNames.map((candidate) => (
              <Pressable
                key={candidate}
                accessibilityRole="button"
                accessibilityLabel={`名称填成${candidate}`}
                onPress={() => setName(candidate)}
                style={({ pressed }) => [formStyles.candidate, pressed && formStyles.pressed]}
              >
                <Text style={formStyles.candidateText}>{candidate}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={formStyles.group}>
          <Label>分类（可不选，再点一下取消）</Label>
          <ChoiceChips
            options={CATEGORIES[kind].map((value) => ({ value, label: value }))}
            value={category}
            onChange={(value) => setCategory((current) => (current === value ? null : value))}
          />
        </View>
        {/* 一件东西本身的规格；整箱几瓶在下面「包装规格」里设 */}
        <Field label="规格" value={spec} onChangeText={setSpec} placeholder="如 550ml" tag={specTag} />
        {/* 填了以后入库默认按「生产日期+保质期」算到期日（标「按资料」）；拍包装认出的也填在这里，保存时记进物品资料 */}
        <View style={formStyles.group}>
          <NumberField
            label="保质期"
            value={shelfText}
            onChangeText={editShelfText}
            placeholder="可不填"
            min={1}
            max={9999}
            buttons={false}
            hint="填了以后，入库时默认按「生产日期+保质期」算到期日，也能拍喷码上的生产日期"
            error={shown(errors.shelfLife)}
            tag={shelfScanTag(!!labelScan, labelScan?.shelfLife ?? null, shelfDraft)}
          />
          <ChoiceChips
            options={[
              { value: 'day' as ShelfLifeUnit, label: '天' },
              { value: 'month' as ShelfLifeUnit, label: '个月' },
              { value: 'year' as ShelfLifeUnit, label: '年' },
            ]}
            value={shelfUnit}
            onChange={editShelfUnit}
          />
        </View>
        <View style={formStyles.group}>
          <Label>最小单位（库存按它算）</Label>
          <ChoiceChips options={unitOptions} value={unit} onChange={setUnit} />
          <Field value={unit} onChangeText={setUnit} placeholder="其他单位" maxLength={6} />
        </View>
        <View style={formStyles.group}>
          <Field label="存放位置" value={location} onChangeText={setLocation} placeholder="如 冰箱冷藏、储物柜" />
          {locations.length ? (
            <ChoiceChips
              options={locations.map((value) => ({ value, label: value }))}
              value={location}
              onChange={setLocation}
            />
          ) : null}
        </View>
      </Card>

      <SectionTitle title="包装规格（可选）" />
      <Card style={formStyles.card}>
        <Text style={formStyles.hint}>
          整箱进、按{baseUnit}出的东西在这里设，如「1 箱 = 24 {baseUnit}」。入库出库时可以按箱或按{baseUnit}填，库存自动换算。
          整箱外包装上的条码也可以录进来，扫箱子就能认出。
        </Text>
        {packRows.map((row) => (
          <View key={row.key} style={formStyles.packRow}>
            <View style={formStyles.packLine}>
              <Text style={formStyles.packText}>1</Text>
              <View style={formStyles.packUnit}>
                <Field
                  value={row.unit}
                  onChangeText={(value) => updatePackRow(row.key, { unit: value })}
                  placeholder="箱"
                  maxLength={6}
                  style={formStyles.packInput}
                />
              </View>
              <Text style={formStyles.packText}>=</Text>
              <View style={formStyles.packSize}>
                <NumberField
                  value={row.sizeText}
                  onChangeText={(value) => updatePackRow(row.key, { sizeText: value })}
                  placeholder="24"
                  decimals={2}
                  buttons={false}
                  accessibilityLabel={`1 ${row.unit || '包装'}等于多少${baseUnit}`}
                  inputStyle={formStyles.packInput}
                />
              </View>
              <Text style={formStyles.packText}>{baseUnit}</Text>
              <CircleIconButton
                icon="trash-outline"
                label="删除这个包装规格"
                tone="plain"
                color={colors.danger}
                onPress={() => setPackRows((rows) => rows.filter((candidate) => candidate.key !== row.key))}
              />
            </View>
            <Field
              value={row.barcode}
              onChangeText={(value) => updatePackRow(row.key, { barcode: normalizeBarcodeInput(value) })}
              onBlur={() => updatePackRow(row.key, { barcodeTouched: true })}
              placeholder={`${row.unit || '这个包装'}的条码，可不填`}
              keyboardType="number-pad"
              style={[formStyles.packInput, packBarcodeErrors.get(row.key) ? formStyles.packInputError : null]}
              error={packBarcodeErrors.get(row.key)}
              right={
                <CircleIconButton
                  icon="barcode-outline"
                  label="扫描包装条码"
                  tone="accent"
                  size={44}
                  onPress={() =>
                    router.push({ pathname: '/scan', params: { target: `${PACK_SCAN_PREFIX}${row.key}`, mode: 'product' } })
                  }
                />
              }
            />
          </View>
        ))}
        {packRows.length === 0 ? null : shown(errors.packs) ? <Text style={formStyles.error}>{errors.packs}</Text> : null}
        <View style={formStyles.packAdd}>
          {PACK_SUGGESTIONS.filter((value) => value !== baseUnit && !packRows.some((row) => row.unit === value))
            .slice(0, 3)
            .map((value) => (
              <Button
                key={value}
                title={`+ 按${value}`}
                compact
                variant="secondary"
                onPress={() => setPackRows((rows) => [...rows, { key: ++packRowKey, unit: value, sizeText: '', barcode: '' }])}
              />
            ))}
          <Button
            title="+ 其他"
            compact
            variant="ghost"
            onPress={() => setPackRows((rows) => [...rows, { key: ++packRowKey, unit: '', sizeText: '', barcode: '' }])}
          />
        </View>
      </Card>

      {!withFirstBatch && lastStockIn ? (
        <>
          <SectionTitle title="最近一次入库的价格" />
          <Card style={formStyles.card}>
            <StockInPriceFields
              record={lastStockIn}
              baseUnit={recordUnit}
              draft={lastInDraft}
              onChange={(draft) => {
                setLastInDraft(draft);
                setLastInEdited(true);
              }}
            />
          </Card>
        </>
      ) : null}

      {withFirstBatch ? (
        <>
          <SectionTitle title="这次入库" />
          <Card style={formStyles.card}>
            <UnitQtyField
              label="数量"
              baseUnit={baseUnit}
              packs={usablePacks}
              qtyText={qtyText}
              onQtyText={setQtyText}
              unit={entryUnit}
              onUnit={changeEntryUnit}
              error={shown(errors.qty)}
            />
            <PriceFields draft={priceDraft} onChange={setPriceDraft} qty={qty} unit={effectiveEntryUnit} />
            {/* 拍包装认出的日期按照片填；否则填了保质期就按「生产日期+保质期」带出（标「按资料」） */}
            <ExpiryInput
              key={`${kind}-${expiryFill?.key ?? 0}-${shelfKey}`}
              initialMode={kind === 'food' ? 'date' : 'none'}
              fill={firstBatchExpiryFill(expiryFill?.fill ?? null, { ...shelfDraft, kind }, isLabelOcrAvailable())}
              allowNone
              onChange={setExpiry}
              onEdit={() => setExpiryTouched(true)}
            />
            {shown(errors.expiry) ? <Text style={formStyles.error}>{errors.expiry}</Text> : null}
          </Card>
        </>
      ) : null}

      <SectionTitle title="提醒" />
      <Card style={formStyles.card}>
        <NumberField
          label={`库存下限（${baseUnit}）`}
          value={lowStockText}
          onChangeText={setLowStockText}
          decimals={2}
          suffix={baseUnit}
          placeholder="留空不提醒"
          hint={
            usablePacks.length
              ? `库存 ≤ 这个数时提醒补货。按${baseUnit}算，比如想剩 1 ${usablePacks[0].unit}时提醒就填 ${formatQty(usablePacks[0].size)}`
              : '库存 ≤ 这个数时提醒补货'
          }
          error={shown(errors.lowStock)}
        />
        <NumberField
          label="到期前几天提醒"
          value={leadText}
          onChangeText={setLeadText}
          max={365}
          suffix="天"
          placeholder={`默认 ${settings.expiryLeadDays}`}
          hint="留空就用设置里的默认天数"
          error={shown(errors.lead)}
        />
      </Card>

      <Card style={formStyles.card}>
        <Field label="备注" value={note} onChangeText={setNote} placeholder="可不填" multiline style={formStyles.noteInput} />
      </Card>

      {submitError ? <Text style={formStyles.error}>{submitError}</Text> : null}
      <Button title={submitLabel} onPress={submit} loading={submitting} />
      {labelCameraOpen ? (
        <LabelCamera mode="label" onDone={applyLabelScan} onClose={() => setLabelCameraOpen(false)} />
      ) : null}
    </Screen>
  );
}

const useFormStyles = makeStyles((colors) => ({
  page: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
  card: { gap: 16 },
  group: { gap: 8 },
  lookup: { fontSize: font.small, color: colors.muted },
  error: { fontSize: font.small, color: colors.danger },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  // 一个包装规格一块浅灰底，里面的输入框是白底（不然和底色分不出来）
  packRow: {
    gap: 8,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSunken,
  },
  packLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  packText: { fontSize: font.body, color: colors.ink, fontWeight: '500' },
  packUnit: { width: 72 },
  packSize: { flex: 1, minWidth: 0 },
  packInput: { backgroundColor: colors.surface, borderColor: colors.surface },
  // 包装条码不合规：白底输入框也要描红（上面那条把边框颜色盖成了白色）
  packInputError: { borderColor: colors.danger },
  packAdd: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  noteInput: { minHeight: 88, textAlignVertical: 'top' },
  // 拍包装识别：入口在页面最上面（浅主色），识别完换成浅蓝一条
  // 入口（操作）用 App 主色；识别后的横幅、「识别」标记用蓝色，专门表示「机器认出来的，请核对」
  scanEntryBanner: { backgroundColor: colors.accentSoft },
  scanEntryTitle: { color: colors.accent },
  scanBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.infoSoft,
  },
  scanBannerText: { flex: 1, gap: 2 },
  scanBannerTitle: { fontSize: font.body, fontWeight: '600', color: colors.info },
  scanBannerSub: { fontSize: font.small, color: colors.muted, lineHeight: 18 },
  candidates: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: -8 },
  candidatesLabel: { fontSize: font.small, color: colors.muted },
  candidate: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.surfaceSunken },
  candidateText: { fontSize: font.small, color: colors.ink },
  pressed: { opacity: 0.6 },
}));
