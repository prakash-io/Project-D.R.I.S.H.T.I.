// Ground speed, as a small circle in the bottom-left corner of the map.
//
// The speed used to be 44pt type in a full-width white card pinned across the
// top of the screen -- the single largest thing on a navigation display, for a
// number the driver already has on the dashboard in front of them. It is
// useful, so it stays; it is not the point of the screen, so it shrinks.
//
// SpeedCard, the card it replaces, is left in src/ui/ unmounted alongside the
// other superseded surfaces. It still holds the staleness rule this bubble
// inherits, and the HUD tab is where an instrument-panel reading of the same
// fix would belong if one is wanted back.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t } from './tokens';

const MS_TO_KMH = 3.6;

/// Fixes arrive at 1 Hz online and 10 Hz while dead reckoning. Three seconds
/// without one is already several vehicle-lengths of unaccounted movement.
const STALE_AFTER_MS = 3000;

export default function SpeedBubble({ fix, mode, ageMs, style }) {
  const stale = Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;
  const seconds = Math.floor((ageMs ?? 0) / 1000);

  const mps = fix?.speed ?? fix?.speed_mps ?? fix?.speedMps;
  const kmh = Number.isFinite(mps) ? Math.round(mps * MS_TO_KMH) : null;

  // The ring is the second channel. Amber while the position is coming from
  // the EKF rather than a satellite, red once the fixes have stopped
  // altogether -- the state where the number on the glass is a lie about now.
  const ring = stale ? t.color.alertFill
    : mode === 'dark-zone' ? t.color.sourceDeadReckoning
      : t.color.glassEdge;

  return (
    <View
      style={[styles.bubble, t.shadow.float, { borderColor: ring }, style]}
      accessibilityLabel={kmh == null
        ? 'Ground speed unavailable'
        : `Ground speed ${kmh} kilometres per hour${stale ? `, last fix ${seconds} seconds ago` : ''}`}
    >
      <Text style={styles.value}>{kmh == null ? '--' : kmh}</Text>
      {/* A speed with no age reads as "now" forever. When the fixes stop the
          last one sits here looking live, which is the most dangerous thing
          this bubble could imply -- so the unit line is given over to saying
          so, in words, for as long as it is true. */}
      <Text style={[styles.unit, stale && styles.unitStale]} numberOfLines={1}>
        {stale ? `${seconds}s OLD` : 'km/h'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    width: 66, height: 66, borderRadius: 33,
    backgroundColor: t.color.glass,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  value: {
    fontFamily: t.font.sansMedium, fontSize: t.type.title, fontWeight: '800',
    color: t.color.onGlass, letterSpacing: -0.5,
    fontVariant: ['tabular-nums'], lineHeight: 25,
  },
  unit: {
    fontFamily: t.font.sans, fontSize: 10, fontWeight: '600',
    color: t.color.onGlassMuted, marginTop: 1,
  },
  unitStale: { color: t.color.alertFill, fontWeight: '700' },
});
