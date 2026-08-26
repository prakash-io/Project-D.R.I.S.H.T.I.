// Position and its provenance (MOB-06).
//
// Deliberately NOT a map. The device has no route geometry to draw -- the
// backend's route_updated payload is consumed for its distance only, and there
// is no map renderer in this project's dependencies. Rather than fake a
// route line, this shows the four numbers that are actually known, including
// the two that only exist while dead reckoning: the uncertainty radius and
// whether the last fix was snapped to the cached road graph.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t } from './tokens';

function Row({ label, value, tone, mono = true }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, tone ? { color: tone } : null, mono ? styles.mono : null]}>
        {value}
      </Text>
    </View>
  );
}

export default function PositionReadout({ fix }) {
  if (!fix) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.caption}>POSITION</Text>
        <View style={styles.empty}>
          <Text style={styles.emptyGlyph}>+</Text>
          <Text style={styles.emptyText}>NO FIX YET</Text>
        </View>
      </View>
    );
  }

  const dr = fix.source === 'ekf';
  // Only meaningful while dead reckoning; a GNSS fix carries no covariance here.
  const cov = fix.covariance_m2 ?? fix.covarianceM2 ?? 0;
  const sigma = cov ? Math.sqrt(cov) : null;
  const matched = Boolean(fix.map_matched ?? fix.mapMatched);

  return (
    <View style={styles.wrap}>
      <Text style={styles.caption}>POSITION</Text>

      <Text style={styles.coord} accessibilityLabel={
        `Latitude ${fix.latitude.toFixed(5)}, longitude ${fix.longitude.toFixed(5)}`}>
        {fix.latitude.toFixed(6)}, {fix.longitude.toFixed(6)}
      </Text>

      <View style={styles.rows}>
        {sigma != null && (
          <Row
            label="UNCERTAINTY"
            value={`±${sigma.toFixed(0)} m`}
            tone={t.color.sourceDeadReckoning}
          />
        )}
        {dr && (
          <Row
            label="MAP MATCH"
            value={matched ? 'SNAPPED TO ROAD' : 'FREE RUNNING'}
            tone={matched ? t.color.linkUp : t.color.sourceDeadReckoning}
          />
        )}
        {matched && (fix.matched_edge_id ?? fix.matchedEdgeId) != null && (
          <Row label="EDGE" value={String(fix.matched_edge_id ?? fix.matchedEdgeId)} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: t.color.bgPanel,
    borderBottomWidth: t.hairline,
    borderBottomColor: t.color.border,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
  },
  caption: {
    fontFamily: t.font.mono, fontSize: t.type.micro, letterSpacing: 1.6,
    color: t.color.textMuted,
  },
  coord: {
    fontFamily: t.font.mono, fontSize: t.type.title, color: t.color.textPrimary,
    fontVariant: ['tabular-nums'], letterSpacing: -0.5, marginTop: t.space.sm,
  },
  rows: { marginTop: t.space.md },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderTopWidth: t.hairline, borderTopColor: t.color.border,
    paddingVertical: t.space.sm,
  },
  label: {
    fontFamily: t.font.mono, fontSize: t.type.micro, letterSpacing: 1.4,
    color: t.color.textMuted,
  },
  value: { fontSize: t.type.body, color: t.color.textSecondary },
  mono: { fontFamily: t.font.mono, fontVariant: ['tabular-nums'], letterSpacing: 1 },

  empty: { alignItems: 'center', paddingVertical: t.space.xl },
  emptyGlyph: { fontFamily: t.font.mono, fontSize: t.type.title, color: t.color.borderActive },
  emptyText: {
    fontFamily: t.font.mono, fontSize: t.type.meta, letterSpacing: 1.6,
    color: t.color.textMuted, marginTop: t.space.sm,
  },
});
