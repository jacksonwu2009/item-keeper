import { useState } from 'react';
import { Modal, View } from 'react-native';
import { Text } from './Text';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SCENE_DESCRIPTIONS, type Scene } from '../lib/terms';
import { makeStyles } from '../hooks/useTheme';
import { CONTENT_MAX_WIDTH, font } from '../theme';
import { OptionCards, type OptionCard } from './OptionCards';

const OPTIONS: OptionCard<Scene>[] = [
  { value: 'home', title: '家里用', description: SCENE_DESCRIPTIONS.home, icon: 'home-outline' },
  { value: 'office', title: '公司 / 办公室用', description: SCENE_DESCRIPTIONS.office, icon: 'business-outline' },
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
  return <OptionCards options={OPTIONS} value={value} disabled={disabled} onChoose={onChoose} />;
}

/** 新装的手机第一次打开：盖在最上面，选了才打开那个场景的库（选错了可以在设置里切换，两个场景的数据分开记） */
export function SceneChooser({ visible, onChoose }: { visible: boolean; onChoose: (scene: Scene) => Promise<void> }) {
  const chooserStyles = useChooserStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={() => undefined}>
      <SafeAreaView style={chooserStyles.screen}>
        <View style={chooserStyles.body}>
          <Text style={chooserStyles.title}>物品管家用在哪？</Text>
          <Text style={chooserStyles.subtitle}>家庭和办公分开记，以后可以在设置里切换。</Text>
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

const useChooserStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, justifyContent: 'center', padding: 20, gap: 16, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
  title: { fontSize: 26, fontWeight: '700', color: colors.ink },
  subtitle: { fontSize: font.body, color: colors.muted, marginTop: -8 },
  error: { fontSize: font.small, color: colors.danger },
  footnote: { fontSize: font.small, color: colors.faint, textAlign: 'center' },
}));
