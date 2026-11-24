import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { isLabelOcrAvailable } from '../../modules/label-ocr';
import { expiryFromShelfLife, formatDate, todayStr, type ShelfLife, type ShelfLifeUnit } from '../lib/dates';
import type { DateRole } from '../lib/labelParse';
import { planExpiryFill, type ExpiryFill } from '../lib/labelScan';
import { sameAsLastLabel } from '../lib/stockInDefaults';
import { makeStyles } from '../hooks/useTheme';
import { font, radius } from '../theme';
import { DateField } from './DateField';
import { LabelCamera, type DateScanResult } from './LabelCamera';
import { NumberField } from './NumberField';
import { Button, ChoiceChips, Segmented } from './ui';

export type ExpiryMode = 'date' | 'shelf' | 'none';

/**
 * expiry 是算出来的到期日；shelfLife 是「生产日期+保质期」填法下填的保质期（别的填法是 null），新建物品时记进商品资料；
 * productionDate 是这种填法下算出到期日用的生产日期（别的填法、没算出来是 null），记在入库记录上
 */
export type ExpiryValue = { expiry: string | null; error: string | null; shelfLife: ShelfLife | null; productionDate: string | null };

type Tags = ExpiryFill['tags'];

/**
 * 过期日期的三种填法：直接选到期日 / 按包装上的「生产日期 + 保质期」算 / 不记录。
 * 计算结果通过 onChange 往上报。
 *
 * 拍照识别（手机上能用时）：日期格子右边有「拍日期」，拍喷码认出日期直接填；能分清生产日期、到期日的分好，
 * 和保质期对上了提示一下。认出来的格子浅蓝底、标「识别」，改过就不再标。
 * 拍包装识别出的结果由上层通过 fill 传进来（换 key 重新挂载时用作初始值）。
 *
 * 「同上次」：这个物品上次入库记了生产日期（lastProductionDate）时，生产日期下面有个小按钮「同上次：某年某月某日」，
 * 点一下填成那天、标「按上次」，到期日照常按保质期算；人再改日期标记就没了。生产日期已经是那天时不出按钮。
 */
export function ExpiryInput({
  initialMode,
  initialExpiry = null,
  initialProductionDate,
  initialShelfLife = null,
  shelfLifeHint,
  fill = null,
  lastProductionDate = null,
  allowNone,
  onChange,
}: {
  initialMode: ExpiryMode;
  initialExpiry?: string | null;
  /** 生产日期的初始值；不给就是今天 */
  initialProductionDate?: string | null;
  /** 保质期的初始值（商品资料里的）；不给就是 12 个月 */
  initialShelfLife?: ShelfLife | null;
  /** 保质期下面的一句说明，例如「按商品资料填好了」 */
  shelfLifeHint?: string | null;
  /** 拍包装识别出来的：填法、日期、保质期和哪几格标「识别」 */
  fill?: ExpiryFill | null;
  /** 这个物品上次入库填的生产日期（见 lib/stockInDefaults.ts 的 lastProductionDate）；没有就不出「同上次」 */
  lastProductionDate?: string | null;
  allowNone: boolean;
  onChange: (value: ExpiryValue) => void;
}) {
  const expiryStyles = useExpiryStyles();
  const [mode, setMode] = useState<ExpiryMode>(fill?.mode ?? initialMode);
  const [expiry, setExpiry] = useState<string | null>(fill ? fill.expiry : initialExpiry);
  const [productionDate, setProductionDate] = useState<string | null>(
    fill ? fill.productionDate : initialProductionDate === undefined ? todayStr() : initialProductionDate,
  );
  const startShelf = fill ? fill.shelfLife : initialShelfLife;
  const [shelfAmount, setShelfAmount] = useState(fill && !fill.shelfLife ? '' : String(startShelf?.amount ?? 12));
  const [shelfUnit, setShelfUnit] = useState<ShelfLifeUnit>(startShelf?.unit ?? 'month');
  const [tags, setTags] = useState<Tags>(fill?.tags ?? {});
  const [note, setNote] = useState<string | null>(fill?.note ?? null);
  const [shelfEdited, setShelfEdited] = useState(false);
  const [scanTarget, setScanTarget] = useState<DateRole | null>(null);
  const canScan = isLabelOcrAvailable();

  const amount = Number(shelfAmount);
  const shelfValid = shelfAmount.trim() !== '' && Number.isInteger(amount) && amount > 0;
  // 保质期是真知道的（商品资料里的、照片认出的、人填过的），不是默认的 12 个月：拍日期时拿它和喷码上的日期互相印证
  const shelfKnown = !!initialShelfLife || !!fill?.shelfLife || shelfEdited;
  const knownShelfLife: ShelfLife | null = shelfKnown && shelfValid ? { amount, unit: shelfUnit } : null;
  let result: ExpiryValue;
  if (mode === 'none') {
    result = { expiry: null, error: null, shelfLife: null, productionDate: null };
  } else if (mode === 'date') {
    result = expiry
      ? { expiry, error: null, shelfLife: null, productionDate: null }
      : { expiry: null, error: '请选择过期日期', shelfLife: null, productionDate: null };
  } else if (!productionDate) {
    result = { expiry: null, error: '请选择生产日期', shelfLife: shelfValid ? { amount, unit: shelfUnit } : null, productionDate: null };
  } else if (!shelfValid) {
    result = { expiry: null, error: '保质期请填正整数', shelfLife: null, productionDate: null };
  } else {
    result = {
      expiry: expiryFromShelfLife(productionDate, amount, shelfUnit),
      error: null,
      shelfLife: { amount, unit: shelfUnit },
      productionDate,
    };
  }
  const sameAsLast = sameAsLastLabel(lastProductionDate, productionDate);

  useEffect(() => {
    onChange(result);
    // 只在算出来的结果变化时上报
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.expiry, result.error, result.shelfLife?.amount, result.shelfLife?.unit, result.productionDate]);

  function untag(field: keyof Tags) {
    setTags((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setNote(null);
  }

  /** 点「同上次」：生产日期填成上次入库那天，标「按上次」；别的格子的标记不动 */
  function applyLastProductionDate() {
    if (!lastProductionDate) return;
    setProductionDate(lastProductionDate);
    setTags((current) => ({ ...current, productionDate: 'last' }));
    setNote(null);
  }

  /** 拍日期回来：按认出的日期填，能分清的分好 */
  function applyDateScan(scan: DateScanResult) {
    setScanTarget(null);
    const plan = planExpiryFill({ dates: scan, shelfLife: knownShelfLife, shelfLifeRecognized: false, dateElsewhere: null });
    if (!plan) return;
    setMode(plan.mode);
    if (plan.mode === 'date') {
      setExpiry(plan.expiry);
    } else {
      setProductionDate(plan.productionDate);
      // 不知道保质期（只是默认的 12 个月）：清空让人照包装填，免得算错到期日
      if (!knownShelfLife) setShelfAmount('');
    }
    const nextTags: Tags = { ...tags };
    // 保质期还是商品资料里的（标「按资料」）就留着标；别的标记按这次拍的重来
    if (nextTags.shelfLife !== 'saved') delete nextTags.shelfLife;
    if (plan.tags.expiry) nextTags.expiry = plan.tags.expiry;
    if (plan.tags.productionDate) nextTags.productionDate = plan.tags.productionDate;
    if (plan.tags.shelfLife === 'missing') nextTags.shelfLife = 'missing';
    setTags(nextTags);
    setNote(plan.note);
  }

  const modeOptions: { value: ExpiryMode; label: string }[] = [
    { value: 'date', label: '选到期日' },
    { value: 'shelf', label: '生产日期+保质期' },
  ];
  if (allowNone) modeOptions.push({ value: 'none', label: '不记录' });

  const scanButton = (target: DateRole) =>
    canScan ? (
      <Button
        title="拍日期"
        icon="camera-outline"
        variant="secondary"
        compact
        style={expiryStyles.scanButton}
        onPress={() => setScanTarget(target)}
      />
    ) : null;

  return (
    <View style={expiryStyles.wrap}>
      <Segmented options={modeOptions} value={mode} onChange={setMode} />
      {mode === 'date' ? (
        <DateField
          label="过期日期"
          value={expiry}
          onChange={(value) => {
            setExpiry(value);
            untag('expiry');
          }}
          required
          tag={tags.expiry}
          right={scanButton('expiry')}
        />
      ) : null}
      {mode === 'shelf' ? (
        <View style={expiryStyles.wrap}>
          <DateField
            label="生产日期"
            value={productionDate}
            onChange={(value) => {
              setProductionDate(value);
              untag('productionDate');
            }}
            required
            tag={tags.productionDate}
            right={scanButton('production')}
          />
          {sameAsLast ? (
            <Button
              title={sameAsLast}
              icon="time-outline"
              variant="secondary"
              compact
              style={expiryStyles.sameAsLast}
              onPress={applyLastProductionDate}
            />
          ) : null}
          <NumberField
            label="保质期"
            required
            value={shelfAmount}
            onChangeText={(value) => {
              setShelfAmount(value);
              setShelfEdited(true);
              untag('shelfLife');
            }}
            min={1}
            max={9999}
            tag={tags.shelfLife}
          />
          <ChoiceChips
            options={[
              { value: 'day', label: '天' },
              { value: 'month', label: '个月' },
              { value: 'year', label: '年' },
            ]}
            value={shelfUnit}
            onChange={(value) => {
              setShelfUnit(value);
              setShelfEdited(true);
              untag('shelfLife');
            }}
          />
          {shelfLifeHint && !shelfEdited ? <Text style={expiryStyles.note}>{shelfLifeHint}</Text> : null}
          {result.expiry ? (
            <Text style={expiryStyles.computed}>
              到期日：<Text style={expiryStyles.computedDate}>{formatDate(result.expiry)}</Text>
            </Text>
          ) : null}
        </View>
      ) : null}
      {note ? <Text style={note.startsWith('✓') ? expiryStyles.confirmed : expiryStyles.scanNote}>{note}</Text> : null}
      {mode === 'none' ? <Text style={expiryStyles.note}>不记过期日期，只按库存数量提醒。</Text> : null}
      {scanTarget ? (
        <LabelCamera
          mode="date"
          target={scanTarget}
          shelfLife={knownShelfLife}
          onDone={applyDateScan}
          onClose={() => setScanTarget(null)}
        />
      ) : null}
    </View>
  );
}

// 照鸿蒙版 StockInputs.ets 的 ExpiryInput：分段选填法，下面的日期、保质期上下排，间隔 12
const useExpiryStyles = makeStyles((colors) => ({
  // 「拍日期」和旁边的日期框一样高、一样的圆角，排在一起是一个整体
  scanButton: { alignSelf: 'stretch', minHeight: 44, borderRadius: radius.sm },
  wrap: { gap: 12 },
  // 「同上次」：贴着生产日期那一格的小按钮，靠左、不占满一行
  sameAsLast: { alignSelf: 'flex-start', marginTop: -4 },
  computed: { fontSize: font.small, color: colors.muted },
  computedDate: { color: colors.accent, fontWeight: '700' },
  note: { fontSize: font.small, color: colors.faint },
  confirmed: { fontSize: font.small, color: colors.ok, fontWeight: '600' },
  scanNote: { fontSize: font.small, color: colors.warn, lineHeight: 18 },
}));
