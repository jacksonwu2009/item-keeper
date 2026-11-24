import { router, Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../../components/Text';

import { CardList, CardListRow, RowChip, useCardListStyles } from '../../components/CardList';
import { Button, Card, ChoiceChips, Empty, Label, MultiChips, Screen, SectionTitle, Sheet } from '../../components/ui';
import { ALL_OFFICES } from '../../db/offices';
import { getOpenStocktake, listStocktakes, startStocktake, type StocktakeListEntry } from '../../db/stocktake';
import { useFocusData } from '../../hooks/useFocusData';
import { useOffice } from '../../hooks/useOffice';
import { useScene, useTerms } from '../../hooks/useScene';
import { formatDate, toDateStr } from '../../lib/dates';
import {
  describeKinds,
  STOCKTAKE_KIND_LABEL,
  STOCKTAKE_KINDS,
  STOCKTAKE_STATUS_LABEL,
  type StocktakeKind,
} from '../../lib/stocktake';
import { makeStyles } from '../../hooks/useTheme';
import { font } from '../../theme';

function openStocktake(id: number) {
  router.push({ pathname: '/stocktake/[id]', params: { id: String(id) } });
}

/** 时间是 ISO（UTC），按手机本地日期显示 */
function localDay(iso: string): string {
  return formatDate(toDateStr(new Date(iso)));
}

/** 盘点列表：进行中的在最上面，下面是历史。 */
export default function StocktakeListScreen() {
  const listStyles = useListStyles();
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
            <CardList>
              {openEntries.map((entry, index) => (
                <EntryRow key={entry.id} entry={entry} first={index === 0} showOffice={showOffice} />
              ))}
            </CardList>
          </>
        ) : null}

        <SectionTitle title="历史" />
        {loaded && history.length === 0 ? (
          <Empty icon="time-outline" title="还没有盘点记录" text="完成或放弃的盘点会列在这里。" />
        ) : (
          <CardList>
            {history.map((entry, index) => (
              <EntryRow key={entry.id} entry={entry} first={index === 0} showOffice={showOffice} />
            ))}
          </CardList>
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
  const listStyles = useListStyles();
  const cardListStyles = useCardListStyles();
  const terms = useTerms();
  const { summary } = entry;
  const subtitle = [
    showOffice ? (entry.officeName ?? `已删除的${terms.place}`) : null,
    describeKinds(entry.kinds),
    entry.status === 'open' ? `已盘 ${summary.counted} / ${summary.total}` : `共 ${summary.total} 项`,
  ]
    .filter(Boolean)
    .join(' · ');
  // 照鸿蒙版 StocktakeListPage：左边日期和说明，右边状态标签上下排，再一个箭头
  return (
    <CardListRow first={first} onPress={() => openStocktake(entry.id)} chevron>
      <View style={cardListStyles.main}>
        <Text style={listStyles.rowTitle}>{localDay(entry.startedAt)} 开始</Text>
        <Text style={listStyles.rowSub}>{subtitle}</Text>
      </View>
      <View style={listStyles.chips}>
        {entry.status === 'open' ? <RowChip text="继续" tone="accent" /> : null}
        {entry.status === 'cancelled' ? <RowChip text={STOCKTAKE_STATUS_LABEL.cancelled} tone="neutral" /> : null}
        {entry.status === 'done' && summary.surplus > 0 ? <RowChip text={`盘盈 ${summary.surplus}`} tone="ok" /> : null}
        {entry.status === 'done' && summary.deficit > 0 ? <RowChip text={`盘亏 ${summary.deficit}`} tone="danger" /> : null}
        {entry.status === 'done' && summary.surplus === 0 && summary.deficit === 0 ? (
          <RowChip text="全部相符" tone="ok" />
        ) : null}
      </View>
    </CardListRow>
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
  const listStyles = useListStyles();
  const office = useOffice();
  const { scene, terms } = useScene();
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
        setError(`这个${terms.place}有一次盘点还没完成，可以接着盘，或者先在那边放弃。`);
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
          <Label>{terms.place}</Label>
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
        <Text style={listStyles.hint}>
          {scene === 'home' ? '设备盘的是一共有几件（谁在用的也算）。' : '设备盘的是在库数量（总数减去借出的）。'}
        </Text>
      </View>
      {error ? <Text style={listStyles.error}>{error}</Text> : null}
      {openId !== null ? (
        <Button title="接着盘那一次" variant="secondary" onPress={() => onContinue(openId)} />
      ) : null}
      <Button title="开始" loading={busy} disabled={kinds.length === 0} onPress={() => submit()} />
    </Sheet>
  );
}

const useListStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  intro: { gap: 12 },
  introText: { fontSize: font.small, color: colors.muted, lineHeight: 20 },
  rowTitle: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  rowSub: { fontSize: font.small, color: colors.muted },
  chips: { gap: 4, alignItems: 'flex-end', maxWidth: '45%' },
  group: { gap: 8 },
  hint: { fontSize: font.small, color: colors.faint },
  error: { fontSize: font.small, color: colors.danger },
}));
