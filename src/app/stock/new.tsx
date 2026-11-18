import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { StockProductForm } from '../../components/StockProductForm';
import { getSettings, type AppSettings } from '../../db/settings';
import { createProduct, findProductByBarcode } from '../../db/stock';
import { rescheduleReminders } from '../../lib/notifications';
import { isStockKind, KIND_LABEL } from '../../lib/stock';

export default function NewStockScreen() {
  const db = useSQLiteContext();
  const params = useLocalSearchParams<{ kind?: string; barcode?: string }>();
  const kind = isStockKind(params.kind) ? params.kind : 'food';
  const barcode = typeof params.barcode === 'string' ? params.barcode : undefined;
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
        submitLabel="保存"
        onSubmit={async (input, firstBatch) => {
          if (input.barcode) {
            const existing = await findProductByBarcode(db, input.barcode);
            if (existing) {
              Alert.alert('这个条码已经录过', `「${existing.name}」用的就是这个条码，直接去它那里入库吧。`, [
                { text: '取消', style: 'cancel' },
                {
                  text: '打开',
                  onPress: () =>
                    router.replace({ pathname: '/stock/[id]', params: { id: String(existing.id), scanned: '1' } }),
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
