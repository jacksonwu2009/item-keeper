import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { DeviceForm } from '../../../components/DeviceForm';
import { Empty, Screen } from '../../../components/ui';
import {
  findDeviceBySerial,
  getDevice,
  listAccessories,
  outQuantity,
  updateDevice,
  type Device,
} from '../../../db/devices';
import type { Accessory } from '../../../lib/warranty';

export default function EditDeviceScreen() {
  const db = useSQLiteContext();
  const { id } = useLocalSearchParams<{ id: string }>();
  const deviceId = Number(id);
  const [state, setState] = useState<{ device: Device | null; out: number; accessories: Accessory[] } | null>(null);

  useEffect(() => {
    Promise.all([getDevice(db, deviceId), outQuantity(db, deviceId), listAccessories(db, deviceId)])
      .then(([device, out, accessories]) => setState({ device, out, accessories }))
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
      initial={{ ...state.device, accessories: state.accessories }}
      minQuantity={state.out}
      submitLabel="保存修改"
      onSubmit={async (input) => {
        if (input.quantity < state.out) throw new Error(`目前借出 ${state.out} 件，数量不能比这个少`);
        const sameSerial = input.serialNo ? await findDeviceBySerial(db, input.serialNo) : null;
        if (sameSerial && sameSerial.id !== deviceId) {
          throw new Error(`序列号 ${input.serialNo} 已经登记过：「${sameSerial.name}」`);
        }
        await updateDevice(db, deviceId, input);
        router.back();
      }}
    />
  );
}
