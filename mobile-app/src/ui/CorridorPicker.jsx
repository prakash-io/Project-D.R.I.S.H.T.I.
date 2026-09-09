// Corridor selector: the demonstration routes, drawn from the road dataset.
//
// A horizontal rail of pills rather than a dropdown. There are ten corridors
// and the driver picks one at the start of a shift, so the choice should be
// visible and thumb-reachable in a cradle, not hidden behind a tap that opens
// a list over the map.
import React from 'react';
import { ScrollView, Pressable, Text, View, StyleSheet } from 'react-native';
import { t } from './tokens';

/**
 * @param corridors  [{ id, name, origin_name, destination_name, distance_m }]
 * @param activeId   currently driven corridor
 * @param onSelect   (id) => void
 * @param busy       id currently being loaded, or null
 */
export default function CorridorPicker({ corridors, activeId, onSelect, busy }) {
  if (!corridors || corridors.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.caption}>
        ROUTE · {corridors.length} corridors from the road network
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
      >
        {corridors.map((c) => {
          const active = c.id === activeId;
          const loading = busy === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => onSelect?.(c.id)}
              disabled={loading}
              style={({ pressed }) => [
                styles.pill,
                active && styles.pillActive,
                pressed && !active && styles.pillPressed,
                loading && styles.pillLoading,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: loading }}
              accessibilityLabel={`${c.origin_name} to ${c.destination_name}, `
                + `${(c.distance_m / 1000).toFixed(0)} kilometres`}
            >
              <Text
                style={[styles.label, active && styles.labelActive]}
                numberOfLines={1}
              >
                {c.origin_name} → {c.destination_name}
              </Text>
              <Text style={[styles.dist, active && styles.distActive]}>
                {loading ? 'loading…' : `${(c.distance_m / 1000).toFixed(0)} km`}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.card,
    paddingVertical: t.space.md,
    // The rail sits directly above the BEARING/ALTITUDE cards inside the same
    // absolutely-positioned stack, which has no gap of its own.
    marginBottom: t.space.md,
    ...t.shadow.card,
  },
  caption: {
    fontFamily: t.font.sansMedium,
    fontSize: t.type.micro,
    fontWeight: '600',
    letterSpacing: 0.8,
    color: t.color.textMuted,
    paddingHorizontal: t.space.lg,
    marginBottom: t.space.sm,
  },
  // The rail is padded rather than the ScrollView, so the first and last pill
  // clear the card edge while still scrolling under it.
  rail: { paddingHorizontal: t.space.lg, gap: t.space.sm },
  pill: {
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.sm,
    borderRadius: t.radius.pill,
    backgroundColor: t.color.bgInset,
    borderWidth: 1,
    borderColor: 'transparent',
    minHeight: t.touchMin,   // the design system's shared touch minimum
    justifyContent: 'center',
  },
  pillActive: { backgroundColor: t.color.accent, borderColor: t.color.accentPressed },
  pillPressed: { backgroundColor: t.color.accentWash },
  pillLoading: { opacity: 0.6 },
  label: {
    fontFamily: t.font.sansMedium,
    fontSize: t.type.meta,
    fontWeight: '600',
    color: t.color.textPrimary,
  },
  labelActive: { color: t.color.onAccent },
  dist: {
    fontFamily: t.font.sans,
    fontSize: t.type.micro,
    color: t.color.textMuted,
    marginTop: 2,
  },
  distActive: { color: t.color.onAccent, opacity: 0.9 },
});
