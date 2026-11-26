import { useNavigation } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

/** 打开动画最长按多久算（安卓原生的进场动画约 350 毫秒）：收不到「动画结束」时到点也照常往下走 */
const OPEN_ANIMATION_MAX_MS = 600;

type Gate = { promise: Promise<void>; open: () => void };

function createGate(): Gate {
  if (Platform.OS === 'web') return { promise: Promise.resolve(), open: () => undefined };
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

type TransitionEvents = { addListener(type: 'transitionEnd', listener: () => void): () => void };

/**
 * 等这一页的打开动画结束：返回的函数第一次调用时等到动画结束（transitionEnd，最多等 600 毫秒）再继续，以后马上继续。
 * 报表这类页面先显示页面框架和加载状态，读库、算数放到动画之后，不和打开动画抢时间。网页版没有打开动画，不等。
 */
export function useOpenAnimationDone(): () => Promise<void> {
  const navigation = useNavigation();
  const [gate] = useState(createGate);
  useEffect(() => {
    const timer = setTimeout(gate.open, OPEN_ANIMATION_MAX_MS);
    const unsubscribe = (navigation as unknown as TransitionEvents).addListener('transitionEnd', gate.open);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [navigation, gate]);
  return useCallback(() => gate.promise, [gate]);
}
