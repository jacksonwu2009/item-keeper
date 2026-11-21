import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { colors } from '../theme';
import { styles } from './ui';

/**
 * 带扫码按钮的搜索框（清点页用）：和 SearchField 一样是胶囊形浅灰底、左边放大镜；
 * 给了 onScan 时右边一条竖线隔开一个条码图标（照鸿蒙版 IkSearchField 的 showScan），点了去扫码。
 * 其余属性和 TextInput 一样。获得焦点时描一圈主色。
 */
export function ScanSearchField({
  onScan,
  scanLabel = '扫码',
  style,
  onFocus,
  onBlur,
  ...inputProps
}: TextInputProps & { onScan?: () => void; scanLabel?: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.search, onScan ? scanStyles.withScan : null, focused && styles.searchFocused]}>
      <Ionicons name="search" size={18} color={colors.faint} />
      <TextInput
        placeholderTextColor={colors.faint}
        {...inputProps}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[styles.searchInput, scanStyles.input, style]}
      />
      {onScan ? (
        <>
          <View style={scanStyles.divider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={scanLabel}
            onPress={onScan}
            hitSlop={4}
            style={({ pressed }) => [scanStyles.scan, pressed && scanStyles.scanPressed]}
          >
            <Ionicons name="barcode-outline" size={22} color={colors.accent} />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const scanStyles = StyleSheet.create({
  // 网页上浏览器默认的焦点框是 outline-style: auto，只把宽度设成 0 去不掉；改成实线再配宽度 0 才不画（焦点由外面一圈胶囊边框表示）
  input: { outlineStyle: 'solid', outlineWidth: 0 },
  // 右边是圆形的扫码按钮，胶囊右侧只留 2
  withScan: { paddingRight: 2 },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 20, backgroundColor: colors.line },
  scan: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  scanPressed: { backgroundColor: colors.line },
});
