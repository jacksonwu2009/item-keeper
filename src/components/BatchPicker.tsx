import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from './Text';

import { formatDate, formatShortDate } from '../lib/dates';
import { sanitizeNumberText } from '../lib/number';
import {
  allocationError,
  defaultAllocation,
  earliestBatch,
  formatQty,
  isDefaultAllocation,
  parseQty,
  roundQty,
  skipsEarliestBatch,
  type BatchAllocation,
} from '../lib/stock';
import { makeStyles } from '../hooks/useTheme';
import { font, radius } from '../theme';
import { NumberField } from './NumberField';
import { Label } from './ui';

/** 可选的一批：本机 id、服务端编号（没同步为空）、现有数量、过期日期 */
export type PickerBatch = { id: number; uid: string | null; quantity: number; expiryDate: string | null };

/** 「最早一批 <日期> 到期，建议先用这批」（没有过期日期就不提示） */
export function earliestHint(batches: readonly PickerBatch[]): string | null {
  const earliest = earliestBatch(batches);
  return earliest?.expiryDate ? `最早一批 ${formatDate(earliest.expiryDate)} 到期，建议先用这批` : null;
}

/**
 * 父组件提交前用：要发给数据层的分配。没改（和先到期先出一样）、或不能指定时为 null；
 * 填得不对时 error 不为空（拦下提交）。
 */
export function pickedAllocation(
  batches: readonly PickerBatch[],
  amount: number | null,
  value: BatchAllocation[] | null,
): { allocations: BatchAllocation[] | null; error: string | null } {
  if (!value || amount === null || amount <= 0) return { allocations: null, error: null };
  const error = allocationError(batches, amount, value);
  if (error) return { allocations: null, error };
  return { allocations: isDefaultAllocation(batches, amount, value) ? null : value, error: null };
}

/** 批次那一行的标题：今年到期的只写月日（窄屏上和 − / + 放得下一行），别的年份写全 */
function batchTitle(expiryDate: string | null): string {
  if (!expiryDate) return '不记过期日期';
  const thisYear = expiryDate.slice(0, 4) === String(new Date().getFullYear());
  return `${thisYear ? formatShortDate(expiryDate) : formatDate(expiryDate)} 到期`;
}

/**
 * 「从哪一批出」：物品有两批以上时显示。列出每一批的过期日期和现有数量，按先到期先出预填，可以改；
 * 合计要等于要出的数量。没改时 value 为 null（按先到期先出，不用告诉服务端）。
 * 最早到期的那批还有剩、却从更晚的批次出时提醒（不拦）。
 * 开了同步、有还没同步的批次时不能指定（服务端认不出那一批）。
 */
export function BatchPicker({
  batches,
  amount,
  unit,
  value,
  onChange,
  syncEnabled,
  collapsible = false,
  showErrors = false,
}: {
  batches: readonly PickerBatch[];
  /** 要出的数量（最小单位）；还没填好为 null */
  amount: number | null;
  unit: string;
  value: BatchAllocation[] | null;
  onChange: (value: BatchAllocation[] | null) => void;
  syncEnabled: boolean;
  /** 单据里每行默认收起，点开再选 */
  collapsible?: boolean;
  showErrors?: boolean;
}) {
  const pickerStyles = usePickerStyles();
  const [open, setOpen] = useState(!collapsible);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const inStock = batches.filter((batch) => batch.quantity > 0);
  if (inStock.length < 2) return null;

  const hint = earliestHint(inStock);
  const total = roundQty(inStock.reduce((sum, batch) => sum + batch.quantity, 0));
  // 开了同步时，还没同步的批次服务端认不出：这几行不能填（指定时按 0 算）
  const rowLocked = (batch: PickerBatch) => syncEnabled && !batch.uid;
  const unsynced = inStock.some(rowLocked);
  const tooMuch = amount !== null && amount > total;
  const locked = tooMuch || amount === null || amount <= 0;
  const shown = value ?? (amount !== null && amount > 0 && !tooMuch ? defaultAllocation(inStock, amount) : []);
  const quantityOf = (batchId: number) => shown.find((item) => item.batchId === batchId)?.quantity ?? 0;
  const error = value && amount !== null ? allocationError(inStock, amount, value) : null;
  const skipping = value ? skipsEarliestBatch(inStock, value) : false;
  const sum = roundQty(shown.reduce((acc, item) => acc + item.quantity, 0));
  const summary = value && amount !== null && !isDefaultAllocation(inStock, amount, value) ? '已指定批次' : '按先到期先出';

  function change(batchId: number, text: string) {
    const clean = sanitizeNumberText(text, 2);
    setTexts((current) => ({ ...current, [batchId]: clean }));
    const quantity = parseQty(clean) ?? 0;
    const next = inStock.map((batch) => ({
      batchId: batch.id,
      quantity: rowLocked(batch) ? 0 : batch.id === batchId ? quantity : quantityOf(batch.id),
    }));
    onChange(next);
  }

  function reset() {
    setTexts({});
    onChange(null);
  }

  return (
    <View style={pickerStyles.box}>
      <Pressable
        accessibilityRole={collapsible ? 'button' : undefined}
        accessibilityLabel={`从哪一批出，${summary}`}
        disabled={!collapsible}
        onPress={() => setOpen((current) => !current)}
        style={pickerStyles.header}
      >
        <Label>从哪一批出</Label>
        {collapsible ? (
          <Text style={pickerStyles.toggle}>
            {summary} {open ? '▲' : '▼'}
          </Text>
        ) : null}
      </Pressable>
      {hint ? <Text style={[pickerStyles.hint, skipping && pickerStyles.hintWarn]}>{hint}</Text> : null}
      {open ? (
        <>
          {inStock.map((batch) => {
            const shownQty = quantityOf(batch.id);
            const disabled = locked || rowLocked(batch);
            const text = texts[batch.id] ?? (locked ? '' : formatQty(shownQty));
            return (
              <View key={batch.id} style={pickerStyles.row}>
                <View style={pickerStyles.rowMain}>
                  <Text style={pickerStyles.rowTitle}>{batchTitle(batch.expiryDate)}</Text>
                  <Text style={pickerStyles.rowSub}>
                    现有 {formatQty(batch.quantity)} {unit}
                  </Text>
                </View>
                {/* 和上面的总数一样有 − / +，最多到这一批现有的数 */}
                <View style={pickerStyles.stepper}>
                  <NumberField
                    value={text}
                    onChangeText={(next) => change(batch.id, next)}
                    decimals={2}
                    min={0}
                    max={batch.quantity}
                    disabled={disabled}
                    placeholder={disabled ? '—' : '0'}
                    accessibilityLabel={`${batch.expiryDate ?? '不记过期日期'}这一批出多少`}
                    inputStyle={[pickerStyles.input, disabled && pickerStyles.inputLocked]}
                  />
                </View>
              </View>
            );
          })}
          {unsynced && !tooMuch ? (
            <Text style={pickerStyles.note}>有刚入库、还没同步的批次，同步后才能从这几批指定（不改就按先到期先出）。</Text>
          ) : null}
          {tooMuch ? (
            <Text style={pickerStyles.note}>要出的比现有的多，按现有的全部出，不用选批次。</Text>
          ) : amount !== null && amount > 0 ? (
            <View style={pickerStyles.footer}>
              <Text style={[pickerStyles.sum, error && showErrors ? pickerStyles.error : null]}>
                合计 {formatQty(sum)} / 要出 {formatQty(amount)} {unit}
              </Text>
              {value ? (
                <Pressable accessibilityRole="button" onPress={reset} hitSlop={8}>
                  <Text style={pickerStyles.reset}>按先到期先出</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {error && (showErrors || value) ? <Text style={pickerStyles.error}>{error}</Text> : null}
          {skipping && !error ? (
            <Text style={pickerStyles.warn}>最早到期的那批还有剩，却先用了后面的批次。确认是这样就不用改。</Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

// 照鸿蒙版 BatchPickerBox：浅灰圆角块，每一批一行（左边到期日和现有数量，右边白底小输入框）
const usePickerStyles = makeStyles((colors) => ({
  box: {
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
    padding: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 },
  toggle: { fontSize: font.small, color: colors.accent, fontWeight: '500' },
  hint: { fontSize: font.small, color: colors.muted },
  hintWarn: { color: colors.warn, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: font.body, color: colors.ink, fontWeight: '500' },
  rowSub: { fontSize: font.small, color: colors.muted },
  // − 输入框 + 一共这么宽，左边的到期日、现有数量占剩下的
  stepper: { width: 164 },
  input: {
    minHeight: 40,
    paddingVertical: 6,
    paddingHorizontal: 6,
    backgroundColor: colors.surface,
    borderColor: colors.surface,
    fontSize: font.body,
  },
  inputLocked: { opacity: 0.5 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sum: { fontSize: font.small, color: colors.ink, fontVariant: ['tabular-nums'] },
  reset: { fontSize: font.small, color: colors.accent, fontWeight: '500' },
  note: { fontSize: font.small, color: colors.warn, lineHeight: 19 },
  warn: { fontSize: font.small, color: colors.warn, lineHeight: 19 },
  error: { fontSize: font.small, color: colors.danger },
}));
