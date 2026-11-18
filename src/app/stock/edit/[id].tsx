import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { StockProductForm } from '../../../components/StockProductForm';
import { Empty, Screen } from '../../../components/ui';
import { getSettings, type AppSettings } from '../../../db/settings';
import { findProductByBarcode, getProduct, updateProduct, type StockProduct } from '../../../db/stock';
import { rescheduleReminders } from '../../../lib/notifications';

export default function EditStockScreen() {
  const db = useSQLiteContext();
  const { id } = useLocalSearchParams<{ id: string }>();
  const productId = Number(id);
  const [state, setState] = useState<{ product: StockProduct | null; settings: AppSettings } | null>(null);

  useEffect(() => {
    Promise.all([getProduct(db, productId), getSettings(db)])
      .then(([product, settings]) => setState({ product, settings }))
      .catch(() => undefined);
  }, [db, productId]);

  if (!state) return null;
  if (!state.product) {
    return (
      <Screen>
        <Empty icon="help-circle-outline" title="找不到这个物品" text="可能已经被删除了。" />
      </Screen>
    );
  }

  const product = state.product;
  return (
    <StockProductForm
      initial={product}
      settings={state.settings}
      withFirstBatch={false}
      submitLabel="保存修改"
      onSubmit={async (input) => {
        if (input.barcode && input.barcode !== product.barcode) {
          const existing = await findProductByBarcode(db, input.barcode);
          if (existing && existing.id !== product.id) throw new Error(`这个条码已经给「${existing.name}」用了`);
        }
        await updateProduct(db, product.id, input);
        rescheduleReminders(db).catch(() => undefined);
        router.back();
      }}
    />
  );
}
