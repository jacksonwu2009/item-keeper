import { setColorMode, useColorMode } from '../hooks/useTheme';
import { COLOR_MODE_LABELS, type ColorMode } from '../lib/colorMode';
import { OptionCards, type OptionCard } from './OptionCards';

const OPTIONS: OptionCard<ColorMode>[] = [
  { value: 'system', title: COLOR_MODE_LABELS.system, description: '系统是浅色就用浅色，是深色就用深色', icon: 'phone-portrait-outline' },
  { value: 'light', title: COLOR_MODE_LABELS.light, description: '一直用浅色', icon: 'sunny-outline' },
  { value: 'dark', title: COLOR_MODE_LABELS.dark, description: '一直用深色', icon: 'moon-outline' },
];

/** 设置里「颜色模式」面板的三个选项：点了马上生效并存到本机。没存上时告诉外面（这次照样生效） */
export function ColorModeOptions({ onSaveFailed }: { onSaveFailed?: () => void }) {
  const mode = useColorMode();
  return (
    <OptionCards
      options={OPTIONS}
      value={mode}
      onChoose={(next) => {
        if (!setColorMode(next)) onSaveFailed?.();
      }}
    />
  );
}
