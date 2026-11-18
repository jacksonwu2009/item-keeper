/**
 * 取当前位置并查出地名，用来给办公点起名。
 * 先用手机系统的地名查询（iPhone 用苹果的，国内可用）；系统查不到时
 * （安卓没有谷歌服务的手机常见）再把坐标发给 OpenStreetMap 查。
 */

import * as Location from 'expo-location';

import { partsFromNominatim, type PlaceParts } from './placeName';

export class LocateError extends Error {}

const LOCATE_TIMEOUT_MS = 15000;
const LOOKUP_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocateError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function currentCoords(): Promise<{ latitude: number; longitude: number }> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) {
    throw new LocateError(
      permission.canAskAgain ? '没有允许使用位置，可以手动填名称' : '定位权限被关了，要用的话去系统设置里打开',
    );
  }
  // 5 分钟内的上次位置够用了，起名不需要很准
  const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 }).catch(() => null);
  if (last) return last.coords;
  const position = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    LOCATE_TIMEOUT_MS,
    '定位超时了，到窗边或打开 Wi-Fi 再试',
  );
  return position.coords;
}

async function systemLookup(coords: { latitude: number; longitude: number }): Promise<PlaceParts | null> {
  try {
    const [address] = await withTimeout(Location.reverseGeocodeAsync(coords), LOOKUP_TIMEOUT_MS, 'timeout');
    if (!address) return null;
    const parts: PlaceParts = {
      name: address.name,
      street: address.street,
      district: address.district ?? address.subregion,
      city: address.city,
      region: address.region,
    };
    return parts.city || parts.district || parts.street ? parts : null;
  } catch {
    return null;
  }
}

async function openStreetMapLookup(coords: { latitude: number; longitude: number }): Promise<PlaceParts | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const url =
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=zh-CN' +
      `&lat=${coords.latitude.toFixed(5)}&lon=${coords.longitude.toFixed(5)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ItemKeeper/1.3 (office name suggestion)' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return partsFromNominatim(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 取当前位置的地址。失败时抛 LocateError，消息直接给用户看。 */
export async function locatePlace(): Promise<PlaceParts> {
  const coords = await currentCoords();
  const parts = (await systemLookup(coords)) ?? (await openStreetMapLookup(coords));
  if (!parts) throw new LocateError('定位到了，但查不出地名，请手动填名称');
  return parts;
}
