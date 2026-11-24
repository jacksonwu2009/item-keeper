import { requireOptionalNativeModule } from 'expo';

/**
 * 原生模块 NightMode（只有安卓）：把 App 里选的颜色模式交给系统记住，下次启动时系统画的开屏就用对应的底色。
 * iOS 的开屏只能跟着系统；网页没有开屏。没有这个模块的地方（iOS、网页、Expo Go）什么也不做。
 */
type NativeNightMode = {
  setNightMode(mode: 'system' | 'light' | 'dark'): boolean;
};

const native = requireOptionalNativeModule<NativeNightMode>('NightMode');

/** 让系统记住这个 App 用浅色、深色还是跟随系统。返回记上了没有 */
export function rememberNightMode(mode: 'system' | 'light' | 'dark'): boolean {
  try {
    return native?.setNightMode(mode) ?? false;
  } catch {
    return false;
  }
}
