// Floating surfaces and the small pieces that live on them.
//
// Everything in this design sits on a white rounded card over the map, so the
// card, the status pill and the labelled stat are defined once here rather
// than re-declared with slightly different radii on every screen.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

export function Card({ children, style, ...rest }) {
  return (
    <View style={[styles.card, t.shadow.card, style]} {...rest}>
      {children}
    </View>
  );
}

/** Small tinted status pill — ACTIVE / DEGRADED / DEAD RECKONING ACTIVE. */
export function StatusPill({ label, tone, wash, icon, style }) {
  return (
    <View style={[styles.pill, { backgroundColor: wash }, style]}>
      {icon ? (
        <Icon name={icon} size={15} color={tone} style={styles.pillIcon}
              importantForAccessibility="no" />
      ) : null}
      <Text style={[styles.pillLabel, { color: tone }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/** A labelled readout: small grey caption over a large bold value. */
export function Stat({ label, value, unit, tone, style, accessibilityLabel }) {
  return (
    <View style={[styles.stat, style]} accessibilityLabel={accessibilityLabel}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={styles.statRow}>
        <Text style={[styles.statValue, tone ? { color: tone } : null]}>{value}</Text>
        {unit ? <Text style={styles.statUnit}>{unit}</Text> : null}
      </View>
    </View>
  );
}

/** Circular tinted icon badge used down the left of each diagnostics row. */
export function IconBadge({ name, tone, wash, size = 44 }) {
  return (
    <View style={[styles.badge, {
      width: size, height: size, borderRadius: size / 2, backgroundColor: wash,
    }]}>
      <Icon name={name} size={size * 0.5} color={tone} importantForAccessibility="no" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.card,
    padding: t.space.lg,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: t.radius.pill,
    paddingHorizontal: t.space.md,
    paddingVertical: 6,
  },
  pillIcon: { marginRight: 6 },
  pillLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8,
  },
  stat: {},
  statLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '600',
    letterSpacing: 1.1, color: t.color.textMuted,
  },
  statRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 },
  statValue: {
    fontFamily: t.font.sansMedium, fontSize: t.type.head, fontWeight: '700',
    color: t.color.textPrimary,
    // Tabular figures: a changing bearing must not reflow the card.
    fontVariant: ['tabular-nums'],
  },
  statUnit: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textMuted,
    marginLeft: 4,
  },
  badge: { alignItems: 'center', justifyContent: 'center' },
});
