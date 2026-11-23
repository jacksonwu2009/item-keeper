import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { StockProductForm } from '../../../components/StockProductForm';
import { Empty, Screen } from '../../../components/ui';
import { getSettings, type AppSettings } from '../../../db/settings';
import { getProduct, listPacks, productShelfLife, updateProduct, type StockProduct } from '../../../db/stock';
import type { PackUnit } from '../../../lib/packs';
import { rescheduleReminders } from '../../../lib/notifications';

export default function EditStockScreen() {
  const db = useSQLiteContext();
  const { id } = useLocalSearchParams<{ id: string }>();
  const productId = Number(id);
  const [state, setState] = useState<{ product: StockProduct | null; packs: PackUnit[]; settings: AppSettings } | null>(
    null,
  );

  useEffect(() => {
    Promise.all([getProduct(db, productId), listPacks(db, productId), getSettings(db)])
      .then(([product, packs, settings]) => setState({ product, packs, settings }))
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
      initial={{ ...product, packs: state.packs, shelfLife: productShelfLife(product) }}
      settings={state.settings}
      withFirstBatch={false}
      submitLabel="保存修改"
      onSubmit={async (input) => {
        // 条码（含包装条码）和别的物品冲突时 updateProduct 会抛出给用户看的错误
        await updateProduct(db, product.id, input);
        rescheduleReminders(db).catch(() => undefined);
        router.back();
      }}
    />
  );
}
