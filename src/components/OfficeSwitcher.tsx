import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ALL_OFFICES } from '../db/offices';
import { useOffice } from '../hooks/useOffice';
import { colors, font, radius } from '../theme';
import { Button, ChoiceChips, Label, Sheet } from './ui';

/** 标签页右上角的办公点切换。只有一个办公点时不显示。 */
export function OfficeSwitcher() {
  const office = useOffice();
  const [open, setOpen] = useState(false);
  if (!office.multiple) return null;

  const options = [
    { id: ALL_OFFICES, name: '全部办公点', detail: `${office.offices.length} 个办公点` },
    ...office.offices.map((item) => ({
      id: item.id,
      name: item.name,
      detail: `物品 ${item.productCount} 样 · 设备 ${item.deviceCount} 种`,
    })),
  ];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`当前办公点：${office.currentName ?? '全部办公点'}，点按切换`}
        onPress={() => {
          office.reload().catch(() => undefined);
          setOpen(true);
        }}
        style={({ pressed }) => [switcherStyles.trigger, pressed && { opacity: 0.6 }]}
        hitSlop={8}
      >
        <Ionicons name="business-outline" size={16} color={colors.accent} />
        <Text style={switcherStyles.triggerText} numberOfLines={1}>
          {office.currentName ?? '全部'}
        </Text>
        <Ionicons name="chevron-down" size={14} color={colors.accent} />
      </Pressable>
      <Sheet visible={open} title="切换办公点" onClose={() => setOpen(false)}>
        <View style={switcherStyles.list}>
          {options.map((item) => {
            const selected = item.id === office.currentId;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => {
                  office.select(item.id).catch(() => undefined);
                  setOpen(false);
                }}
                style={({ pressed }) => [
                  switcherStyles.option,
                  selected && switcherStyles.optionSelected,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <View style={switcherStyles.optionText}>
                  <Text style={switcherStyles.optionName}>{item.name}</Text>
                  <Text style={switcherStyles.optionDetail}>{item.detail}</Text>
                </View>
                {selected ? <Ionicons name="checkmark-circle" size={22} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
        <Button
          title="管理办公点"
          variant="ghost"
          icon="settings-outline"
          onPress={() => {
            setOpen(false);
            router.navigate('/settings');
          }}
        />
      </Sheet>
    </>
  );
}

/** 表单里选「放在哪个办公点」。只有一个办公点时不显示。 */
export function OfficeChooser({ value, onChange }: { value: number; onChange: (id: number) => void }) {
  const office = useOffice();
  if (!office.multiple) return null;
  return (
    <View style={switcherStyles.chooser}>
      <Label>办公点</Label>
      <ChoiceChips
        options={office.offices.map((item) => ({ value: item.id, label: item.name }))}
        value={value}
        onChange={onChange}
      />
    </View>
  );
}

const switcherStyles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    maxWidth: 160,
  },
  triggerText: { fontSize: font.small, fontWeight: '700', color: colors.accent, flexShrink: 1 },
  list: { gap: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  optionSelected: { borderColor: colors.accent },
  optionText: { flex: 1, minWidth: 0 },
  optionName: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  optionDetail: { fontSize: font.small, color: colors.muted, marginTop: 2 },
  chooser: { gap: 8 },
});
