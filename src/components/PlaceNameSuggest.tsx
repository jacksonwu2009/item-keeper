import { useState } from 'react';
import { View } from 'react-native';
import { Text } from './Text';

import { locatePlace, LocateError } from '../lib/locate';
import { suggestOfficeNames } from '../lib/placeName';
import { makeStyles } from '../hooks/useTheme';
import { font } from '../theme';
import { Button, ChoiceChips } from './ui';

type State = { status: 'idle' } | { status: 'locating' } | { status: 'done'; names: string[] } | { status: 'error'; message: string };

/** 「用当前位置起名」：定位后给几个候选名字，点一下填进输入框。 */
export function PlaceNameSuggest({
  existingNames,
  onPick,
}: {
  existingNames: readonly string[];
  onPick: (name: string) => void;
}) {
  const suggestStyles = useSuggestStyles();
  const [state, setState] = useState<State>({ status: 'idle' });

  async function locate() {
    setState({ status: 'locating' });
    try {
      const names = suggestOfficeNames(await locatePlace(), existingNames);
      setState(names.length ? { status: 'done', names } : { status: 'error', message: '这个位置想不出合适的名字，请手动填' });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof LocateError ? error.message : '定位失败了，请手动填名称',
      });
    }
  }

  return (
    <View style={suggestStyles.wrap}>
      <View style={suggestStyles.row}>
        <Button
          title={state.status === 'done' ? '重新定位' : '用当前位置起名'}
          icon="locate-outline"
          compact
          variant="secondary"
          loading={state.status === 'locating'}
          onPress={() => locate()}
        />
      </View>
      {state.status === 'locating' ? <Text style={suggestStyles.hint}>正在定位…</Text> : null}
      {state.status === 'done' ? (
        <>
          <Text style={suggestStyles.hint}>点一个填进去，填好还可以再改：</Text>
          <ChoiceChips options={state.names.map((name) => ({ value: name, label: name }))} value={null} onChange={onPick} />
        </>
      ) : null}
      {state.status === 'error' ? <Text style={suggestStyles.error}>{state.message}</Text> : null}
      {state.status === 'idle' ? (
        <Text style={suggestStyles.hint}>只在点按钮时定位一次。手机查不到地名时，会把坐标发给 OpenStreetMap 查。</Text>
      ) : null}
    </View>
  );
}

const useSuggestStyles = makeStyles((colors) => ({
  wrap: { gap: 8 },
  row: { flexDirection: 'row' },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  error: { fontSize: font.small, color: colors.warn, lineHeight: 18 },
}));
