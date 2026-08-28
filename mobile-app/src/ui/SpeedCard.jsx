// The floating speed card on the map screen.
//
// Speed is the one number read at speed, so it is the largest thing on the
// glass. The mode pill sits with it because the two are one thought:
// "42 km/h, and that number came from dead reckoning, not a satellite."
//
// Two shapes, one component. The FULL card is what the HUD-style layout used
// when this sat alone at the top of the map. The COMPACT pill is what the
// Google-Maps layout uses: the top of the screen is the Source/Destination
// card now, so speed moved to the bottom-left corner -- which is where every
// navigation app puts it, and where the driver's eye already goes for it.
//
// Compact is not merely "the same card, smaller". It shows the mode pill only
// when the mode is worth interrupting for. In normal operation "LIVE LINK" is
// a label restating what the absence of a warning already says, and spending
// a permanent row on it is how a screen fills up with things nobody reads.
// The moment the truck drops into dead reckoning -- or fails to -- the pill
// appears. Alert on the exception, stay quiet on the norm.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Card, StatusPill } from './Card';
import { t, modePresentation } from './tokens';

const MS_TO_KMH = 3.6;

/// Fixes arrive at 1 Hz online and 10 Hz while dead reckoning. Three seconds
/// without one is already several vehicle-lengths of unaccounted movement.
const STALE_AFTER_MS = 3000;

/// The one mode that needs no announcement. Everything else -- acquiring,
/// dark-zone, degraded -- is a state the driver has to know about.
const QUIET_MODES = new Set(['online']);

export default function SpeedCard({ fix, mode, ageMs, compact, style }) {
  const m = modePresentation(mode);
  const stale = Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;
  const seconds = Math.floor((ageMs ?? 0) / 1000);

  const mps = fix?.speed ?? fix?.speed_mps ?? fix?.speedMps;
  const kmh = Number.isFinite(mps) ? Math.round(mps * MS_TO_KMH) : null;

  // A stale readout always shows the mode, whatever the mode is: "LIVE LINK"
  // above "NOT CURRENT" is the contradiction that tells the driver the link
  // is up and the fixes still stopped, which is a different fault from a
  // dark zone and has to be readable as one.
  const showMode = !compact || stale || !QUIET_MODES.has(mode);

  return (
    <Card style={[compact ? styles.cardCompact : styles.card, style]}>
      <View style={styles.speedRow}>
        <Text
          style={compact ? styles.speedCompact : styles.speed}
          accessibilityLabel={kmh == null
            ? 'Ground speed unavailable'
            : `Ground speed ${kmh} kilometres per hour`}
        >
          {kmh == null ? '--' : kmh}
        </Text>
        <Text style={compact ? styles.unitCompact : styles.unit}>KM/H</Text>
      </View>

      {showMode ? (
        <StatusPill label={m.label} tone={m.tone} wash={m.wash} icon={m.icon}
                    style={compact ? styles.pillCompact : styles.pill} />
      ) : null}

      {/* A speed with no age reads as "now" forever. When the fixes stop --
          GNSS lost, sensors wedged, the engine stalled -- the last one sits
          here looking live, which is the most dangerous thing this card could
          imply. Stated in words, not by colour alone. */}
      {stale ? (
        <Text style={styles.stale} accessibilityLiveRegion="polite">
          NOT CURRENT · LAST FIX {seconds}s AGO
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', paddingVertical: t.space.md },
  cardCompact: {
    // alignSelf, not just alignItems: the pill has to shrink to its content
    // inside a full-width bottom stack rather than stretching across it.
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
    paddingVertical: t.space.sm,
    paddingHorizontal: t.space.md,
  },
  speedRow: { flexDirection: 'row', alignItems: 'baseline' },
  speed: {
    fontFamily: t.font.sansMedium, fontSize: t.type.hero, fontWeight: '800',
    color: t.color.textPrimary, letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  speedCompact: {
    fontFamily: t.font.sansMedium, fontSize: t.type.head, fontWeight: '800',
    color: t.color.textPrimary, letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  unit: {
    fontFamily: t.font.sansMedium, fontSize: t.type.body, fontWeight: '700',
    color: t.color.textSecondary, marginLeft: 6,
  },
  unitCompact: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    color: t.color.textSecondary, marginLeft: 5, letterSpacing: 0.6,
  },
  pill: { marginTop: t.space.sm, alignSelf: 'center' },
  pillCompact: { marginTop: 6, alignSelf: 'flex-start' },
  stale: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.alertText, marginTop: t.space.sm,
  },
});
