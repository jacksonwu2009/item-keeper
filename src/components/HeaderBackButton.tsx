import { Platform, StyleSheet } from 'react-native';

import { CircleIconButton } from './CircleIconButton';

/**
 * 二级页左上角的返回：鸿蒙版标题栏那样的浅灰圆形按钮，里面一个向左的箭头，标题紧跟在右边。
 * 点了回上一页（和原来的系统返回按钮一样）；没有上一页时 _layout 不放这个按钮（和原来一样）。
 */
export function HeaderBackButton({ onPress }: { onPress: () => void }) {
  return <CircleIconButton icon="chevron-back" label="返回" onPress={onPress} style={backStyles.button} />;
}

const backStyles = StyleSheet.create({
  // 网页版的标题栏左边不留空，和页面内容一样空出 16；手机上系统标题栏自己留了边距。和标题之间留 8
  button: { marginLeft: Platform.OS === 'web' ? 16 : 0, marginRight: 8 },
});
