import { View } from 'react-native';
import { Text } from './Text';

import { toBaseQty, unitOptions, type PackUnit } from '../lib/packs';
import { formatQty, parseQty } from '../lib/stock';
import { makeStyles } from '../hooks/useTheme';
import { font } from '../theme';
import { NumberField } from './NumberField';
import { ChoiceChips, Label } from './ui';

/**
 * 数量 + 单位。物品设了包装规格（如 1 箱 = 24 瓶）时，可以按箱或按瓶填，
 * 下面实时显示换算成最小单位是多少。
 */
export function UnitQtyField({
  label,
  baseUnit,
  packs,
  qtyText,
  onQtyText,
  unit,
  onUnit,
  error,
  hint,
  autoFocus,
  max,
}: {
  label: string;
  baseUnit: string;
  packs: PackUnit[];
  qtyText: string;
  onQtyText: (text: string) => void;
  unit: string;
  onUnit: (unit: string) => void;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
  /** 最多填多少（最小单位，比如出库时的现有数）：按当前单位换算，到了上限「+」变灰 */
  max?: number;
}) {
  const unitStyles = useUnitStyles();
  const options = unitOptions(baseUnit, packs);
  const current = options.some((option) => option.value === unit) ? unit : baseUnit;
  const qty = parseQty(qtyText);
  const base = qty === null ? null : toBaseQty(qty, current, baseUnit, packs);
  const conversion = current !== baseUnit && base !== null && qty !== null && qty > 0 ? `= ${formatQty(base)} ${baseUnit}` : null;
  // 当前单位 1 个是几个最小单位（按箱填时 1 箱 = 24 瓶），上限按它换算，保留两位小数往下取
  const factor = toBaseQty(1, current, baseUnit, packs);
  const maxInUnit = max === undefined || !factor ? undefined : Math.floor((max / factor) * 100 + 1e-9) / 100;

  return (
    <View style={unitStyles.wrap}>
      {options.length > 1 ? (
        <View style={unitStyles.wrap}>
          <Label>按什么单位</Label>
          <ChoiceChips
            options={options.map((option) => ({ value: option.value, label: option.label }))}
            value={current}
            onChange={onUnit}
          />
        </View>
      ) : null}
      <NumberField
        label={`${label}（${current}）`}
        value={qtyText}
        onChangeText={onQtyText}
        decimals={2}
        max={maxInUnit ?? 1000000}
        suffix={current}
        error={error}
        hint={conversion ?? hint}
        autoFocus={autoFocus}
      />
      {conversion && hint ? <Text style={unitStyles.hint}>{hint}</Text> : null}
    </View>
  );
}

const useUnitStyles = makeStyles((colors) => ({
  wrap: { gap: 8 },
  hint: { fontSize: font.small, color: colors.faint },
}));
