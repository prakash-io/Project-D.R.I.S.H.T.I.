// The floating speed card at the top of the map (home screen).
//
// Speed is the one number read at speed, so it is the largest thing on the
// glass. The mode pill sits directly under it because the two are one thought:
// "42 km/h, and that number came from dead reckoning, not a satellite."
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Card, StatusPill } from './Card';
import { t, modePresentation } from './tokens';

const MS_TO_KMH = 3.6;

/// Fixes arrive at 1 Hz online and 10 Hz while dead reckoning. Three seconds
/// without one is already several vehicle-lengths of unaccounted movement.
const STALE_AFTER_MS = 3000;

export default function SpeedCard({ fix, mode, ageMs, style }) {
  const m = modePresentation(mode);
  const stale = Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;
  const seconds = Math.floor((ageMs ?? 0) / 1000);

  const mps = fix?.speed ?? fix?.speed_mps ?? fix?.speedMps;
  const kmh = Number.isFinite(mps) ? Math.round(mps * MS_TO_KMH) : null;

  return (
    <Card style={[styles.card, style]}>
      <View style={styles.speedRow}>
        <Text
          style={styles.speed}
          accessibilityLabel={kmh == null
            ? 'Ground speed unavailable'
            : `Ground speed ${kmh} kilometres per hour`}
        >
          {kmh == null ? '--' : kmh}
        </Text>
        <Text style={styles.unit}>KM/H</Text>
      </View>

      <StatusPill label={m.label} tone={m.tone} wash={m.wash} icon={m.icon}
                  style={styles.pill} />

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
  speedRow: { flexDirection: 'row', alignItems: 'baseline' },
  speed: {
    fontFamily: t.font.sansMedium, fontSize: t.type.hero, fontWeight: '800',
    color: t.color.textPrimary, letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  unit: {
    fontFamily: t.font.sansMedium, fontSize: t.type.body, fontWeight: '700',
    color: t.color.textSecondary, marginLeft: 6,
  },
  pill: { marginTop: t.space.sm, alignSelf: 'center' },
  stale: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.alertText, marginTop: t.space.sm,
  },
});
