import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { createOffice, deleteOffice, OFFICE_NAME_MAX, renameOffice, type Office } from '../db/offices';
import { useOffice } from '../hooks/useOffice';
import { colors, font } from '../theme';
import { Button, Card, Field, IconButton, Sheet } from './ui';

/** 设置页里的办公点管理：添加、改名、删除（只能删空的）。 */
export function OfficeManager() {
  const db = useSQLiteContext();
  const office = useOffice();
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Office | null>(null);
  const { reload } = office;

  // 回到设置页时刷新各办公点的数量
  useFocusEffect(
    useCallback(() => {
      reload().catch(() => undefined);
    }, [reload]),
  );

  async function add() {
    setError(null);
    try {
      const id = await createOffice(db, newName);
      setNewName('');
      await office.reload();
      // 从一个办公点变成多个时，原来那个自动成了当前办公点，新加的不用切过去
      if (!office.multiple) await office.select(office.offices[0]?.id ?? id);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : '添加失败，请重试');
    }
  }

  function confirmDelete(item: Office) {
    Alert.alert(`删除「${item.name}」？`, '只能删除里面没有东西的办公点。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteOffice(db, item.id);
            await office.reload();
          } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : '删除失败，请重试');
          }
        },
      },
    ]);
  }

  return (
    <Card>
      <Text style={managerStyles.hint}>
        食品、日用品、设备都归到某个办公点下。有多个办公点时，各页右上角可以切换，也可以看全部办公点。
      </Text>
      {office.offices.map((item, index) => (
        <View key={item.id} style={[managerStyles.row, index > 0 && managerStyles.divider]}>
          <View style={managerStyles.rowText}>
            <Text style={managerStyles.name}>{item.name}</Text>
            <Text style={managerStyles.meta}>
              物品 {item.productCount} 样 · 设备 {item.deviceCount} 种
            </Text>
          </View>
          <IconButton icon="create-outline" label={`给${item.name}改名`} onPress={() => setRenaming(item)} />
          {office.offices.length > 1 ? (
            <IconButton
              icon="trash-outline"
              label={`删除${item.name}`}
              color={colors.danger}
              onPress={() => confirmDelete(item)}
            />
          ) : null}
        </View>
      ))}
      <Field
        value={newName}
        onChangeText={setNewName}
        placeholder="新办公点名称，如 上海办公室"
        maxLength={OFFICE_NAME_MAX}
        right={<Button title="添加" compact disabled={!newName.trim()} onPress={() => add()} />}
      />
      {error ? <Text style={managerStyles.error}>{error}</Text> : null}
      {renaming ? (
        <RenameSheet
          office={renaming}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await renameOffice(db, renaming.id, name);
            setRenaming(null);
            await office.reload();
          }}
        />
      ) : null}
    </Card>
  );
}

function RenameSheet({
  office,
  onClose,
  onSave,
}: {
  office: Office;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(office.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet visible title="办公点改名" onClose={onClose}>
      <Field label="名称" value={name} onChangeText={setName} maxLength={OFFICE_NAME_MAX} autoFocus error={error} />
      <Text style={managerStyles.hint}>别的手机按名称认办公点，改名后，从别的手机导过来的同名数据会对不上，记得让对方也改成一样的名字。</Text>
      <Button
        title="保存"
        disabled={!name.trim()}
        onPress={async () => {
          setError(null);
          try {
            await onSave(name);
          } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : '保存失败，请重试');
          }
        }}
      />
    </Sheet>
  );
}

const managerStyles = StyleSheet.create({
  hint: { fontSize: font.small, color: colors.faint, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowText: { flex: 1, minWidth: 0 },
  name: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  meta: { fontSize: font.small, color: colors.muted },
  error: { fontSize: font.small, color: colors.danger },
});
