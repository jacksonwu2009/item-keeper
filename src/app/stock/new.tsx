import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { StockProductForm } from '../../components/StockProductForm';
import { getSettings, type AppSettings } from '../../db/settings';
import { createProduct, findByBarcode } from '../../db/stock';
import { rescheduleReminders } from '../../lib/notifications';
import { isStockKind, KIND_LABEL } from '../../lib/stock';

export default function NewStockScreen() {
  const db = useSQLiteContext();
  const params = useLocalSearchParams<{ kind?: string; barcode?: string; scanLabel?: string }>();
  const kind = isStockKind(params.kind) ? params.kind : 'food';
  const barcode = typeof params.barcode === 'string' ? params.barcode : undefined;
  // 扫码页点「没有条码？拍包装识别」进来：一打开就拍
  const scanLabelOnOpen = params.scanLabel === '1';
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    getSettings(db).then(setSettings).catch(() => undefined);
  }, [db]);

  if (!settings) return <Stack.Screen options={{ title: `新增${KIND_LABEL[kind]}` }} />;

  return (
    <>
      <Stack.Screen options={{ title: `新增${KIND_LABEL[kind]}` }} />
      <StockProductForm
        initial={{ kind, barcode }}
        settings={settings}
        withFirstBatch
        scanLabelOnOpen={scanLabelOnOpen}
        // 条码本机已经录过：「去入库」打开它就是入库面板（扫的是包装条码时按那个包装入库），「打开它」只打开
        onUseExisting={(match, action) =>
          router.replace({
            pathname: '/stock/[id]',
            params:
              action === 'in'
                ? { id: String(match.product.id), in: '1', ...(match.pack ? { unit: match.pack.unit } : {}) }
                : { id: String(match.product.id) },
          })
        }
        submitLabel="保存"
        onSubmit={async (input, firstBatch) => {
          if (input.barcode) {
            const match = await findByBarcode(db, input.barcode, input.officeId);
            if (match) {
              const existing = match.product;
              const whose = match.pack ? `「${existing.name}」的${match.pack.unit}` : `「${existing.name}」`;
              Alert.alert('这个条码已经录过', `${whose}用的就是这个条码，直接去它那里入库吧。`, [
                { text: '取消', style: 'cancel' },
                {
                  text: '打开',
                  onPress: () =>
                    router.replace({
                      pathname: '/stock/[id]',
                      params: { id: String(existing.id), scanned: '1', ...(match.pack ? { unit: match.pack.unit } : {}) },
                    }),
                },
              ]);
              return;
            }
          }
          const id = await createProduct(db, input, firstBatch);
          rescheduleReminders(db).catch(() => undefined);
          router.replace({ pathname: '/stock/[id]', params: { id: String(id) } });
        }}
      />
    </>
  );
}
