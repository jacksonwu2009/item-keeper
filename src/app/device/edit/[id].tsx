import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { DeviceForm } from '../../../components/DeviceForm';
import { Empty, Screen } from '../../../components/ui';
import { getDevice, outQuantity, updateDevice, type Device } from '../../../db/devices';

export default function EditDeviceScreen() {
  const db = useSQLiteContext();
  const { id } = useLocalSearchParams<{ id: string }>();
  const deviceId = Number(id);
  const [state, setState] = useState<{ device: Device | null; out: number } | null>(null);

  useEffect(() => {
    Promise.all([getDevice(db, deviceId), outQuantity(db, deviceId)])
      .then(([device, out]) => setState({ device, out }))
      .catch(() => undefined);
  }, [db, deviceId]);

  if (!state) return null;
  if (!state.device) {
    return (
      <Screen>
        <Empty icon="help-circle-outline" title="找不到这台设备" text="可能已经被删除了。" />
      </Screen>
    );
  }

  return (
    <DeviceForm
      initial={state.device}
      minQuantity={state.out}
      submitLabel="保存修改"
      onSubmit={async (input) => {
        if (input.quantity < state.out) throw new Error(`目前借出 ${state.out} 件，数量不能比这个少`);
        await updateDevice(db, deviceId, input);
        router.back();
      }}
    />
  );
}
