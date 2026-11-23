import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import {
  addPerson,
  countAssignmentsNamed,
  deletePerson,
  listPersons,
  PERSON_NAME_MAX,
  PERSON_NOTE_MAX,
  updatePerson,
  type Person,
} from '../db/people';
import { useFocusData } from '../hooks/useFocusData';
import { useTerms } from '../hooks/useScene';
import { colors, font } from '../theme';
import { Footnote, ListCard, ListRow } from './ListRows';
import { Button, Card, Field, SectionTitle, Sheet } from './ui';

/**
 * 人员名单（设置 → 通用 → 员工名单，家庭场景叫家庭成员）：上面加人，下面每人一行，点开改名、改备注、删除。
 * 改名时领用记录里同名的一起改；删除只从名单里删，领用记录不动。
 */
export function PeopleManager() {
  const db = useSQLiteContext();
  const terms = useTerms();
  const loader = useCallback(() => listPersons(db), [db]);
  const [people, reload] = useFocusData(loader, [] as Person[]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);

  async function add() {
    setError(null);
    try {
      await addPerson(db, name, note);
      setName('');
      setNote('');
      await reload();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : '添加失败，请重试');
    }
  }

  return (
    <>
      <Footnote>{terms.rosterHint}</Footnote>
      <Card>
        <Field
          label="姓名"
          required
          value={name}
          onChangeText={setName}
          placeholder={terms.personNamePlaceholder}
          maxLength={PERSON_NAME_MAX}
        />
        <Field label="备注" value={note} onChangeText={setNote} placeholder={terms.personNotePlaceholder} maxLength={PERSON_NOTE_MAX} />
        {error ? <Text style={peopleStyles.error}>{error}</Text> : null}
        <Button title="添加" icon="person-add-outline" disabled={!name.trim()} onPress={() => add()} />
      </Card>

      <SectionTitle title={`${terms.roster}（${people.length} 人）`} />
      {people.length ? (
        <ListCard>
          {people.map((person) => (
            <ListRow key={person.id} title={person.name} subtitle={person.note} chevron onPress={() => setEditing(person)} />
          ))}
        </ListCard>
      ) : (
        <Footnote>名单里还没有人。</Footnote>
      )}

      {editing ? (
        <PersonSheet
          person={editing}
          onClose={() => setEditing(null)}
          onSave={async (nextName, nextNote) => {
            await updatePerson(db, editing.id, nextName, nextNote);
            setEditing(null);
            await reload();
          }}
          onDelete={async () => {
            await deletePerson(db, editing.id);
            setEditing(null);
            await reload();
          }}
        />
      ) : null}
    </>
  );
}

function PersonSheet({
  person,
  onClose,
  onSave,
  onDelete,
}: {
  person: Person;
  onClose: () => void;
  onSave: (name: string, note: string | null) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const db = useSQLiteContext();
  const terms = useTerms();
  const [name, setName] = useState(person.name);
  const [note, setNote] = useState(person.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await onSave(name, note);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请重试');
      setBusy(false);
    }
  }

  // 改了名字：领用记录里同名的也一起改，有的话先说一声（没有就不提，直接存）
  async function confirmSave() {
    const nextName = name.trim();
    if (nextName === person.name) return save();
    const records = await countAssignmentsNamed(db, person.name).catch(() => 0);
    if (!records) return save();
    Alert.alert(`把「${person.name}」改成「${nextName}」？`, `已有的 ${records} 条${terms.assignmentRecords}里的名字也一起改。`, [
      { text: '取消', style: 'cancel' },
      { text: '改名', onPress: () => save() },
    ]);
  }

  function confirmDelete() {
    Alert.alert(`从${terms.roster}里删除「${person.name}」？`, `只从名单里删，已有的${terms.assignmentRecords}不动。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () =>
          onDelete().catch((deleteError) =>
            setError(deleteError instanceof Error ? deleteError.message : '删除失败，请重试'),
          ),
      },
    ]);
  }

  return (
    <Sheet visible title={person.name} onClose={onClose}>
      <Field label="姓名" required value={name} onChangeText={setName} maxLength={PERSON_NAME_MAX} />
      <Field label="备注" value={note} onChangeText={setNote} placeholder={terms.personNotePlaceholder} maxLength={PERSON_NOTE_MAX} />
      {error ? <Text style={peopleStyles.error}>{error}</Text> : null}
      <View style={peopleStyles.actions}>
        <Button title="删除" variant="danger" disabled={busy} onPress={confirmDelete} style={peopleStyles.flex} />
        <Button title="保存" loading={busy} disabled={!name.trim()} onPress={() => confirmSave()} style={peopleStyles.flex} />
      </View>
    </Sheet>
  );
}

const peopleStyles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  error: { fontSize: font.small, color: colors.danger },
});
