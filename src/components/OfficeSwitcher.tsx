import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ALL_OFFICES } from '../db/offices';
import { useOffice } from '../hooks/useOffice';
import { useTerms } from '../hooks/useScene';
import { colors, font, radius } from '../theme';
import { Button, ChoiceChips, Label, Sheet } from './ui';

/** 标签页右上角的办公点切换。只有一个办公点时不显示。 */
export function OfficeSwitcher() {
  const office = useOffice();
  const terms = useTerms();
  const [open, setOpen] = useState(false);
  if (!office.multiple) return null;

  const options = [
    { id: ALL_OFFICES, name: `全部${terms.place}`, detail: `${office.offices.length} 个${terms.place}` },
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
        accessibilityLabel={`当前${terms.place}：${office.currentName ?? `全部${terms.place}`}，点按切换`}
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
      <Sheet visible={open} title={`切换${terms.place}`} onClose={() => setOpen(false)}>
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
          title={`管理${terms.place}`}
          variant="ghost"
          icon="settings-outline"
          onPress={() => {
            setOpen(false);
            // 办公点管理现在是设置里点进去的单独页面，直接打开它
            router.push('/offices');
          }}
        />
      </Sheet>
    </>
  );
}

/** 表单里选「放在哪个办公点」。只有一个办公点时不显示。 */
export function OfficeChooser({ value, onChange }: { value: number; onChange: (id: number) => void }) {
  const office = useOffice();
  const terms = useTerms();
  if (!office.multiple) return null;
  return (
    <View style={switcherStyles.chooser}>
      <Label>{terms.place}</Label>
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
    // 安卓、网页是标签栏自带的标题栏，右边自己空出 16；iOS 上放在系统导航栏里，系统自己留了边距
    marginRight: Platform.OS === 'ios' ? 0 : 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    maxWidth: 160,
  },
  triggerText: { fontSize: font.small, fontWeight: '700', color: colors.accent, flexShrink: 1 },
  list: { gap: 8 },
  // 浅灰底圆角（面板是白底，白块会融进去），没选中的不描边，选中的描主色
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.bg,
  },
  optionSelected: { borderColor: colors.accent },
  optionText: { flex: 1, minWidth: 0 },
  optionName: { fontSize: font.body, fontWeight: '600', color: colors.ink },
  optionDetail: { fontSize: font.small, color: colors.muted, marginTop: 2 },
  chooser: { gap: 8 },
});
