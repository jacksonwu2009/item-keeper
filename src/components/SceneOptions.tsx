import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SCENE_DESCRIPTIONS, type Scene } from '../lib/terms';
import { colors, CONTENT_MAX_WIDTH, font, radius } from '../theme';

const OPTIONS: { scene: Scene; title: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { scene: 'home', title: '家里用', icon: 'home-outline' },
  { scene: 'office', title: '公司 / 办公室用', icon: 'business-outline' },
];

/** 两个大选项：首次打开时的选择和设置里的「使用场景」面板共用 */
export function SceneOptions({
  value,
  disabled,
  onChoose,
}: {
  value: Scene | null;
  disabled?: boolean;
  onChoose: (scene: Scene) => void;
}) {
  return (
    <View style={optionStyles.list}>
      {OPTIONS.map((option) => {
        const selected = option.scene === value;
        return (
          <Pressable
            key={option.scene}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChoose(option.scene)}
            style={({ pressed }) => [optionStyles.option, selected && optionStyles.selected, pressed && optionStyles.pressed]}
          >
            <View style={[optionStyles.icon, selected && optionStyles.iconSelected]}>
              <Ionicons name={option.icon} size={22} color={selected ? colors.accentInk : colors.accent} />
            </View>
            <View style={optionStyles.text}>
              <Text style={optionStyles.title}>{option.title}</Text>
              <Text style={optionStyles.description}>{SCENE_DESCRIPTIONS[option.scene]}</Text>
            </View>
            {selected ? <Ionicons name="checkmark-circle" size={22} color={colors.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** 新装的手机第一次打开：盖在最上面，选了才能用（只是叫法，选错了可以在设置里改） */
export function SceneChooser({ visible, onChoose }: { visible: boolean; onChoose: (scene: Scene) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={() => undefined}>
      <SafeAreaView style={chooserStyles.screen}>
        <View style={chooserStyles.body}>
          <Text style={chooserStyles.title}>物品管家用在哪？</Text>
          <Text style={chooserStyles.subtitle}>只影响界面怎么显示，以后可以在设置里改，记的东西不会变。</Text>
          <SceneOptions
            value={null}
            disabled={busy}
            onChoose={(scene) => {
              setBusy(true);
              setError(null);
              onChoose(scene).catch(() => {
                setError('没存上，请再点一次。');
                setBusy(false);
              });
            }}
          />
          {error ? <Text style={chooserStyles.error}>{error}</Text> : null}
          <Text style={chooserStyles.footnote}>在「设置」→「使用场景」里改。</Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const optionStyles = StyleSheet.create({
  list: { gap: 12 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  selected: { backgroundColor: colors.accentSoft },
  pressed: { opacity: 0.7 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  iconSelected: { backgroundColor: colors.accent },
  text: { flex: 1, gap: 4 },
  title: { fontSize: font.heading, fontWeight: '600', color: colors.ink },
  description: { fontSize: font.small, color: colors.muted, lineHeight: 19 },
});

const chooserStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, justifyContent: 'center', padding: 20, gap: 16, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
  title: { fontSize: 26, fontWeight: '700', color: colors.ink },
  subtitle: { fontSize: font.body, color: colors.muted, marginTop: -8 },
  error: { fontSize: font.small, color: colors.danger },
  footnote: { fontSize: font.small, color: colors.faint, textAlign: 'center' },
});
