import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BUILTIN_DEVICE_PRESETS,
  composeChip,
  describeConfig,
  hasComputerConfig,
  isMacName,
  mergePresets,
  normalizeCapacity,
  parseChip,
  parseDeviceCode,
  presetLabel,
  presetMatchesForm,
  splitLegacyModel,
} from '../src/lib/devicePresets';

describe('设备快速选择', () => {
  it('自己登记过的排前面，内置里同名的不再列出（名称不管空格大小写）', () => {
    const recent = [
      { category: '笔记本', name: 'MacBook Pro 14英寸', chip: 'M3 Pro', memory: '18G', storage: '512G', accessories: [] },
    ];
    const merged = mergePresets(recent);
    assert.equal(merged[0].chip, 'M3 Pro');
    assert.equal(merged.filter((preset) => preset.name.replace(/\s/g, '') === 'MacBookPro14英寸').length, 1);
    assert.equal(merged.length, BUILTIN_DEVICE_PRESETS.length);
    assert.equal(presetLabel(merged[0]), 'MacBook Pro 14英寸 · M3 Pro 18G/512G');
    assert.equal(presetLabel(BUILTIN_DEVICE_PRESETS[0]), 'MacBook Air 13 英寸');
  });

  it('名称带 Mac 才显示芯片点选；笔记本、台式机才有配置', () => {
    assert.equal(isMacName('MacBook Pro 14 英寸'), true);
    assert.equal(isMacName('iMac 24 英寸'), true);
    assert.equal(isMacName('Mac mini'), true);
    assert.equal(isMacName('ThinkPad X1'), false);
    assert.equal(hasComputerConfig('笔记本'), true);
    assert.equal(hasComputerConfig('显示器'), false);
  });
});

describe('电脑配置', () => {
  it('芯片：代数 + 档次', () => {
    assert.equal(composeChip('M3', 'Pro'), 'M3 Pro');
    assert.equal(composeChip('M2', ''), 'M2');
    assert.equal(composeChip(null, 'Pro'), '');
    assert.deepEqual(parseChip('m4 max'), { generation: 'M4', tier: 'Max' });
    assert.deepEqual(parseChip('M1'), { generation: 'M1', tier: '' });
    assert.deepEqual(parseChip('i7-1260P'), { generation: null, tier: '' });
  });

  it('容量统一写法', () => {
    assert.equal(normalizeCapacity('16gb'), '16G');
    assert.equal(normalizeCapacity(' 1 TB '), '1T');
    assert.equal(normalizeCapacity('512'), '512G');
    assert.equal(normalizeCapacity(''), null);
    assert.equal(normalizeCapacity('16G 统一内存'), '16G 统一内存');
    assert.equal(describeConfig({ chip: 'M3 Pro', memory: '18G', storage: '512G' }), 'M3 Pro 18G/512G');
    assert.equal(describeConfig({ chip: null, memory: '16G', storage: null }), '16G');
  });

  it('旧数据：型号里的芯片、内存/硬盘拆出来，剩下的留在型号', () => {
    assert.deepEqual(splitLegacyModel('M3 Pro 18G/512G'), { chip: 'M3 Pro', memory: '18G', storage: '512G', model: null });
    assert.deepEqual(splitLegacyModel('m1 16gb / 1tb 深空灰'), { chip: 'M1', memory: '16G', storage: '1T', model: '深空灰' });
    assert.deepEqual(splitLegacyModel('MRX33CH/A M3 Max'), { chip: 'M3 Max', memory: null, storage: null, model: 'MRX33CH/A' });
    assert.equal(splitLegacyModel('U2723QE'), null);
    assert.equal(splitLegacyModel(null), null);
  });
});

describe('扫码认序列号', () => {
  it('苹果包装盒的序列号条码去掉前面的 S', () => {
    assert.deepEqual(parseDeviceCode('SC02XK1ABJGH5'), { kind: 'serial', serial: 'C02XK1ABJGH5' });
    assert.deepEqual(parseDeviceCode('sk7x9q2lm4p'), { kind: 'serial', serial: 'K7X9Q2LM4P' });
  });

  it('其他序列号原样保留（转大写）', () => {
    assert.deepEqual(parseDeviceCode(' cn0abc123 '), { kind: 'serial', serial: 'CN0ABC123' });
    assert.deepEqual(parseDeviceCode('SN12345'), { kind: 'serial', serial: 'SN12345' });
  });

  it('型号编号和商品条码不当序列号', () => {
    assert.equal(parseDeviceCode('1PMRX33CH/A').kind, 'notSerial');
    assert.equal(parseDeviceCode('194253082392', 'upc_a').kind, 'notSerial');
    assert.equal(parseDeviceCode('C02XK1ABJGH5', 'code128').kind, 'serial');
  });
});

describe('快速选择的选中状态', () => {
  const preset = { category: '笔记本', name: 'MacBook Pro 14 英寸', model: null, chip: 'M3 Pro', memory: '18G', storage: '512G', accessories: [{ name: '充电器', quantity: 1 }] };
  const form = { category: '笔记本', name: 'MacBook Pro 14 英寸', model: '', chip: 'M3 Pro', memory: '18G', storage: '512G' };

  it('表单和选项的类别、名称、型号、配置一致时算选中（空和 null 一样，空格、大小写不算差别）', () => {
    assert.equal(presetMatchesForm(preset, form), true);
    assert.equal(presetMatchesForm(preset, { ...form, name: 'macbook pro 14英寸' }), true);
  });

  it('改了名称、配置或类别就不算选中', () => {
    assert.equal(presetMatchesForm(preset, { ...form, name: 'MacBook Pro 16 英寸' }), false);
    assert.equal(presetMatchesForm(preset, { ...form, memory: '36G' }), false);
    assert.equal(presetMatchesForm(preset, { ...form, category: '台式机' }), false);
  });
});
