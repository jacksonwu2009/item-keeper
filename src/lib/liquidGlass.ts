import { Platform } from 'react-native';

/**
 * iOS 26 起的「液态玻璃」标题栏：系统给标题栏两边的按钮套一层共享的玻璃底，标题栏背景透明。
 * 自己画了底的按钮放进去会变成两层底（圆里套圆），所以 iOS 26 起返回键用系统的，右上角的自定义按钮关掉共享底。
 */
const iosMajorVersion = Platform.OS === 'ios' ? Number.parseInt(String(Platform.Version), 10) : 0;

export const IOS_LIQUID_GLASS = Platform.OS === 'ios' && iosMajorVersion >= 26;
export const IOS_BEFORE_LIQUID_GLASS = Platform.OS === 'ios' && iosMajorVersion < 26;
