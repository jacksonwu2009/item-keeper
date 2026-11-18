import { router, Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Button,
  Card,
  Chip,
  ChoiceChips,
  Empty,
  Label,
  LIST_PRESS_DELAY,
  MultiChips,
  Screen,
  SectionTitle,
  Sheet,
} from '../../components/ui';
import { ALL_OFFICES } from '../../db/offices';
import { getOpenStocktake, listStocktakes, startStocktake, type StocktakeListEntry } from '../../db/stocktake';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { formatDate, toDateStr } from '../../lib/dates';
import {
  describeKinds,
  STOCKTAKE_KIND_LABEL,
  STOCKTAKE_KINDS,
  STOCKTAKE_STATUS_LABEL,
  type StocktakeKind,
} from '../../lib/stocktake';
import { colors, font } from '../../theme';

function openStocktake(id: number) {
  router.push({ pathname: '/stocktake/[id]', params: { id: String(id) } });
}

/** 时间是 ISO（UTC），按手机本地日期显示 */
function localDay(iso: string): string {
  return formatDate(toDateStr(new Date(iso)));
}

/** 盘点列表：进行中的在最上面，下面是历史。 */
export default function StocktakeListScreen() {
  const db = useSQLiteContext();
  const office = useOffice();
  const officeFilter = office.filterId;
  const [starting, setStarting] = useState(false);

  const loader = useCallback(() => listStocktakes(db, officeFilter), [db, officeFilter]);
  const [entries, , loaded] = useFocusData(loader, [] as StocktakeListEntry[]);
  const openEntries = entries.filter((entry) => entry.status === 'open');
  const history = entries.filter((entry) => entry.status !== 'open');
  const showOffice = office.multiple && officeFilter === null;

  return (
    <View style={listStyles.screen}>
      <Stack.Screen options={{ title: '盘点' }} />
      <Screen>
        <Card style={listStyles.intro}>
          <Text style={listStyles.introText}>
            对着实物一样样数，把数到的数量填进去。完成时，有差异的物品按实盘数调整库存（每项记一条出入库记录）；设备只记下差异，不自动改数量。
          </Text>
          <Button title="开始盘点" icon="clipboard-outline" onPress={() => setStarting(true)} />
        </Card>

        {openEntries.length > 0 ? (
          <>
            <SectionTitle title="进行中" />
            <Card style={listStyles.listCard}>
              {openEntries.map((entry, index) => (
                <EntryRow key={entry.id} entry={entry} first={index === 0} showOffice={showOffice} />
              ))}
            </Card>
          </>
        ) : null}

        <SectionTitle title="历史" />
        {loaded && history.length === 0 ? (
          <Empty icon="time-outline" title="还没有盘点记录" text="完成或放弃的盘点会列在这里。" />
        ) : (
          <Card style={listStyles.listCard}>
            {history.map((entry, index) => (
              <EntryRow key={entry.id} entry={entry} first={index === 0} showOffice={showOffice} />
            ))}
          </Card>
        )}
      </Screen>

      {starting ? (
        <StartSheet
          defaultOfficeId={office.currentId === ALL_OFFICES ? office.defaultId : office.currentId}
          onClose={() => setStarting(false)}
          onStarted={(id) => {
            setStarting(false);
            openStocktake(id);
          }}
          onContinue={(id) => {
            setStarting(false);
            openStocktake(id);
          }}
          start={(officeId, kinds) => startStocktake(db, officeId, kinds)}
          findOpen={(officeId) => getOpenStocktake(db, officeId).then((found) => found?.id ?? null)}
        />
      ) : null}
    </View>
  );
}

function EntryRow({ entry, first, showOffice }: { entry: StocktakeListEntry; first: boolean; showOffice: boolean }) {
  const { summary } = entry;
  const subtitle = [
    showOffice ? (entry.officeName ?? '已删除的办公点') : null,
    describeKinds(entry.kinds),
    entry.status === 'open' ? `已盘 ${summary.counted} / ${summary.total}` : `共 ${summary.total} 项`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openStocktake(entry.id)}
      unstable_pressDelay={LIST_PRESS_DELAY}
      style={({ pressed }) => [listStyles.row, !first && listStyles.rowDivider, pressed && { opacity: 0.6 }]}
    >
      <View style={listStyles.rowMain}>
        <Text style={listStyles.rowTitle}>{localDay(entry.startedAt)} 开始</Text>
        <Text style={listStyles.rowSub}>{subtitle}</Text>
      </View>
      <View style={listStyles.chips}>
        {entry.status === 'open' ? <Chip text="继续" tone="accent" /> : null}
        {entry.status === 'cancelled' ? <Chip text={STOCKTAKE_STATUS_LABEL.cancelled} tone="neutral" /> : null}
        {entry.status === 'done' && summary.surplus > 0 ? <Chip text={`盘盈 ${summary.surplus}`} tone="ok" /> : null}
        {entry.status === 'done' && summary.deficit > 0 ? <Chip text={`盘亏 ${summary.deficit}`} tone="danger" /> : null}
        {entry.status === 'done' && summary.surplus === 0 && summary.deficit === 0 ? (
          <Chip text="全部相符" tone="ok" />
        ) : null}
      </View>
    </Pressable>
  );
}

function StartSheet({
  defaultOfficeId,
  onClose,
  onStarted,
  onContinue,
  start,
  findOpen,
}: {
  defaultOfficeId: number;
  onClose: () => void;
  onStarted: (id: number) => void;
  onContinue: (id: number) => void;
  start: (officeId: number, kinds: StocktakeKind[]) => Promise<number>;
  findOpen: (officeId: number) => Promise<number | null>;
}) {
  const office = useOffice();
  const [officeId, setOfficeId] = useState(defaultOfficeId);
  const [kinds, setKinds] = useState<StocktakeKind[]>(['food', 'daily']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  async function submit() {
    setError(null);
    setOpenId(null);
    setBusy(true);
    try {
      const existing = await findOpen(officeId);
      if (existing !== null) {
        setOpenId(existing);
        setError('这个办公点有一次盘点还没完成，可以接着盘，或者先在那边放弃。');
        return;
      }
      onStarted(await start(officeId, kinds));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '开始盘点失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible title="开始盘点" onClose={onClose}>
      {office.multiple ? (
        <View style={listStyles.group}>
          <Label>办公点</Label>
          <ChoiceChips
            options={office.offices.map((item) => ({ value: item.id, label: item.name }))}
            value={officeId}
            onChange={(next) => {
              setOfficeId(next);
              setError(null);
              setOpenId(null);
            }}
          />
        </View>
      ) : null}
      <View style={listStyles.group}>
        <Label>盘哪些</Label>
        <MultiChips
          options={STOCKTAKE_KINDS.map((kind) => ({ value: kind, label: STOCKTAKE_KIND_LABEL[kind] }))}
          values={kinds}
          onChange={setKinds}
        />
        <Text style={listStyles.hint}>设备盘的是在库数量（总数减去借出的）。</Text>
      </View>
      {error ? <Text style={listStyles.error}>{error}</Text> : null}
      {openId !== null ? (
        <Button title="接着盘那一次" variant="secondary" onPress={() => onContinue(openId)} />
      ) : null}
      <Button title="开始" loading={busy} disabled={kinds.length === 0} onPress={() => submit()} />
    </Sheet>
  );
}

const listStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  intro: { gap: 12 },
  introText: { fontSize: font.small, color: colors.muted, lineHeight: 20 },
  listCard: { paddingVertical: 4, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: font.body, fontWeight: '600', color: colors.ink },
  rowSub: { fontSize: font.small, color: colors.muted },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '45%' },
  group: { gap: 8 },
  hint: { fontSize: font.small, color: colors.faint },
  error: { fontSize: font.small, color: colors.danger },
});
