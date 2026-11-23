import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { filterPeople, findPersonByName, type Person } from '../db/people';
import { useScene } from '../hooks/useScene';
import { colors, font } from '../theme';
import { ChoiceChips } from './ui';

/** 输入的名字要不要提示「同时加到名单」：填了、而且名单里没有（不分大小写） */
export function needsRosterAdd(roster: readonly Person[], name: string): boolean {
  return !!name.trim() && !findPersonByName(roster, name);
}

/**
 * 「使用人」「谁在用」输入框下面：
 * - 名单里的人一个个列出来点选（只显示姓名），输入时按输入的字过滤：办公场景姓名、部门名、邮箱、备注包含都算，
 *   家庭场景（不显示部门、邮箱）只看姓名、备注；点选了某人、或者框里还是打开时的名字（修改已有记录），照样全列出来，方便换人。
 * - 「同时加到名单」新记录默认勾上；修改已有记录时默认不勾（只是改改日期、备注，不会顺手把老名字加进名单），要加自己勾。
 * - 名单还是空的：照旧列最近用过的名字，提示去设置里加人。
 * - 输入的名字不在名单里：「同时加到员工名单（家庭成员）」，默认勾上，保存时一起加进名单（没有部门、邮箱，以后在名单里补）。
 */
export function PersonPicker({
  value,
  onChange,
  roster,
  recent,
  addToRoster,
  onAddToRosterChange,
}: {
  value: string;
  onChange: (name: string) => void;
  roster: readonly Person[];
  /** 最近用过的名字（名单空时列这些） */
  recent: readonly string[];
  addToRoster: boolean;
  onAddToRosterChange: (value: boolean) => void;
}) {
  const { scene, terms } = useScene();
  /** 打开时框里的名字（修改已有记录时是原来的使用人）：没改过就不按它过滤 */
  const [initialValue] = useState(value.trim());
  const query = value.trim();
  const picked = roster.some((person) => person.name === query);
  const typed = query !== initialValue;
  const searchable = scene === 'office' ? roster : roster.map((person) => ({ ...person, email: null, departmentName: null }));
  const names = roster.length
    ? (picked || !typed ? roster : filterPeople(searchable, query)).map((person) => person.name)
    : [...recent];
  return (
    <>
      {names.length ? (
        <ChoiceChips options={names.map((name) => ({ value: name, label: name }))} value={query} onChange={onChange} />
      ) : null}
      {roster.length ? null : <Text style={pickerStyles.hint}>可以在设置 → 通用 → {terms.roster}里加人</Text>}
      {needsRosterAdd(roster, value) ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: addToRoster }}
          onPress={() => onAddToRosterChange(!addToRoster)}
          hitSlop={6}
          style={pickerStyles.check}
        >
          <Ionicons name={addToRoster ? 'checkbox' : 'square-outline'} size={20} color={addToRoster ? colors.accent : colors.faint} />
          <View style={pickerStyles.checkText}>
            <Text style={pickerStyles.checkLabel}>同时加到{terms.roster}</Text>
          </View>
        </Pressable>
      ) : null}
    </>
  );
}

const pickerStyles = StyleSheet.create({
  hint: { fontSize: font.small, color: colors.faint },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', paddingVertical: 2 },
  checkText: { flexShrink: 1 },
  checkLabel: { fontSize: font.body, color: colors.ink },
});
