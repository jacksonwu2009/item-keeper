import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { DeviceForm } from '../../components/DeviceForm';
import {
  createDevice,
  findDeviceBySerial,
  getDevice,
  listAccessories,
  listDeviceTemplates,
  type DeviceInput,
} from '../../db/devices';
import { useScene } from '../../hooks/useScene';
import { mergePresets, type DevicePreset } from '../../lib/devicePresets';
import { rescheduleReminders } from '../../lib/notifications';

/**
 * 新增设备。从扫码进来时带着 serial（序列号）；
 * 「保存并扫下一台」时带着 template（上一台的 id），这一台沿用它的名称、配置、配件、购买日期、发票号和保修。
 */
export default function NewDeviceScreen() {
  const db = useSQLiteContext();
  // 内置的快速选择是办公电脑（以 Mac 为主），家庭场景只列自己登记过的
  const home = useScene().scene === 'home';
  const params = useLocalSearchParams<{ serial?: string; template?: string }>();
  const serial = typeof params.serial === 'string' ? params.serial : '';
  const templateId = typeof params.template === 'string' ? Number(params.template) : null;
  const [state, setState] = useState<{ initial: Partial<DeviceInput>; presets: DevicePreset[] } | null>(null);

  useEffect(() => {
    async function load() {
      const [templates, template, templateAccessories] = await Promise.all([
        listDeviceTemplates(db),
        templateId ? getDevice(db, templateId) : Promise.resolve(null),
        templateId ? listAccessories(db, templateId) : Promise.resolve([]),
      ]);
      const initial: Partial<DeviceInput> = template
        ? {
            officeId: template.officeId,
            category: template.category,
            name: template.name,
            model: template.model,
            chip: template.chip,
            memory: template.memory,
            storage: template.storage,
            purchaseDate: template.purchaseDate,
            warrantyUntil: template.warrantyUntil,
            invoiceNo: template.invoiceNo,
            accessories: templateAccessories,
            serialNo: serial,
          }
        : { serialNo: serial };
      return { initial, presets: template ? [] : mergePresets(templates, home ? [] : undefined) };
    }
    load()
      .then(setState)
      .catch(() => setState({ initial: { serialNo: serial }, presets: [] }));
  }, [db, serial, templateId, home]);

  if (!state) return null;

  /** 序列号重复时不让保存，告诉用户已经登记在哪 */
  async function save(input: DeviceInput): Promise<number> {
    const existing = input.serialNo ? await findDeviceBySerial(db, input.serialNo) : null;
    if (existing) throw new Error(`序列号 ${input.serialNo} 已经登记过：「${existing.name}」`);
    const id = await createDevice(db, input);
    // 家庭场景有保修提醒，新设备要排进去
    rescheduleReminders(db).catch(() => undefined);
    return id;
  }

  return (
    <DeviceForm
      initial={state.initial}
      presets={state.presets}
      submitLabel="保存"
      onSubmit={async (input) => {
        const id = await save(input);
        router.replace({ pathname: '/device/[id]', params: { id: String(id) } });
      }}
      onSubmitAndNext={async (input) => {
        const id = await save(input);
        router.replace({ pathname: '/scan', params: { mode: 'device', template: String(id) } });
      }}
    />
  );
}
