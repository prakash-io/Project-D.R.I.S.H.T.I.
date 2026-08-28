// Where am I going: the Source/Destination card at the TOP of the map screen.
//
// This is the Google Maps directions header, and it is at the top for the
// reason Google put it there: it is the first thing a driver touches and the
// last thing they need once moving, so it belongs where the thumb reaches
// while parked and the eye ignores at speed. It used to be a collapsed
// "Where to?" pill at the BOTTOM, stacked under the ETA band and over a rail
// of corridor tiles -- which meant the two most important controls on the
// screen were the two hardest to find.
//
// Both fields are always visible now. Collapsing them saved about 90 pt of map
// and cost the driver the answer to "where does this app think I am going",
// which is the question the whole screen exists to answer.
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
import { t } from './tokens';

/**
 * @param places        [{ id, name, lat, lng }] from GET /routes/places
 * @param origin        chosen source, or null
 * @param destination   chosen destination, or null
 * @param hasFix        offer "My location" as a source
 * @param planning      a plan is in flight -- the action row spins
 * @param error         last planning failure, shown in the card
 * @param onChange      (field, place) => void   field is 'origin'|'destination'
 * @param onSwap        () => void
 * @param onPlan        () => void
 * @param onClearError  () => void
 */
export default function RoutePlanner({
  places, origin, destination, hasFix, planning, error,
  onChange, onSwap, onPlan, onClearError, style,
}) {
  // Which field the picker is filling, or null when it is closed. One picker
  // serving both fields rather than two mounted modals: only one can ever be
  // on screen, and two would be two places for the filter state to diverge.
  const [picking, setPicking] = useState(null);

  const ready = Boolean(origin && destination && origin.id !== destination.id);

  return (
    <View style={[styles.card, t.shadow.card, style]}>
      <View style={styles.fields}>
        <View style={styles.fieldStack}>
          <Field
            icon="trip-origin"
            tone={t.color.routeStart}
            label="Source"
            place={origin}
            placeholder="Choose a starting point"
            onPress={() => { onClearError?.(); setPicking('origin'); }}
          />
          {/* The connector every navigator draws between the two ends. Purely
              decorative, and hidden from the screen reader for that reason.
              Dotted rather than a solid rule: it stands in for the road, and
              the road is not known until the route has been planned. */}
          <View style={styles.connector} importantForAccessibility="no">
            <View style={styles.connectorDot} />
            <View style={styles.connectorDot} />
            <View style={styles.connectorDot} />
          </View>
          <Field
            icon="place"
            tone={t.color.routeEnd}
            label="Destination"
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
          accessibilityLabel="Swap source and destination"
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
          <ActivityIndicator size="small" color={t.color.routeLine} />
          <Text style={styles.planningText}>
            Planning over the road network — a long route can take a minute.
          </Text>
        </View>
      ) : (
        // Deliberately NOT the shared Button: that one is the orange primary
        // action, and orange is the hazard-report colour on this screen. The
        // directions action is blue because the line it draws is blue, and
        // that correspondence is the only legend either of them gets.
        <Pressable
          onPress={onPlan}
          disabled={!ready}
          style={({ pressed }) => [
            styles.go,
            pressed && ready && styles.goPressed,
            !ready && styles.goDisabled,
          ]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          accessibilityLabel="Get directions"
          accessibilityHint={ready
            ? 'Plans the route and starts the trip'
            : 'Choose two different places first'}
        >
          <Icon
            name="directions"
            size={18}
            color={ready ? t.color.onAccent : t.color.textMuted}
            importantForAccessibility="no"
          />
          <Text style={[styles.goLabel, !ready && styles.goLabelDisabled]}>
            Get directions
          </Text>
        </Pressable>
      )}

      <PlacePicker
        visible={picking !== null}
        title={picking === 'origin' ? 'Choose source' : 'Choose destination'}
        places={places}
        selectedId={picking === 'origin' ? origin?.id : destination?.id}
        excludeId={picking === 'origin' ? destination?.id : origin?.id}
        // "My location" is a source only. Routing TO wherever the truck
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
  card: {
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.card,
    padding: t.space.md,
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
    height: 14, justifyContent: 'space-between',
    // Lines up with the centre of the 18 pt field icons above and below it:
    // field padding (8) + half the icon (9) - half the dot (1.5).
    marginLeft: t.space.sm + 7.5,
  },
  connectorDot: {
    width: 3, height: 3, borderRadius: 1.5,
    backgroundColor: t.color.border,
  },
  swap: {
    width: t.touchMin, height: t.touchMin,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: t.radius.pill,
  },
  swapPressed: { backgroundColor: t.color.bgInset },
  go: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    minHeight: t.touchMin,
    borderRadius: t.radius.pill,
    backgroundColor: t.color.routeLine,
    marginTop: t.space.sm,
  },
  goPressed: { backgroundColor: t.color.routeCasing },
  goDisabled: { backgroundColor: t.color.bgInset },
  goLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.body, fontWeight: '700',
    color: t.color.onAccent, marginLeft: t.space.sm,
  },
  goLabelDisabled: { color: t.color.textMuted },
  planning: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: t.space.sm, paddingVertical: t.space.sm,
    paddingHorizontal: t.space.sm,
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
    marginTop: t.space.sm,
  },
  errorText: {
    flex: 1,
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.alertText,
    marginLeft: t.space.sm, lineHeight: 18,
  },
});
