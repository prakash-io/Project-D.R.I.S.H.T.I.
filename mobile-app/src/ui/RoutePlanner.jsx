// Where am I going: the origin/destination card (workflow §1, driver side).
//
// Collapsed it is a single "Where to?" pill, because 95% of the time the
// driver wants the map, not the form. Expanded it is the two-field stack every
// navigator uses -- origin dot, destination pin, a swap between them -- so
// there is nothing to learn.
//
// The fields are pressable rather than free-text on purpose. Typing happens
// inside PlacePicker, over a list of places the road graph provably reaches;
// a raw text field here would let the driver enter a village this extract does
// not cover and read the resulting "no route" as a broken app rather than as
// a map that stops there.
import React, { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import PlacePicker, { HERE } from './PlacePicker';
import Button from './Button';
import { t } from './tokens';

/**
 * @param places        [{ id, name, lat, lng }] from GET /routes/places
 * @param origin        chosen origin, or null
 * @param destination   chosen destination, or null
 * @param hasFix        offer "My location" as an origin
 * @param planning      a plan is in flight -- the Go button spins
 * @param error         last planning failure, shown in the card
 * @param onChange      (field, place) => void   field is 'origin'|'destination'
 * @param onSwap        () => void
 * @param onPlan        () => void
 * @param onClearError  () => void
 */
export default function RoutePlanner({
  places, origin, destination, hasFix, planning, error,
  open, onOpenChange, onChange, onSwap, onPlan, onClearError, style,
}) {
  // Open state is CONTROLLED. The screen behind this card has to make room
  // for it -- the stat cards and the corridor rail step aside while the form
  // is up -- and a component that owned its own open flag could not tell them
  // to. See App.jsx's mapBottom stack.
  const setOpen = onOpenChange ?? (() => {});
  // Which field the picker is filling, or null when it is closed. One picker
  // serving both fields rather than two mounted modals: only one can ever be
  // on screen, and two would be two places for the filter state to diverge.
  const [picking, setPicking] = useState(null);

  const ready = Boolean(origin && destination && origin.id !== destination.id);

  if (!open) {
    return (
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.collapsed, t.shadow.card, pressed && styles.collapsedPressed, style,
        ]}
        accessibilityRole="button"
        accessibilityLabel={destination
          ? `Route to ${destination.name}. Change route`
          : 'Set origin and destination'}
      >
        <Icon name="search" size={20} color={t.color.textMuted}
              importantForAccessibility="no" />
        <Text style={styles.collapsedLabel} numberOfLines={1}>
          {destination ? `To ${destination.name}` : 'Where to?'}
        </Text>
        <Icon name="expand-less" size={22} color={t.color.textMuted}
              importantForAccessibility="no" />
      </Pressable>
    );
  }

  return (
    <View style={[styles.card, t.shadow.card, style]}>
      <View style={styles.head}>
        <Text style={styles.heading} accessibilityRole="header">Plan route</Text>
        <Pressable
          onPress={() => setOpen(false)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Hide route planner"
        >
          <Icon name="expand-more" size={24} color={t.color.textMuted} />
        </Pressable>
      </View>

      <View style={styles.fields}>
        <View style={styles.fieldStack}>
          <Field
            icon="trip-origin"
            tone={t.color.textMuted}
            label="From"
            place={origin}
            placeholder="Choose a starting point"
            onPress={() => { onClearError?.(); setPicking('origin'); }}
          />
          {/* The connector every navigator draws between the two ends. Purely
              decorative, and hidden from the screen reader for that reason. */}
          <View style={styles.connector} importantForAccessibility="no" />
          <Field
            icon="place"
            tone={t.color.accent}
            label="To"
            place={destination}
            placeholder="Choose a destination"
            onPress={() => { onClearError?.(); setPicking('destination'); }}
          />
        </View>

        <Pressable
          onPress={onSwap}
          disabled={!origin && !destination}
          style={({ pressed }) => [styles.swap, pressed && styles.swapPressed]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Swap origin and destination"
        >
          <Icon name="swap-vert" size={22} color={t.color.textSecondary} />
        </Pressable>
      </View>

      {error ? (
        <View style={styles.error} accessibilityLiveRegion="polite">
          <Icon name="error-outline" size={16} color={t.color.alertText}
                importantForAccessibility="no" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {planning ? (
        <View style={styles.planning} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={t.color.accent} />
          <Text style={styles.planningText}>
            Planning over the road network — a long route can take a minute.
          </Text>
        </View>
      ) : (
        <Button
          label="Get directions"
          icon="directions"
          size="md"
          onPress={onPlan}
          disabled={!ready}
          style={styles.go}
          accessibilityHint={ready
            ? 'Plans the route and starts the trip'
            : 'Choose two different places first'}
        />
      )}

      <PlacePicker
        visible={picking !== null}
        title={picking === 'origin' ? 'Choose origin' : 'Choose destination'}
        places={places}
        selectedId={picking === 'origin' ? origin?.id : destination?.id}
        excludeId={picking === 'origin' ? destination?.id : origin?.id}
        // "My location" is an origin only. Routing TO wherever the truck
        // happens to be is not a journey.
        allowHere={picking === 'origin' && hasFix}
        onSelect={(place) => { onChange?.(picking, place); setPicking(null); }}
        onClose={() => setPicking(null)}
      />
    </View>
  );
}

function Field({ icon, tone, label, place, placeholder, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.field, pressed && styles.fieldPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${place?.name ?? 'not set'}`}
      accessibilityHint="Opens the place list"
    >
      <Icon name={icon} size={18} color={tone} importantForAccessibility="no" />
      <View style={styles.fieldBody}>
        <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
        <Text
          style={[styles.fieldValue, !place && styles.fieldPlaceholder]}
          numberOfLines={1}
        >
          {place?.name ?? placeholder}
        </Text>
      </View>
    </Pressable>
  );
}

/// Re-exported so App.jsx can build the "My location" origin without importing
/// PlacePicker just for the sentinel.
export { HERE };

const styles = StyleSheet.create({
  collapsed: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.pill,
    minHeight: t.touchMin,
    paddingHorizontal: t.space.lg,
    marginBottom: t.space.md,
  },
  collapsedPressed: { backgroundColor: t.color.bgInset },
  collapsedLabel: {
    flex: 1,
    fontFamily: t.font.sansMedium, fontSize: t.type.body, color: t.color.textPrimary,
    marginHorizontal: t.space.md,
  },
  card: {
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.card,
    padding: t.space.lg,
    marginBottom: t.space.md,
  },
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: t.space.sm,
  },
  heading: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 1.1, color: t.color.textMuted,
  },
  fields: { flexDirection: 'row', alignItems: 'center' },
  fieldStack: { flex: 1 },
  field: {
    flexDirection: 'row', alignItems: 'center',
    minHeight: 44,
    borderRadius: t.radius.chip,
    paddingHorizontal: t.space.sm,
  },
  fieldPressed: { backgroundColor: t.color.bgInset },
  fieldBody: { flex: 1, marginLeft: t.space.md },
  fieldLabel: {
    fontFamily: t.font.sansMedium, fontSize: 10, fontWeight: '700',
    letterSpacing: 1, color: t.color.textMuted,
  },
  fieldValue: {
    fontFamily: t.font.sansMedium, fontSize: t.type.body, color: t.color.textPrimary,
  },
  fieldPlaceholder: { fontFamily: t.font.sans, color: t.color.textMuted },
  connector: {
    width: t.hairline, height: 12,
    backgroundColor: t.color.border,
    marginLeft: t.space.sm + 8,
  },
  swap: {
    width: t.touchMin, height: t.touchMin,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: t.radius.pill,
  },
  swapPressed: { backgroundColor: t.color.bgInset },
  go: { marginTop: t.space.md },
  planning: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: t.space.md, paddingVertical: t.space.sm,
  },
  planningText: {
    flex: 1,
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    marginLeft: t.space.md,
  },
  error: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: t.color.alertWash,
    borderRadius: t.radius.chip,
    padding: t.space.md,
    marginTop: t.space.md,
  },
  errorText: {
    flex: 1,
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.alertText,
    marginLeft: t.space.sm, lineHeight: 18,
  },
});
