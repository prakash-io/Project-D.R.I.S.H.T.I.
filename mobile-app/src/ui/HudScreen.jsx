// HUD tab — the full telemetry readout.
//
// The MAP tab shows only what can be read at a glance while moving. This is
// the same data at rest: everything the edge engine actually knows, including
// the two figures that exist only while dead reckoning (the uncertainty radius
// and whether the fix was snapped to the cached road graph).
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Card, Stat, StatusPill, IconBadge } from './Card';
import { t, modePresentation } from './tokens';

const MS_TO_KMH = 3.6;
const STALE_AFTER_MS = 3000;

export default function HudScreen({ fix, mode, linkUp, ageMs }) {
  const m = modePresentation(mode);
  const stale = Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;
  const seconds = Math.floor((ageMs ?? 0) / 1000);

  const mps = fix?.speed ?? fix?.speed_mps ?? fix?.speedMps;
  const kmh = Number.isFinite(mps) ? (mps * MS_TO_KMH) : null;
  const heading = fix?.heading ?? fix?.heading_deg ?? fix?.headingDeg;
  const dr = fix?.source === 'ekf';
  const cov = fix?.covariance_m2 ?? fix?.covarianceM2 ?? 0;
  const sigma = cov ? Math.sqrt(cov) : null;
  const matched = Boolean(fix?.map_matched ?? fix?.mapMatched);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        <View style={styles.headRow}>
          <IconBadge name={m.icon} tone={m.tone} wash={m.wash} />
          <View style={styles.headBody}>
            <Text style={styles.headLabel}>STATUS</Text>
            <Text style={styles.headValue}>{m.note}</Text>
          </View>
          <StatusPill
            label={linkUp ? 'LINK UP' : 'LINK DOWN'}
            tone={linkUp ? t.color.okText : t.color.alertText}
            wash={linkUp ? t.color.okWash : t.color.alertWash}
            icon={linkUp ? 'cloud-done' : 'cloud-off'}
          />
        </View>

        {stale ? (
          <View style={styles.staleBand} accessibilityLiveRegion="polite">
            <Text style={styles.staleText}>
              NOT CURRENT · LAST FIX {seconds}s AGO
            </Text>
          </View>
        ) : null}
      </Card>

      <Card style={styles.card}>
        <Text style={styles.section}>Motion</Text>
        <View style={styles.grid}>
          <Stat label="GROUND SPEED" unit="km/h"
                value={kmh == null ? '—' : kmh.toFixed(1)}
                style={styles.cell}
                accessibilityLabel={kmh == null
                  ? 'Ground speed unavailable'
                  : `Ground speed ${kmh.toFixed(1)} kilometres per hour`} />
          <Stat label="BEARING" unit="°"
                value={Number.isFinite(heading) ? pad3(heading) : '—'}
                style={styles.cell} />
        </View>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.section}>Position</Text>
        {fix ? (
          <>
            <Text
              style={[styles.coord, stale && styles.coordStale]}
              accessibilityLabel={
                `Latitude ${fix.latitude.toFixed(5)}, longitude ${fix.longitude.toFixed(5)}`}
            >
              {fix.latitude.toFixed(6)}, {fix.longitude.toFixed(6)}
            </Text>
            <View style={styles.chips}>
              <StatusPill
                label={dr ? 'DEAD RECKONED' : 'GNSS FIX'}
                tone={dr ? t.color.sourceDeadReckoning : t.color.sourceGnss}
                wash={dr ? t.color.warnWash : '#E8F0FE'}
                icon={dr ? 'timeline' : 'gps-fixed'}
              />
              {sigma != null ? (
                <StatusPill
                  label={`±${sigma.toFixed(0)} M`}
                  tone={t.color.textMuted} wash={t.color.bgInset}
                  icon="blur-circular" style={styles.chipGap}
                />
              ) : null}
              {dr ? (
                <StatusPill
                  label={matched ? 'SNAPPED TO ROAD' : 'UNMATCHED'}
                  tone={matched ? t.color.okText : t.color.textMuted}
                  wash={matched ? t.color.okWash : t.color.bgInset}
                  icon={matched ? 'route' : 'help-outline'} style={styles.chipGap}
                />
              ) : null}
            </View>
          </>
        ) : (
          <Text style={styles.empty}>No fix yet — acquiring satellites.</Text>
        )}
      </Card>
    </ScrollView>
  );
}

/// 007°, not 7° — a bearing is always three digits on an instrument.
function pad3(n) {
  return String(Math.round(n)).padStart(3, '0');
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: t.space.lg, paddingBottom: t.space.xxl },
  card: { marginBottom: t.space.lg },
  headRow: { flexDirection: 'row', alignItems: 'center' },
  headBody: { flex: 1, marginLeft: t.space.md, marginRight: t.space.sm },
  headLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '600',
    letterSpacing: 1.1, color: t.color.textMuted,
  },
  headValue: {
    fontFamily: t.font.sansMedium, fontSize: t.type.body, fontWeight: '700',
    color: t.color.textPrimary, marginTop: 1,
  },
  staleBand: {
    marginTop: t.space.md,
    backgroundColor: t.color.alertWash,
    borderRadius: t.radius.chip,
    paddingHorizontal: t.space.md, paddingVertical: t.space.sm,
  },
  staleText: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.alertText,
  },
  section: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '700',
    color: t.color.textPrimary, marginBottom: t.space.md,
  },
  grid: { flexDirection: 'row' },
  cell: { flex: 1 },
  coord: {
    fontFamily: t.font.sansMedium, fontSize: t.type.title, fontWeight: '700',
    color: t.color.textPrimary, fontVariant: ['tabular-nums'],
  },
  coordStale: { color: t.color.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: t.space.md },
  chipGap: { marginLeft: t.space.sm },
  empty: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textMuted,
  },
});
