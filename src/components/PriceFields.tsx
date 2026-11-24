import { Text, View } from 'react-native';

import {
  derivePrice,
  PRICE_MAX,
  TOTAL_PRICE_DECIMALS,
  UNIT_PRICE_DECIMALS,
  type PriceDraft,
} from '../lib/price';
import type { ScanTag } from '../lib/labelScan';
import { makeStyles } from '../hooks/useTheme';
import { font } from '../theme';
import { NumberField } from './NumberField';

/**
 * 入库的单价、总价，并排两个框，都可以不填。
 * 填单价就按数量算出总价，填总价就算出单价；数量变了，没手填的那个跟着重新算。
 * qty 是按 unit 计的数量（按箱入库就是箱数）。
 */
export function PriceFields({
  draft,
  onChange,
  qty,
  unit,
  hint,
  tag,
}: {
  draft: PriceDraft;
  onChange: (draft: PriceDraft) => void;
  qty: number | null;
  /** 单价按这个单位算，如「箱」「瓶」 */
  unit: string;
  hint?: string | null;
  /** 价格是自动带出来的（如按上次进价）：标在单价后面，人改过就不传 */
  tag?: ScanTag | null;
}) {
  const priceStyles = usePriceStyles();
  const { unitText, totalText } = derivePrice(draft, qty);
  return (
    <View style={priceStyles.wrap}>
      <View style={priceStyles.row}>
        <View style={priceStyles.cell}>
          <NumberField
            label={`单价（每${unit}）`}
            value={unitText}
            onChangeText={(text) => onChange({ source: 'unit', text })}
            decimals={UNIT_PRICE_DECIMALS}
            max={PRICE_MAX}
            buttons={false}
            placeholder="选填"
            tag={tag}
          />
        </View>
        <View style={priceStyles.cell}>
          <NumberField
            label="总价"
            value={totalText}
            onChangeText={(text) => onChange({ source: 'total', text })}
            decimals={TOTAL_PRICE_DECIMALS}
            max={PRICE_MAX}
            buttons={false}
            placeholder="选填"
          />
        </View>
      </View>
      <Text style={priceStyles.hint}>{hint ?? '选填，建议填上。填单价自动算总价，填总价自动算单价。'}</Text>
    </View>
  );
}

const usePriceStyles = makeStyles((colors) => ({
  wrap: { gap: 6 },
  row: { flexDirection: 'row', gap: 12 },
  cell: { flex: 1, minWidth: 0 },
  hint: { fontSize: font.small, color: colors.faint },
}));
