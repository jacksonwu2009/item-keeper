import { useNavigation, type NativeStackNavigationProp } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';

/** 收不到「打开动画结束」时最多等多久（安卓打开动画约 350 毫秒） */
const FALLBACK_MS = 600;

type OpenState = { done: boolean; promise: Promise<void>; resolve: () => void };

function newOpenState(done: boolean): OpenState {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  if (done) resolve();
  return { done, promise, resolve };
}

export type OpenTransition = {
  /** 这一页的打开动画结束时完成（已经结束过的马上完成） */
  opened: () => Promise<void>;
  /**
   * 先取数、动画后再交出结果：load 是已经开始跑的取数（读库在原生线程，不占界面线程），
   * 这里等它和打开动画都结束了才把结果交出去，页面这时才拿去画。取数失败也等动画结束才把错误抛出去。
   * 动画已经结束过的（回到这一页、换条件重读）不等，取到就交。
   */
  afterOpen: <T>(load: Promise<T>) => Promise<T>;
};

/**
 * 页面打开时取数、画列表用：打开动画进行时一次画很多行，会让动画停住一下（单据页在 Redmi K80 上实测停了约 0.37 秒）；
 * 读库本身在原生线程跑，不影响动画。所以一打开就开始取数，等动画结束再把结果交给页面去画（afterOpen）。
 * 打开动画结束 = 导航的 transitionEnd（不是关页那次）；收不到的情况（作为第一页打开、没有动画）最多等 FALLBACK_MS；
 * 网页版没有打开动画，一开始就是结束的。单机版、联网版这个文件一样。
 */
export function useOpenTransition(): OpenTransition {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const state = useRef<OpenState | null>(null);
  if (state.current === null) state.current = newOpenState(Platform.OS === 'web');

  useEffect(() => {
    const open = state.current;
    if (!open || open.done) return;
    const finish = () => {
      if (open.done) return;
      open.done = true;
      open.resolve();
    };
    const unsubscribe = navigation.addListener('transitionEnd', (event) => {
      if (!event.data.closing) finish();
    });
    const timer = setTimeout(finish, FALLBACK_MS);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [navigation]);

  return useMemo<OpenTransition>(() => {
    const opened = () => (state.current as OpenState).promise;
    return {
      opened,
      afterOpen: async <T,>(load: Promise<T>): Promise<T> => {
        try {
          return await load;
        } finally {
          await opened();
        }
      },
    };
  }, []);
}
