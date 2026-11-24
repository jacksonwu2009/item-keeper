/**
 * 颜色模式：存着的值怎么读、跟随系统 / 浅色 / 深色怎么算出最后用哪套、存取出错怎么办；两套颜色名字要一样、对比度要够。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLOR_MODE_LABELS,
  COLOR_MODE_STORAGE_KEY,
  COLOR_MODES,
  contrastRatio,
  DEFAULT_COLOR_MODE,
  isColorMode,
  loadColorMode,
  parseColorMode,
  parseSystemScheme,
  resolveColorScheme,
  saveColorMode,
  withAlpha,
  type ColorModeStorage,
} from '../src/lib/colorMode';
import { colorsFor, darkColors, fadeFrom, lightColors, type Colors } from '../src/theme';

function memoryStorage(initial: Record<string, string> = {}): ColorModeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const brokenStorage: ColorModeStorage = {
  getItem: () => {
    throw new Error('读不了');
  },
  setItem: () => {
    throw new Error('写不了');
  },
};

describe('颜色模式：算出用哪套颜色', () => {
  it('默认跟随系统', () => {
    assert.equal(DEFAULT_COLOR_MODE, 'system');
  });

  it('跟随系统：系统是什么就是什么', () => {
    assert.equal(resolveColorScheme('system', 'light'), 'light');
    assert.equal(resolveColorScheme('system', 'dark'), 'dark');
  });

  it('选了浅色、深色就不看系统', () => {
    assert.equal(resolveColorScheme('light', 'dark'), 'light');
    assert.equal(resolveColorScheme('light', 'light'), 'light');
    assert.equal(resolveColorScheme('dark', 'light'), 'dark');
    assert.equal(resolveColorScheme('dark', 'dark'), 'dark');
  });

  it('系统报的值只认 dark，读不到、没指定都当浅色', () => {
    assert.equal(parseSystemScheme('dark'), 'dark');
    assert.equal(parseSystemScheme('light'), 'light');
    assert.equal(parseSystemScheme(null), 'light');
    assert.equal(parseSystemScheme(undefined), 'light');
    assert.equal(parseSystemScheme('unspecified'), 'light');
  });

  it('设置面板三项：跟随系统、浅色、深色，各有名字', () => {
    assert.deepEqual([...COLOR_MODES], ['system', 'light', 'dark']);
    assert.deepEqual(COLOR_MODES.map((mode) => COLOR_MODE_LABELS[mode]), ['跟随系统', '浅色', '深色']);
  });
});

describe('颜色模式：存取', () => {
  it('没存过按跟随系统', () => {
    assert.equal(loadColorMode(memoryStorage()), 'system');
  });

  it('存了再读是同一个', () => {
    for (const mode of COLOR_MODES) {
      const storage = memoryStorage();
      assert.equal(saveColorMode(storage, mode), true);
      assert.equal(storage.data[COLOR_MODE_STORAGE_KEY], mode);
      assert.equal(loadColorMode(storage), mode);
    }
  });

  it('后存的盖掉先存的', () => {
    const storage = memoryStorage();
    saveColorMode(storage, 'dark');
    saveColorMode(storage, 'light');
    assert.equal(loadColorMode(storage), 'light');
  });

  it('存坏了的值按跟随系统', () => {
    assert.equal(parseColorMode('Dark'), 'system');
    assert.equal(parseColorMode(''), 'system');
    assert.equal(parseColorMode(null), 'system');
    assert.equal(loadColorMode(memoryStorage({ [COLOR_MODE_STORAGE_KEY]: 'auto' })), 'system');
    assert.equal(isColorMode('dark'), true);
    assert.equal(isColorMode('auto'), false);
    assert.equal(isColorMode(1), false);
  });

  it('存储出错：读按跟随系统，写返回 false，都不往外抛', () => {
    assert.equal(loadColorMode(brokenStorage), 'system');
    assert.equal(saveColorMode(brokenStorage, 'dark'), false);
  });
});

describe('两套颜色', () => {
  it('按深浅色取到对应的一套', () => {
    assert.equal(colorsFor('light'), lightColors);
    assert.equal(colorsFor('dark'), darkColors);
  });

  it('两套的名字完全一样', () => {
    assert.deepEqual(Object.keys(darkColors).sort(), Object.keys(lightColors).sort());
  });

  it('深色的 18 个基本色和鸿蒙版 dark/element/color.json 一样', () => {
    const harmonyDark: Partial<Colors> = {
      bg: '#101512',
      surface: '#1A201D',
      surfaceSunken: '#232A26',
      ink: '#E6ECE8',
      muted: '#A3B0A8',
      faint: '#75817A',
      line: '#2E3732',
      accent: '#5CC2AE',
      accentInk: '#08201B',
      accentSoft: '#173A33',
      danger: '#F2B8B5',
      dangerSoft: '#4A1C19',
      warn: '#F0C068',
      warnSoft: '#3D2E10',
      ok: '#8FD3A8',
      okSoft: '#173523',
      info: '#A8C7F0',
      infoSoft: '#1A2A40',
    };
    for (const [name, value] of Object.entries(harmonyDark)) assert.equal(darkColors[name as keyof Colors], value, name);
  });

  it('对比度算法：黑白 21，同色 1', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21);
    assert.equal(contrastRatio('#FFFFFF', '#000000'), contrastRatio('#000000', '#FFFFFF'));
    assert.equal(contrastRatio('#5CC2AE', '#5CC2AE'), 1);
  });

  it('深色下正文、次要文字、状态标签、按钮文字的对比度不低于 4.5', () => {
    const c = darkColors;
    const pairs: [string, string, string][] = [
      ['正文 / 页面底', c.ink, c.bg],
      ['正文 / 卡片', c.ink, c.surface],
      ['正文 / 输入框', c.ink, c.surfaceSunken],
      ['次要文字 / 页面底', c.muted, c.bg],
      ['次要文字 / 卡片', c.muted, c.surface],
      ['次要文字 / 输入框', c.muted, c.surfaceSunken],
      ['主色文字 / 卡片', c.accent, c.surface],
      ['主按钮文字', c.accentInk, c.accent],
      ['次按钮文字', c.accent, c.accentSoft],
      ['危险按钮、过期标签', c.danger, c.dangerSoft],
      ['快到期标签', c.warn, c.warnSoft],
      ['正常标签', c.ok, c.okSoft],
      ['识别格子、按上次标记', c.info, c.infoSoft],
      ['左滑删除', c.dangerFillInk, c.dangerFill],
      ['分段选中的字', c.ink, c.segmentSelected],
      ['分段没选中的字', c.muted, c.surfaceSunken],
      ['撤销条文字', c.toastInk, c.toast],
      ['撤销条按钮', c.toastAction, c.toast],
    ];
    for (const [name, foreground, background] of pairs) {
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= 4.5, `${name} 只有 ${ratio.toFixed(2)}`);
    }
  });

  it('浅色的撤销条、左滑删除对比度也够', () => {
    const c = lightColors;
    assert.ok(contrastRatio(c.toastInk, c.toast) >= 4.5);
    assert.ok(contrastRatio(c.toastAction, c.toast) >= 4.5);
    assert.ok(contrastRatio(c.dangerFillInk, c.dangerFill) >= 4.5);
  });

  it('半透明色从色板里的颜色算', () => {
    assert.equal(withAlpha('#1A201D', 0.5), 'rgba(26, 32, 29, 0.5)');
    assert.equal(fadeFrom('#FFFFFF', 'down'), 'linear-gradient(rgba(255, 255, 255, 1), rgba(255, 255, 255, 0))');
    assert.equal(fadeFrom('#FFFFFF', 'up'), 'linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 1))');
  });
});
