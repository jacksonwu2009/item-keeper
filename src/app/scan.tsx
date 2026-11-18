import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../components/ui';
import { findDeviceBySerial } from '../db/devices';
import { findByBarcode } from '../db/stock';
import { useOffice } from '../hooks/useOffice';
import { parseDeviceCode } from '../lib/devicePresets';
import { putScanResult } from '../lib/scanHandoff';
import { isStockKind } from '../lib/stock';
import { font, radius } from '../theme';

/**
 * 几种用法：
 * - /scan?kind=food|daily：扫商品条码。认识的条码直接打开该物品（入库/出库），不认识的进新建页。
 * - /scan?target=xxx：给表单扫一个码，扫到后返回上一页。
 * - mode=device：扫设备序列号。只认序列号条码（苹果包装盒上的去掉前面的 S），扫到商品条码、型号编号会提示换一个；
 *   不带 target 时，登记过的序列号直接打开那台设备，没登记过的进新增页（带 template 时沿用那一台的信息）。
 */
export default function ScanScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ kind?: string; target?: string; mode?: string; template?: string }>();
  const kind = isStockKind(params.kind) ? params.kind : 'food';
  const target = typeof params.target === 'string' ? params.target : null;
  const deviceMode = params.mode === 'device';
  const templateId = typeof params.template === 'string' ? params.template : null;
  const [notice, setNotice] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [manualCode, setManualCode] = useState('');
  const [torch, setTorch] = useState(false);
  const handled = useRef(false);

  async function handleCode(raw: string, barcodeType: string | null = null) {
    const code = raw.trim();
    if (!code || handled.current) return;
    handled.current = true;

    if (deviceMode) {
      const parsed = parseDeviceCode(code, barcodeType);
      if (parsed.kind === 'notSerial') {
        // 不是序列号：提示一下，过一会儿接着扫（相机会一直报同一个码，不能马上放开）
        setNotice(parsed.reason);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
        setTimeout(() => {
          handled.current = false;
        }, 1500);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      if (target) {
        putScanResult(target, parsed.serial);
        router.back();
        return;
      }
      const existing = await findDeviceBySerial(db, parsed.serial, office.filterId);
      if (existing) {
        router.replace({ pathname: '/device/[id]', params: { id: String(existing.id) } });
      } else {
        router.replace({
          pathname: '/device/new',
          params: { serial: parsed.serial, ...(templateId ? { template: templateId } : {}) },
        });
      }
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    if (target) {
      putScanResult(target, code);
      router.back();
      return;
    }
    // 只在当前办公点里认条码；看「全部办公点」时哪个办公点有就打开哪个
    const match = await findByBarcode(db, code, office.filterId);
    if (match) {
      // 扫到的是整箱等包装上的条码时，带上包装单位，入库默认按这个单位
      router.replace({
        pathname: '/stock/[id]',
        params: { id: String(match.product.id), scanned: '1', ...(match.pack ? { unit: match.pack.unit } : {}) },
      });
    } else {
      router.replace({ pathname: '/stock/new', params: { kind, barcode: code } });
    }
  }

  function onScanned(result: BarcodeScanningResult) {
    handleCode(result.data, result.type).catch(() => {
      handled.current = false;
    });
  }

  const closeButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="关闭扫码"
      onPress={() => router.back()}
      style={[scanStyles.close, { top: insets.top + 8, left: insets.left + 12 }]}
      hitSlop={10}
    >
      <Ionicons name="close" size={26} color="#FFFFFF" />
    </Pressable>
  );

  const manualEntry = (
    <View style={scanStyles.manual}>
      <Text style={scanStyles.manualLabel}>{deviceMode ? '扫不出来？手动输入序列号' : '扫不出来？手动输入条码'}</Text>
      <View style={scanStyles.manualRow}>
        <TextInput
          value={manualCode}
          onChangeText={setManualCode}
          placeholder={deviceMode ? '例如 C02XK1ABJGH5' : '例如 6901234567892'}
          placeholderTextColor="rgba(255,255,255,0.5)"
          keyboardType={target || deviceMode ? 'default' : 'number-pad'}
          autoCapitalize="characters"
          style={scanStyles.manualInput}
          returnKeyType="done"
          onSubmitEditing={() => handleCode(manualCode)}
        />
        <Button title="确定" compact onPress={() => handleCode(manualCode)} disabled={!manualCode.trim()} />
      </View>
    </View>
  );

  if (!permission) {
    return <View style={scanStyles.dark}>{closeButton}</View>;
  }

  if (!permission.granted) {
    return (
      <View style={[scanStyles.dark, scanStyles.center, { paddingTop: insets.top + 60 }]}>
        {closeButton}
        <Ionicons name="camera-outline" size={44} color="#FFFFFF" />
        <Text style={scanStyles.permissionTitle}>需要相机权限才能扫码</Text>
        <Text style={scanStyles.permissionText}>相机只用来识别条码，不会拍照或上传。</Text>
        {permission.canAskAgain ? (
          <Button title="允许使用相机" onPress={() => requestPermission()} style={scanStyles.permissionButton} />
        ) : (
          <Button title="去系统设置开启" onPress={() => Linking.openSettings()} style={scanStyles.permissionButton} />
        )}
        <View style={[scanStyles.bottom, { paddingBottom: insets.bottom + 16 }]}>{manualEntry}</View>
      </View>
    );
  }

  return (
    <View style={scanStyles.dark}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{
          barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'itf14', 'qr', 'datamatrix'],
        }}
        onBarcodeScanned={onScanned}
      />
      <View style={scanStyles.overlay} pointerEvents="none">
        <View style={scanStyles.frame} />
        <Text style={scanStyles.tip}>
          {deviceMode
            ? '扫包装盒标签上 Serial No. 的条码'
            : target?.startsWith('stocktake')
              ? '扫物品或包装上的条码，设备扫序列号'
              : target
                ? '对准序列号条码或二维码'
                : '把商品条码放进框里'}
        </Text>
        {deviceMode && !notice ? (
          <Text style={scanStyles.subTip}>没有包装盒的，序列号在电脑「关于本机」里，可以在下面手动输入</Text>
        ) : null}
        {notice ? <Text style={scanStyles.notice}>{notice}</Text> : null}
      </View>
      {closeButton}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={torch ? '关闭手电筒' : '打开手电筒'}
        onPress={() => setTorch((value) => !value)}
        style={[scanStyles.torch, { top: insets.top + 8, right: insets.right + 12 }]}
        hitSlop={10}
      >
        <Ionicons name={torch ? 'flashlight' : 'flashlight-outline'} size={24} color="#FFFFFF" />
      </Pressable>
      <View style={[scanStyles.bottom, { paddingBottom: insets.bottom + 16 }]}>{manualEntry}</View>
    </View>
  );
}

const scanStyles = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#0B0F0D' },
  center: { alignItems: 'center', gap: 10, paddingHorizontal: 32 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 16 },
  frame: {
    width: '78%',
    aspectRatio: 1.6,
    maxWidth: 360,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    borderRadius: radius.lg,
  },
  tip: { color: '#FFFFFF', fontSize: font.body, fontWeight: '600' },
  subTip: { color: 'rgba(255,255,255,0.75)', fontSize: font.small, textAlign: 'center', paddingHorizontal: 32 },
  notice: {
    color: '#FFFFFF',
    fontSize: font.small,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: 'rgba(196,60,44,0.85)',
    borderRadius: radius.sm,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginHorizontal: 24,
  },
  close: {
    position: 'absolute',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  torch: {
    position: 'absolute',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16 },
  manual: { backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: radius.md, padding: 12, gap: 8 },
  manualLabel: { color: 'rgba(255,255,255,0.8)', fontSize: font.small },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  manualInput: {
    flex: 1,
    minHeight: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    paddingHorizontal: 10,
    color: '#FFFFFF',
    fontSize: font.body,
  },
  permissionTitle: { color: '#FFFFFF', fontSize: font.heading, fontWeight: '700', marginTop: 8 },
  permissionText: { color: 'rgba(255,255,255,0.7)', fontSize: font.small, textAlign: 'center' },
  permissionButton: { marginTop: 12, alignSelf: 'stretch' },
});
