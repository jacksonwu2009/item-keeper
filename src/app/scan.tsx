import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../components/ui';
import { findByBarcode } from '../db/stock';
import { useOffice } from '../hooks/useOffice';
import { putScanResult } from '../lib/scanHandoff';
import { isStockKind } from '../lib/stock';
import { font, radius } from '../theme';

/**
 * 两种用法：
 * - /scan?kind=food|daily：扫商品条码。认识的条码直接打开该物品（入库/出库），不认识的进新建页。
 * - /scan?target=xxx：给表单扫一个码（比如设备序列号），扫到后返回上一页。
 */
export default function ScanScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ kind?: string; target?: string }>();
  const kind = isStockKind(params.kind) ? params.kind : 'food';
  const target = typeof params.target === 'string' ? params.target : null;
  const [permission, requestPermission] = useCameraPermissions();
  const [manualCode, setManualCode] = useState('');
  const [torch, setTorch] = useState(false);
  const handled = useRef(false);

  async function handleCode(raw: string) {
    const code = raw.trim();
    if (!code || handled.current) return;
    handled.current = true;
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
    handleCode(result.data).catch(() => {
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
      <Text style={scanStyles.manualLabel}>扫不出来？手动输入条码</Text>
      <View style={scanStyles.manualRow}>
        <TextInput
          value={manualCode}
          onChangeText={setManualCode}
          placeholder="例如 6901234567892"
          placeholderTextColor="rgba(255,255,255,0.5)"
          keyboardType={target ? 'default' : 'number-pad'}
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
        <Text style={scanStyles.tip}>{target ? '对准序列号条码或二维码' : '把商品条码放进框里'}</Text>
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
