import { forwardRef, type ComponentRef } from 'react';
import { Platform, StyleSheet, Text as NativeText, type TextProps } from 'react-native';

/**
 * 全 App 用的 Text：安卓上给每段文字显式指定系统字体（sans-serif）、字距 0，其余和 react-native 的 Text 一样。
 *
 * 为什么：RN 量文字宽度用的是自己的画笔，字体是 App 启动时的系统默认字体；画字时，没指定字体的文字用的是系统文字控件自己的字体。
 * 红米（HyperOS 4）切换深色 / 浅色时会换掉系统文字控件的字体（浅色下更宽），App 不重启，宽度还是按原来的字体量的，
 * 字就画不下：「09:00」显示成「09:…」，「11月24日 19:14」挤到第二行。显式指定字体后，量和画用的是同一个字体。
 * 只给 fontWeight 不行：那样画字时还是以系统控件当前的字体为底。
 *
 * 不要直接从 react-native 引 Text（eslint 拦着），用这个。网页版、iOS 不加任何样式。
 */
const androidBase =
  Platform.OS === 'android' ? StyleSheet.create({ text: { fontFamily: 'sans-serif', letterSpacing: 0 } }).text : undefined;

export const Text = forwardRef<ComponentRef<typeof NativeText>, TextProps>(function Text({ style, ...props }, ref) {
  return <NativeText ref={ref} {...props} style={androidBase ? [androidBase, style] : style} />;
});
