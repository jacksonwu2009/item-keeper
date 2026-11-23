import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import {
  addDepartment,
  addPerson,
  countAssignmentsNamed,
  deleteDepartment,
  deletePerson,
  DEPARTMENT_NAME_MAX,
  groupPeopleByDepartment,
  listDepartments,
  listPersons,
  PERSON_EMAIL_MAX,
  PERSON_NAME_MAX,
  PERSON_NOTE_MAX,
  personSubtitle,
  renameDepartment,
  updatePerson,
  type Department,
  type Person,
  type PersonDetails,
} from '../db/people';
import { useFocusData } from '../hooks/useFocusData';
import { useScene } from '../hooks/useScene';
import { colors, font, radius } from '../theme';
import { Footnote, ListCard, ListRow } from './ListRows';
import { Button, Card, ChoiceChips, Field, IconButton, Label, SectionTitle, Sheet } from './ui';

/** 部门那排选项最后一个「+ 新部门」的值（部门编号都是正数） */
const NEW_DEPARTMENT = -1;
const EMAIL_PLACEHOLDER = '邮箱（选填）';
const NEW_DEPARTMENT_PLACEHOLDER = '新部门名称';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * 人员名单（设置 → 通用 → 员工名单，家庭场景叫家庭成员）：上面加人，下面每人一行，点开改姓名、备注，删除。
 * 改名时领用记录里同名的一起改；删除只从名单里删，领用记录不动。
 * 办公场景还有部门和邮箱：加人、改人时先选部门（可以不选，「+ 新部门」当场建），再填姓名、邮箱、备注；
 * 列表按部门分组（没有部门的放最后「未分部门」），「管理部门」里新建、改名、删除部门。家庭场景不显示部门和邮箱。
 */
export function PeopleManager() {
  const db = useSQLiteContext();
  const { scene, terms } = useScene();
  const office = scene === 'office';
  const loader = useCallback(async () => {
    const [people, departments] = await Promise.all([listPersons(db), listDepartments(db)]);
    return { people, departments };
  }, [db]);
  const [{ people, departments }, reload] = useFocusData(loader, { people: [] as Person[], departments: [] as Department[] });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);
  const [managing, setManaging] = useState(false);
  // 选着的部门被删了（在「管理部门」里）就当没选
  const selectedDepartment = departments.some((department) => department.id === departmentId) ? departmentId : null;

  async function createDepartment(departmentName: string): Promise<number> {
    const id = await addDepartment(db, departmentName);
    await reload();
    return id;
  }

  async function add() {
    setError(null);
    try {
      await addPerson(db, name, note, office ? { departmentId: selectedDepartment, email } : {});
      // 部门留着：连着加同一个部门的人不用每次重选
      setName('');
      setEmail('');
      setNote('');
      await reload();
    } catch (addError) {
      setError(errorText(addError, '添加失败，请重试'));
    }
  }

  function personRow(person: Person) {
    return (
      <ListRow
        key={person.id}
        title={person.name}
        subtitle={personSubtitle(person, office)}
        chevron
        onPress={() => setEditing(person)}
      />
    );
  }

  return (
    <>
      <Footnote>{terms.rosterHint}</Footnote>
      <Card>
        {office ? (
          <View style={peopleStyles.field}>
            <Label>部门</Label>
            <DepartmentChips
              departments={departments}
              value={selectedDepartment}
              onChange={setDepartmentId}
              onCreate={createDepartment}
            />
          </View>
        ) : null}
        <Field
          label="姓名"
          required
          value={name}
          onChangeText={setName}
          placeholder={terms.personNamePlaceholder}
          maxLength={PERSON_NAME_MAX}
        />
        {office ? <EmailField value={email} onChangeText={setEmail} /> : null}
        <Field label="备注" value={note} onChangeText={setNote} placeholder={terms.personNotePlaceholder} maxLength={PERSON_NOTE_MAX} />
        {error ? <Text style={peopleStyles.error}>{error}</Text> : null}
        <Button title="添加" icon="person-add-outline" disabled={!name.trim()} onPress={() => add()} />
      </Card>

      {office ? (
        <ListCard>
          <ListRow
            title="管理部门"
            value={departments.length ? `${departments.length} 个` : '还没有'}
            chevron
            onPress={() => setManaging(true)}
          />
        </ListCard>
      ) : null}

      <SectionTitle title={`${terms.roster}（${people.length} 人）`} />
      {!people.length ? (
        <Footnote>名单里还没有人。</Footnote>
      ) : office ? (
        groupPeopleByDepartment(people, departments).map((group) => (
          <View key={group.departmentId ?? 'none'} style={peopleStyles.group}>
            <Text style={peopleStyles.groupTitle}>
              {group.title}（{group.people.length} 人）
            </Text>
            <ListCard>{group.people.map(personRow)}</ListCard>
          </View>
        ))
      ) : (
        <ListCard>{people.map(personRow)}</ListCard>
      )}

      {editing ? (
        <PersonSheet
          person={editing}
          office={office}
          departments={departments}
          onCreateDepartment={createDepartment}
          onClose={() => setEditing(null)}
          onSave={async (nextName, nextNote, details) => {
            await updatePerson(db, editing.id, nextName, nextNote, details);
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

      {managing ? <DepartmentsSheet departments={departments} onClose={() => setManaging(false)} onChanged={reload} /> : null}
    </>
  );
}

function EmailField({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) {
  return (
    <Field
      label="邮箱"
      value={value}
      onChangeText={onChangeText}
      placeholder={EMAIL_PLACEHOLDER}
      maxLength={PERSON_EMAIL_MAX}
      keyboardType="email-address"
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="email"
    />
  );
}

/**
 * 部门那一排：已有的部门一个个列出来点选（再点一下选中的就是不选），最后一个「+ 新部门」，
 * 点了在下面弹出输入框，建好自动选上。
 */
function DepartmentChips({
  departments,
  value,
  onChange,
  onCreate,
}: {
  departments: readonly Department[];
  value: number | null;
  onChange: (departmentId: number | null) => void;
  /** 建部门，返回编号（重名、太长时抛错） */
  onCreate: (name: string) => Promise<number>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      onChange(await onCreate(draft));
      setDraft('');
      setAdding(false);
    } catch (createError) {
      setError(errorText(createError, '添加失败，请重试'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ChoiceChips
        options={[
          ...departments.map((department) => ({ value: department.id, label: department.name })),
          { value: NEW_DEPARTMENT, label: '+ 新部门' },
        ]}
        value={value}
        onChange={(next) => {
          if (next === NEW_DEPARTMENT) {
            setAdding(!adding);
            setError(null);
            return;
          }
          onChange(next === value ? null : next);
        }}
      />
      {adding ? (
        <Field
          value={draft}
          onChangeText={setDraft}
          placeholder={NEW_DEPARTMENT_PLACEHOLDER}
          maxLength={DEPARTMENT_NAME_MAX}
          autoFocus
          error={error}
          onSubmitEditing={() => (draft.trim() ? create() : undefined)}
          right={<Button title="添加" compact loading={busy} disabled={!draft.trim()} onPress={() => create()} />}
        />
      ) : null}
    </>
  );
}

function PersonSheet({
  person,
  office,
  departments,
  onCreateDepartment,
  onClose,
  onSave,
  onDelete,
}: {
  person: Person;
  /** 办公场景：多出部门、邮箱 */
  office: boolean;
  departments: readonly Department[];
  onCreateDepartment: (name: string) => Promise<number>;
  onClose: () => void;
  onSave: (name: string, note: string | null, details: PersonDetails) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const db = useSQLiteContext();
  const { terms } = useScene();
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email ?? '');
  const [note, setNote] = useState(person.note ?? '');
  const [departmentId, setDepartmentId] = useState(person.departmentId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedDepartment = departments.some((department) => department.id === departmentId) ? departmentId : null;

  async function save() {
    setError(null);
    setBusy(true);
    try {
      // 家庭场景不显示部门、邮箱，不传就不动
      await onSave(name, note, office ? { departmentId: selectedDepartment, email } : {});
    } catch (saveError) {
      setError(errorText(saveError, '保存失败，请重试'));
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
        onPress: () => onDelete().catch((deleteError) => setError(errorText(deleteError, '删除失败，请重试'))),
      },
    ]);
  }

  return (
    <Sheet visible title={person.name} onClose={onClose}>
      {office ? (
        <View style={peopleStyles.field}>
          <Label>部门</Label>
          <DepartmentChips
            departments={departments}
            value={selectedDepartment}
            onChange={setDepartmentId}
            onCreate={onCreateDepartment}
          />
        </View>
      ) : null}
      <Field label="姓名" required value={name} onChangeText={setName} maxLength={PERSON_NAME_MAX} />
      {office ? <EmailField value={email} onChangeText={setEmail} /> : null}
      <Field label="备注" value={note} onChangeText={setNote} placeholder={terms.personNotePlaceholder} maxLength={PERSON_NOTE_MAX} />
      {error ? <Text style={peopleStyles.error}>{error}</Text> : null}
      <View style={peopleStyles.actions}>
        <Button title="删除" variant="danger" disabled={busy} onPress={confirmDelete} style={peopleStyles.flex} />
        <Button title="保存" loading={busy} disabled={!name.trim()} onPress={() => confirmSave()} style={peopleStyles.flex} />
      </View>
    </Sheet>
  );
}

/**
 * 「管理部门」面板：列出部门和各自人数，新建、改名、删除。
 * 改名后人员跟着显示新名字（人员只存部门编号）；删除时这个部门的人变成未分部门，人员和领用记录都不删。
 */
function DepartmentsSheet({
  departments,
  onClose,
  onChanged,
}: {
  departments: readonly Department[];
  onClose: () => void;
  /** 增删改之后重新读名单和部门 */
  onChanged: () => Promise<void>;
}) {
  const db = useSQLiteContext();
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setError(null);
    try {
      await task();
      await onChanged();
      return true;
    } catch (taskError) {
      setError(errorText(taskError, fallback));
      return false;
    }
  }

  async function add() {
    if (await run(() => addDepartment(db, newName), '添加失败，请重试')) setNewName('');
  }

  async function saveRename(department: Department) {
    if (await run(() => renameDepartment(db, department.id, renameText), '保存失败，请重试')) setRenaming(null);
  }

  function startRename(department: Department) {
    setError(null);
    setRenaming(department.id);
    setRenameText(department.name);
  }

  function confirmDelete(department: Department) {
    const message = department.personCount
      ? `${department.personCount} 人会变成未分部门，人员和领用记录都不删。`
      : '这个部门还没有人。';
    Alert.alert(`删除部门「${department.name}」？`, message, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          if (renaming === department.id) setRenaming(null);
          run(() => deleteDepartment(db, department.id), '删除失败，请重试').catch(() => undefined);
        },
      },
    ]);
  }

  return (
    <Sheet visible title="管理部门" onClose={onClose}>
      {departments.length ? (
        <View style={peopleStyles.departmentList}>
          {departments.map((department, index) => (
            <View key={department.id} style={[peopleStyles.departmentRow, index > 0 && peopleStyles.departmentDivider]}>
              {renaming === department.id ? (
                <View style={peopleStyles.flex}>
                  <Field
                    value={renameText}
                    onChangeText={setRenameText}
                    maxLength={DEPARTMENT_NAME_MAX}
                    autoFocus
                    onSubmitEditing={() => (renameText.trim() ? saveRename(department) : undefined)}
                    right={
                      <>
                        <Button title="保存" compact disabled={!renameText.trim()} onPress={() => saveRename(department)} />
                        <Button title="取消" compact variant="secondary" onPress={() => setRenaming(null)} />
                      </>
                    }
                  />
                </View>
              ) : (
                <>
                  <View style={peopleStyles.departmentText}>
                    <Text style={peopleStyles.departmentName}>{department.name}</Text>
                    <Text style={peopleStyles.departmentMeta}>{department.personCount} 人</Text>
                  </View>
                  <IconButton icon="create-outline" label={`给${department.name}改名`} onPress={() => startRename(department)} />
                  <IconButton
                    icon="trash-outline"
                    label={`删除${department.name}`}
                    color={colors.danger}
                    onPress={() => confirmDelete(department)}
                  />
                </>
              )}
            </View>
          ))}
        </View>
      ) : (
        <Text style={peopleStyles.hint}>还没有部门。建好以后，加人、改人时可以选部门。</Text>
      )}
      <Field
        label="新建部门"
        value={newName}
        onChangeText={setNewName}
        placeholder={NEW_DEPARTMENT_PLACEHOLDER}
        maxLength={DEPARTMENT_NAME_MAX}
        onSubmitEditing={() => (newName.trim() ? add() : undefined)}
        right={<Button title="添加" compact disabled={!newName.trim()} onPress={() => add()} />}
      />
      {error ? <Text style={peopleStyles.error}>{error}</Text> : null}
    </Sheet>
  );
}

const peopleStyles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  field: { gap: 8 },
  group: { gap: 8 },
  groupTitle: { fontSize: font.small, color: colors.muted, paddingHorizontal: 4 },
  error: { fontSize: font.small, color: colors.danger },
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  // 面板里单独圈出来的一块用浅灰底（见 ui.tsx 的 Sheet）
  departmentList: { backgroundColor: colors.bg, borderRadius: radius.md, paddingHorizontal: 12 },
  departmentRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 52, paddingVertical: 6 },
  departmentDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  departmentText: { flex: 1, minWidth: 0, gap: 2 },
  departmentName: { fontSize: font.body, color: colors.ink },
  departmentMeta: { fontSize: font.small, color: colors.muted },
});
