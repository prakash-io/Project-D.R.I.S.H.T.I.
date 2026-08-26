// Bottom navigation — HUD / MAP / HAZARD / SYNC.
//
// Four top-level destinations, which is inside the five-item ceiling. Icon AND
// label on every item: an icon-only bar costs discoverability, and this is
// read at a glance by someone who is not studying it.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

export const TABS = [
  { key: 'hud', label: 'HUD', icon: 'speed' },
  { key: 'map', label: 'MAP', icon: 'map' },
  { key: 'hazard', label: 'HAZARD', icon: 'warning-amber' },
  { key: 'sync', label: 'SYNC', icon: 'sync' },
];

export default function TabBar({ active, onChange, badges = {} }) {
  return (
    <View style={[styles.bar, t.shadow.card]}>
      {TABS.map((tab) => {
        const selected = tab.key === active;
        const badge = badges[tab.key];
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            style={({ pressed }) => [
              styles.item,
              selected && styles.itemActive,
              pressed && !selected && styles.itemPressed,
            ]}
            accessibilityRole="tab"
            // Announces the current destination rather than relying on colour.
            accessibilityState={{ selected }}
            accessibilityLabel={badge
              ? `${tab.label}, ${badge} pending`
              : tab.label}
          >
            <View>
              <Icon
                name={tab.icon}
                size={22}
                color={selected ? t.color.onAccent : t.color.textMuted}
                importantForAccessibility="no"
              />
              {badge ? <View style={styles.badge} /> : null}
            </View>
            <Text style={[styles.label, selected && styles.labelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.pill,
    padding: 6,
    marginHorizontal: t.space.lg,
  },
  item: {
    flex: 1,
    minHeight: t.touchMin,
    borderRadius: t.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  itemActive: { backgroundColor: t.color.accent },
  itemPressed: { backgroundColor: t.color.bgInset },
  label: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.textMuted, marginTop: 2,
  },
  labelActive: { color: t.color.onAccent },
  badge: {
    position: 'absolute', top: -2, right: -4,
    width: 9, height: 9, borderRadius: 5,
    backgroundColor: t.color.alertFill,
    borderWidth: 1.5, borderColor: t.color.bgPanel,
  },
});
