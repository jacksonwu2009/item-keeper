import { useState } from 'react';
import { Text, View } from 'react-native';

import { derivePrice, storedPriceDraft, type EntryPrice, type PriceDraft } from '../lib/price';
import { describeStockIn, enteredQtyOf, type StockInRecord } from '../lib/stockInDefaults';
import { makeStyles } from '../hooks/useTheme';
import { font } from '../theme';
import { PriceFields } from './PriceFields';
import { Button, Sheet } from './ui';

/** 一条入库记录的价格：没改过的那条记录的单价、总价 */
export type StockInPriceRecord = StockInRecord & { unitPrice: number | null; totalPrice: number | null };

/**
 * 改一条入库记录的单价 / 总价：上面写哪天入库、几件，下面两个框互相换算（和入库面板一样）。
 * draft 由外面管着（编辑页保存时一起存，出入库记录里点开是单独的面板）。
 */
export function StockInPriceFields({
  record,
  baseUnit,
  draft,
  onChange,
}: {
  record: StockInPriceRecord;
  baseUnit: string;
  draft: PriceDraft;
  onChange: (draft: PriceDraft) => void;
}) {
  const priceEditStyles = usePriceEditStyles();
  const entered = enteredQtyOf(record, baseUnit);
  return (
    <View style={priceEditStyles.wrap}>
      <Text style={priceEditStyles.record}>{describeStockIn(record, baseUnit)}</Text>
      <PriceFields
        draft={draft}
        onChange={onChange}
        qty={entered.qty}
        unit={entered.unit}
        hint={
          record.unitPrice === null && record.totalPrice === null
            ? '这次入库没记价格，可以补上。填单价自动算总价，填总价自动算单价。'
            : '填单价自动算总价，填总价自动算单价；清空就不记价格。'
        }
      />
    </View>
  );
}

/** 价格框里现在的值能存成什么：没填是 null（不记价格） */
export function draftPrice(record: StockInPriceRecord, baseUnit: string, draft: PriceDraft): EntryPrice | null {
  return derivePrice(draft, enteredQtyOf(record, baseUnit).qty).price;
}

/** 出入库记录里点一条入库记录：单独改它的价格 */
export function MovementPriceSheet({
  record,
  baseUnit,
  onClose,
  onSave,
}: {
  record: StockInPriceRecord;
  baseUnit: string;
  onClose: () => void;
  onSave: (price: EntryPrice | null) => Promise<void>;
}) {
  const priceEditStyles = usePriceEditStyles();
  const [draft, setDraft] = useState<PriceDraft>(() => storedPriceDraft(record));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet visible title="改入库价格" onClose={onClose}>
      <StockInPriceFields record={record} baseUnit={baseUnit} draft={draft} onChange={setDraft} />
      {error ? <Text style={priceEditStyles.error}>{error}</Text> : null}
      <Button
        title="保存"
        loading={busy}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await onSave(draftPrice(record, baseUnit, draft));
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : '保存失败，请重试');
          } finally {
            setBusy(false);
          }
        }}
      />
    </Sheet>
  );
}

const usePriceEditStyles = makeStyles((colors) => ({
  wrap: { gap: 12 },
  record: { fontSize: font.body, color: colors.ink, fontWeight: '500' },
  error: { fontSize: font.small, color: colors.danger },
}));
