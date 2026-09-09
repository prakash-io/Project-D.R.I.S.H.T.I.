// The card at the top of the map: what the driver is doing right now.
//
// One card, one thought. It answers "where am I going, and how far is left"
// in a single glance and then gets out of the way -- everything about the
// route that is not that lives one tap down, in the route sheet.
//
// This replaces four separate white cards that used to stack down the map:
// the 154 km distance card, the "To Tezpur" search field, the ETA summary and
// the NEW ROUTE flag. They were all the same sentence broken into pieces, and
// each piece charged the map its own 24pt radius and its own shadow.
//
// On the instruction form: a turn-by-turn maneuver is the right headline for
// this slot, and the layout below renders one the moment it is handed a
// maneuver. Nothing feeds it yet -- /routes/plan costs geometry and distance
// out of the road graph, not a maneuver list -- so what a driver sees today is
// the destination form. This is stated rather than mocked: a fabricated
// "Turn right onto NH-6" would be the one thing on this screen that is not
// coming from the 486,784-edge extract.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';
import { formatDistance, formatDuration, arrivalClock } from './RouteSummary';

/**
 * @param destination  place the truck is routed to, or null
 * @param distanceM    metres remaining on the active route
 * @param durationSec  seconds remaining, when the server costed one
 * @param rerouted     this route replaced an earlier one
 * @param instruction  { text, road, modifier } -- see the note above
 * @param onPress      opens the route sheet
 */
export default function NavCard({
  destination, distanceM, durationSec, rerouted, instruction, onPress, style,
}) {
  const hasRoute = Number.isFinite(distanceM) || Number.isFinite(durationSec);
  const durationKnown = Number.isFinite(durationSec) && durationSec >= 0;
  const eta = durationKnown ? arrivalClock(durationSec) : null;

  // The supporting line, built from whatever is actually known. A corridor
  // picked from the rail carries a distance and no duration; a reroute carries
  // both. Absent figures drop out rather than render as em-dashes.
  const meta = [];
  if (Number.isFinite(distanceM)) meta.push(formatDistance(distanceM));
  if (durationKnown) meta.push(formatDuration(durationSec));
  if (eta) meta.push(eta);

  const title = instruction?.road ?? destination?.name ?? (hasRoute ? 'On route' : 'No route set');
  const sub = instruction?.text
    ?? (meta.length > 0 ? meta.join('  ·  ') : 'Tap to plan a route');

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card, t.shadow.float, pressed && styles.pressed, style,
      ]}
      accessibilityRole="button"
      accessibilityLabel={
        (rerouted ? 'New route. ' : '')
        + (instruction?.text
          ? instruction.text
          : hasRoute
            ? `To ${destination?.name ?? 'destination'}, ${meta.join(', ')}`
            : 'No route set')}
      accessibilityHint="Opens route options"
    >
      <View style={[styles.glyph, rerouted && styles.glyphAlert]}>
        <Icon
          name={rerouted ? 'alt-route' : instruction ? 'turn-right' : 'navigation'}
          size={24}
          color={t.color.onAccent}
          importantForAccessibility="no"
        />
      </View>

      <View style={styles.text}>
        {/* The reroute flag rides above the destination rather than replacing
            it. A driver told only "NEW ROUTE" still has to ask where to. */}
        {rerouted ? <Text style={styles.flag}>NEW ROUTE</Text> : null}
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Text style={styles.sub} numberOfLines={1}>{sub}</Text>
      </View>

      <Icon name="expand-more" size={22} color={t.color.onGlassMuted}
            importantForAccessibility="no" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.color.glass,
    borderRadius: t.radius.inner + 4,
    borderWidth: t.hairline, borderColor: t.color.glassEdge,
    paddingVertical: 10, paddingHorizontal: 12,
    minHeight: t.touchMin + 8,
  },
  pressed: { backgroundColor: t.color.glassSoft },
  glyph: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: t.color.accent,
    alignItems: 'center', justifyContent: 'center',
    marginRight: t.space.md,
  },
  glyphAlert: { backgroundColor: t.color.accentPressed },
  text: { flex: 1 },
  flag: {
    fontFamily: t.font.sansMedium, fontSize: 10, fontWeight: '700',
    letterSpacing: 1.1, color: t.color.accent, marginBottom: 1,
  },
  title: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '700',
    color: t.color.onGlass,
  },
  sub: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.onGlassMuted,
    fontVariant: ['tabular-nums'], marginTop: 1,
  },
});
