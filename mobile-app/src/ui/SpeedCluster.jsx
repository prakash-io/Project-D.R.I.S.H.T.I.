// The instrument cluster (MOB-01, MOB-06).
//
// One enormous number, because at 60 km/h on a NER valley road the driver has
// well under a second to read it. Everything else on this screen is secondary
// to the speed and to where the speed came from.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t } from './tokens';

/** GNSS vs dead reckoning, in colour AND in words. This distinction is the
 *  entire product; it is never encoded by colour alone. */
function SourceChip({ source }) {
  const dr = source === 'ekf';
  const tone = dr ? t.color.sourceDeadReckoning : t.color.sourceGnss;
  return (
    <View style={[styles.chip, { borderColor: tone }]}>
      <Text style={[styles.chipText, { color: tone }]}>
        {dr ? 'DEAD RECKONING' : 'GNSS FIX'}
      </Text>
    </View>
  );
}

export default function SpeedCluster({ fix, hud }) {
  // speed_mps from the edge engine, speed from react-native-geolocation.
  const mps = fix ? (fix.speed_mps ?? fix.speedMps ?? fix.speed ?? 0) : null;
  const kmh = mps == null ? null : mps * 3.6;
  const heading = fix ? (fix.heading_deg ?? fix.headingDeg ?? fix.heading ?? null) : null;

  return (
    <View style={[styles.wrap, hud && styles.hudSurface]}>
      <View style={styles.headRow}>
        <Text style={styles.caption}>GROUND SPEED</Text>
        {fix ? <SourceChip source={fix.source} /> : null}
      </View>

      <View style={styles.readoutRow}>
        <Text
          style={styles.hero}
          maxFontSizeMultiplier={1.2}
          accessibilityLabel={kmh == null ? 'Speed unavailable' : `${kmh.toFixed(0)} kilometres per hour`}
        >
          {kmh == null ? '––' : kmh.toFixed(0)}
        </Text>
        <View style={styles.units}>
          <Text style={styles.unit}>KM/H</Text>
          <Text style={styles.unitSub}>
            {mps == null ? '–' : mps.toFixed(1)} m/s
          </Text>
        </View>
      </View>

      <View style={styles.headingRow}>
        <Text style={styles.caption}>HEADING</Text>
        <Text style={styles.headingValue}>
          {heading == null ? '–––' : `${Math.round(heading).toString().padStart(3, '0')}°`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({

  // HUD variant: the panel floats over the live map.
  //
  // OPAQUE, not translucent. Every ratio in tokens.js was measured against
  // the solid #0F0F0F panel; any alpha composites that surface against
  // whatever tile happens to be underneath, so the measured numbers stop
  // being true and vary with the terrain. The map is muted at the source
  // instead (see MapCanvas NIGHT/DAY_RASTER), which buys the same visual
  // separation without putting the readout's legibility on a moving target.
  hudSurface: {
    backgroundColor: t.color.bgPanel,
    borderBottomColor: t.color.border,
  },
  wrap: {
    backgroundColor: t.color.bgPanel,
    borderBottomWidth: t.hairline,
    borderBottomColor: t.color.border,
    paddingHorizontal: t.space.lg,
    paddingTop: t.space.lg,
    paddingBottom: t.space.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  caption: {
    fontFamily: t.font.mono, fontSize: t.type.micro, letterSpacing: 1.6,
    color: t.color.textMuted,
  },
  chip: { borderWidth: t.hairline, paddingHorizontal: t.space.sm, paddingVertical: 3 },
  chipText: { fontFamily: t.font.mono, fontSize: t.type.micro, letterSpacing: 1.2 },

  readoutRow: { flexDirection: 'row', alignItems: 'flex-end', marginTop: t.space.sm },
  hero: {
    fontFamily: t.font.mono,
    fontSize: t.type.hero,
    lineHeight: t.type.hero,
    fontWeight: '700',
    // Section 3.1: crushed tracking welds the glyphs into one block.
    letterSpacing: -4,
    color: t.color.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  units: { marginLeft: t.space.md, paddingBottom: t.space.sm },
  unit: {
    fontFamily: t.font.mono, fontSize: t.type.body, letterSpacing: 1.5,
    color: t.color.textSecondary,
  },
  unitSub: {
    fontFamily: t.font.mono, fontSize: t.type.meta, color: t.color.textMuted,
    fontVariant: ['tabular-nums'],
  },

  headingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: t.space.md, borderTopWidth: t.hairline, borderTopColor: t.color.border,
    paddingTop: t.space.sm,
  },
  headingValue: {
    fontFamily: t.font.mono, fontSize: t.type.lead, color: t.color.textPrimary,
    fontVariant: ['tabular-nums'], letterSpacing: 1,
  },
});
