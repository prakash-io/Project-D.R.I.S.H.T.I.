// "Hazard ahead. New route available." -- the offer, and the tap that takes it.
//
// This is the component that makes a reroute an OFFER rather than an
// instruction. The backend has already costed the detour and pushed it; until
// the driver taps ACCEPT the map keeps the road they chose, and the new path
// is drawn only as a dashed preview beside it.
//
// Why it is a decision and not a notification: the graph does not know the
// load is over-height for the underpass on the detour, that the "blocked" road
// is passable in a loaded 6-wheeler, or that the driver has run this valley
// for eleven years. A navigator that reroutes without asking is one the driver
// stops trusting the first time it is wrong, and after that they ignore the
// one that matters.
//
// It sits over the tab bar and dims the map behind it, because a landslide
// ahead is the only thing on the screen worth attention. It does NOT block the
// map: dismissing is one tap and the old route stays.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Button from './Button';
import { formatDistance, formatDuration } from './RouteSummary';
import { t } from './tokens';

/// The hazard, in the words the driver's alert uses. `kind` comes from the
/// incident row and may be null when the AI service was unreachable and the
/// report was stored unclassified -- which is a real state, not a bug, so it
/// gets honest wording rather than a guess at "landslide".
function hazardNoun(kind) {
  if (kind === 'landslide') return 'Landslide';
  if (kind === 'flood') return 'Flooding';
  if (kind === 'obstruction') return 'Road obstruction';
  return 'Hazard';
}

/**
 * The delta line -- "+3.4 km · 12 min longer".
 *
 * Returns null when there is nothing honest to say. previous_time_sec is null
 * for a trip planned before the server started storing its costing, and
 * inventing a comparison there would put a fabricated "+40 min" in front of a
 * driver deciding whether to take a mountain detour at night.
 */
function deltaLine(deltaDistanceM, deltaTimeSec) {
  const parts = [];
  if (Number.isFinite(deltaDistanceM) && Math.abs(deltaDistanceM) >= 50) {
    parts.push(`${deltaDistanceM > 0 ? '+' : '−'}${formatDistance(Math.abs(deltaDistanceM))}`);
  }
  if (Number.isFinite(deltaTimeSec) && Math.abs(deltaTimeSec) >= 60) {
    parts.push(`${formatDuration(Math.abs(deltaTimeSec))} ${deltaTimeSec > 0 ? 'longer' : 'shorter'}`);
  }
  // Both figures known and both negligible is itself worth saying: "about the
  // same" is the answer that makes the decision easy.
  if (parts.length === 0) {
    return (Number.isFinite(deltaDistanceM) || Number.isFinite(deltaTimeSec))
      ? 'About the same as your current route' : null;
  }
  return parts.join(' · ');
}

/**
 * @param proposal  { distanceM, durationSec, deltaDistanceM, deltaTimeSec, kind }
 *                  null hides the sheet entirely
 * @param busy      the accept is in flight
 * @param onAccept  () => void   switch the map to the new path
 * @param onKeep    () => void   decline; the current route stands
 */
export default function RerouteSheet({ proposal, busy, onAccept, onKeep }) {
  if (!proposal) return null;

  const delta = deltaLine(proposal.deltaDistanceM, proposal.deltaTimeSec);

  return (
    <View style={styles.scrim} pointerEvents="box-none">
      <View
        style={[styles.sheet, t.shadow.card]}
        accessibilityViewIsModal
        accessibilityLiveRegion="assertive"
      >
        <View style={styles.grabber} importantForAccessibility="no" />

        <View style={styles.head}>
          <View style={styles.badge}>
            <Icon name="warning" size={20} color={t.color.alertText}
                  importantForAccessibility="no" />
          </View>
          <View style={styles.headText}>
            <Text style={styles.kicker}>{hazardNoun(proposal.kind).toUpperCase()} AHEAD</Text>
            <Text style={styles.title}>New route available</Text>
          </View>
        </View>

        {/* The two figures the driver decides on, in the order they ask for
            them: how long, then how far. Same ordering and same type scale as
            RouteSummary, so the offer is directly comparable to the card
            showing the route it would replace. */}
        <View style={styles.figures}>
          <Text style={styles.duration}>{formatDuration(proposal.durationSec)}</Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.distance}>{formatDistance(proposal.distanceM)}</Text>
        </View>

        {delta ? <Text style={styles.delta}>{delta}</Text> : null}

        <Button
          label="Accept reroute"
          icon="alt-route"
          size="md"
          onPress={onAccept}
          disabled={busy}
          style={styles.accept}
          accessibilityHint="Switches the map to the new route"
        />

        <Pressable
          onPress={onKeep}
          disabled={busy}
          style={({ pressed }) => [styles.keep, pressed && styles.keepPressed]}
          accessibilityRole="button"
          accessibilityLabel="Keep current route"
          accessibilityHint="Dismisses the offer; you stay on the road ahead"
        >
          <Text style={styles.keepLabel}>Keep current route</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Dims the map without capturing taps outside the sheet: the driver can
  // still pan to look at what is ahead while deciding.
  scrim: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(11, 18, 32, 0.28)',
  },
  sheet: {
    backgroundColor: t.color.bgPanel,
    borderTopLeftRadius: t.radius.card,
    borderTopRightRadius: t.radius.card,
    paddingHorizontal: t.space.xl,
    paddingTop: t.space.md,
    paddingBottom: t.space.xl,
  },
  grabber: {
    alignSelf: 'center',
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: t.color.border,
    marginBottom: t.space.lg,
  },
  head: { flexDirection: 'row', alignItems: 'center' },
  badge: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.color.alertWash,
  },
  headText: { flex: 1, marginLeft: t.space.lg },
  kicker: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 1.2, color: t.color.alertText,
  },
  title: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '700',
    color: t.color.textPrimary, marginTop: 2,
  },
  figures: {
    flexDirection: 'row', alignItems: 'baseline',
    marginTop: t.space.lg,
  },
  duration: {
    fontFamily: t.font.sansMedium, fontSize: t.type.head, fontWeight: '700',
    color: t.color.textPrimary, fontVariant: ['tabular-nums'],
  },
  dot: { color: t.color.textMuted, marginHorizontal: t.space.sm, fontSize: t.type.title },
  distance: {
    fontFamily: t.font.sansMedium, fontSize: t.type.title, fontWeight: '600',
    color: t.color.textSecondary, fontVariant: ['tabular-nums'],
  },
  delta: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    marginTop: t.space.xs,
  },
  accept: { marginTop: t.space.lg },
  keep: {
    minHeight: t.touchMin,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: t.radius.pill,
    marginTop: t.space.sm,
  },
  keepPressed: { backgroundColor: t.color.bgInset },
  keepLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.body, fontWeight: '600',
    color: t.color.textSecondary,
  },
});
