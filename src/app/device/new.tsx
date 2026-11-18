import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';

import { DeviceForm } from '../../components/DeviceForm';
import { createDevice } from '../../db/devices';

export default function NewDeviceScreen() {
  const db = useSQLiteContext();
  return (
    <DeviceForm
      submitLabel="保存"
      onSubmit={async (input) => {
        const id = await createDevice(db, input);
        router.replace({ pathname: '/device/[id]', params: { id: String(id) } });
      }}
    />
  );
}
