import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { StockProductForm } from '../../../components/StockProductForm';
import { Empty, Screen } from '../../../components/ui';
import { getSettings, type AppSettings } from '../../../db/settings';
import {
  getLastStockIn,
  getProduct,
  listPacks,
  productShelfLife,
  updateMovementPrice,
  updateProduct,
  type StockMovement,
  type StockProduct,
} from '../../../db/stock';
import type { PackUnit } from '../../../lib/packs';
import { rescheduleReminders } from '../../../lib/notifications';

export default function EditStockScreen() {
  const db = useSQLiteContext();
  const { id } = useLocalSearchParams<{ id: string }>();
  const productId = Number(id);
  const [state, setState] = useState<{
    product: StockProduct | null;
    packs: PackUnit[];
    settings: AppSettings;
    lastIn: StockMovement | null;
  } | null>(null);

  useEffect(() => {
    Promise.all([getProduct(db, productId), listPacks(db, productId), getSettings(db), getLastStockIn(db, productId)])
      .then(([product, packs, settings, lastIn]) => setState({ product, packs, settings, lastIn }))
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
      lastStockIn={state.lastIn}
      submitLabel="保存修改"
      // 改过东西再返回先问「放弃修改？」
      confirmDiscard
      onSubmit={async (input, _firstBatch, lastStockInPrice) => {
        // 条码（含包装条码）和别的物品冲突时 updateProduct 会抛出给用户看的错误
        await updateProduct(db, product.id, input);
        // 改了「最近一次入库的价格」：改那条入库记录
        if (state.lastIn && lastStockInPrice !== undefined) await updateMovementPrice(db, state.lastIn.id, lastStockInPrice);
        rescheduleReminders(db).catch(() => undefined);
        router.back();
      }}
    />
  );
}
