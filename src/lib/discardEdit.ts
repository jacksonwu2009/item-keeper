/**
 * 编辑物品资料页改过东西再返回（返回键、左上角返回、手势返回）时先问「放弃修改？」：
 * 「继续编辑」留在页面、改的内容都在；「放弃」不保存、离开。没改过直接返回；点「保存」成功后离开不问。
 * 页面里用 expo-router 的 usePreventRemove 拦住离开，拦下来以后调 leaveEditPage 决定问不问。
 * 不引 react-native，单测能直接跑。
 */

export const DISCARD_EDIT_TITLE = '放弃修改？';
export const DISCARD_EDIT_MESSAGE = '改过的内容不会保存';

/** 确认框的按钮（和 react-native 的 AlertButton 一样的写法） */
export type DiscardButton = { text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };

/**
 * 离开被拦下来了：刚点了「保存」（saving）就直接离开，不问；否则弹「放弃修改？」——「继续编辑」什么都不做，「放弃」才离开。
 * ask 传弹框的函数（Alert.alert，联网版传 lib/alert 的 showAlert），leave 传继续这次离开的函数
 */
export function leaveEditPage(
  saving: boolean,
  leave: () => void,
  ask: (title: string, message: string, buttons: DiscardButton[]) => void,
): void {
  if (saving) {
    leave();
    return;
  }
  ask(DISCARD_EDIT_TITLE, DISCARD_EDIT_MESSAGE, [
    { text: '继续编辑', style: 'cancel' },
    { text: '放弃', style: 'destructive', onPress: leave },
  ]);
}
