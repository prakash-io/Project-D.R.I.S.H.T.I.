// SYNC tab — System Diagnostics and Recent Logs.
//
// Every row here is measured, never assumed. "LAST SYNC" is the real time of
// the last acknowledged drain, and the queue depth is a count from
// WatermelonDB -- if this screen cannot prove a value it says so rather than
// showing a comforting default.
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Card, StatusPill, IconBadge } from './Card';
import { t } from './tokens';

function Row({ icon, tone, wash, label, value, pillLabel, last }) {
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <IconBadge name={icon} tone={tone} wash={wash} />
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
      {pillLabel ? <StatusPill label={pillLabel} tone={tone} wash={wash} /> : null}
    </View>
  );
}

const LEVEL = {
  ERR: { tone: t.color.alertText },
  WARN: { tone: t.color.warnText },
  INFO: { tone: t.color.okText },
};

export default function DiagnosticsScreen({
  mode, linkUp, fix, queued, hazardQueued, lastSyncAt, logs, onClearLogs,
}) {
  const gnss = fix
    ? { value: fix.source === 'ekf' ? 'Dead-reckoned' : 'Optimal Fix (3D)',
        pill: fix.source === 'ekf' ? 'ESTIMATED' : 'ACTIVE',
        tone: fix.source === 'ekf' ? t.color.warnText : t.color.okText,
        wash: fix.source === 'ekf' ? t.color.warnWash : t.color.okWash,
        icon: fix.source === 'ekf' ? 'timeline' : 'gps-fixed' }
    : { value: 'No fix', pill: 'SEARCHING', tone: t.color.textMuted,
        wash: t.color.bgInset, icon: 'gps-not-fixed' };

  const link = linkUp
    ? { value: 'Connected', pill: 'ACTIVE', tone: t.color.okText,
        wash: t.color.okWash, icon: 'wifi-tethering' }
    : { value: mode === 'dark-zone' ? 'Dead Reckoning' : 'Disconnected',
        pill: 'DEGRADED', tone: t.color.warnText, wash: t.color.warnWash,
        icon: 'wifi-tethering-off' };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Card style={styles.section}>
        <Text style={styles.heading}>System Diagnostics</Text>

        <Row icon={gnss.icon} tone={gnss.tone} wash={gnss.wash}
             label="GNSS STATUS" value={gnss.value} pillLabel={gnss.pill} />

        <Row icon={link.icon} tone={link.tone} wash={link.wash}
             label="NETWORK LINK" value={link.value} pillLabel={link.pill} />

        <Row icon="history" tone={t.color.textMuted} wash={t.color.bgInset}
             label="LAST SYNC" value={relativeTime(lastSyncAt)} last />
      </Card>

      <Card style={styles.section}>
        <Text style={styles.heading}>Queued On Device</Text>
        <View style={styles.queueRow}>
          <View style={styles.queueCell}>
            <Text style={styles.queueValue}>{queued}</Text>
            <Text style={styles.queueLabel}>TELEMETRY POINTS</Text>
          </View>
          <View style={styles.queueDivider} />
          <View style={styles.queueCell}>
            <Text style={styles.queueValue}>{hazardQueued}</Text>
            <Text style={styles.queueLabel}>HAZARD REPORTS</Text>
          </View>
        </View>
        <Text style={styles.queueNote}>
          {queued + hazardQueued === 0
            ? 'Nothing held — everything acknowledged by dispatch.'
            : linkUp
              ? 'Draining to dispatch now.'
              : 'Held locally until the link returns. Nothing is lost.'}
        </Text>
      </Card>

      <Card style={styles.section}>
        <View style={styles.logHead}>
          <Text style={styles.heading}>Recent Logs</Text>
          <Pressable
            onPress={onClearLogs}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Clear all logs"
          >
            <Text style={styles.clear}>CLEAR ALL</Text>
          </Pressable>
        </View>

        {logs.length === 0 ? (
          <Text style={styles.empty}>No events recorded this session.</Text>
        ) : logs.map((entry, i) => (
          <View key={entry.id} style={[styles.log, i === logs.length - 1 && styles.rowLast]}>
            <View style={styles.logHeadRow}>
              <Text style={[styles.logLevel, { color: (LEVEL[entry.level] ?? LEVEL.INFO).tone }]}>
                {entry.level}: {entry.code}
              </Text>
              <Text style={styles.logTime}>{entry.time}</Text>
            </View>
            <Text style={styles.logBody}>{entry.message}</Text>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

/// Never "just now" when it has never happened -- an unsynced device must not
/// read like a freshly synced one.
function relativeTime(at) {
  if (!at) return 'Never';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'Just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: t.space.lg, paddingBottom: t.space.xxl },
  section: { marginBottom: t.space.lg },
  heading: {
    fontFamily: t.font.sansMedium, fontSize: t.type.title, fontWeight: '700',
    color: t.color.textPrimary, marginBottom: t.space.md,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: t.space.md,
    borderBottomWidth: t.hairline, borderBottomColor: t.color.border,
  },
  rowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  rowBody: { flex: 1, marginLeft: t.space.md, marginRight: t.space.sm },
  rowLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '600',
    letterSpacing: 1.1, color: t.color.textMuted,
  },
  rowValue: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '700',
    color: t.color.textPrimary, marginTop: 1,
  },
  queueRow: { flexDirection: 'row', alignItems: 'center' },
  queueCell: { flex: 1, alignItems: 'center' },
  queueDivider: { width: t.hairline, height: 40, backgroundColor: t.color.border },
  queueValue: {
    fontFamily: t.font.sansMedium, fontSize: t.type.head, fontWeight: '800',
    color: t.color.textPrimary, fontVariant: ['tabular-nums'],
  },
  queueLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '600',
    letterSpacing: 1, color: t.color.textMuted, marginTop: 2,
  },
  queueNote: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    marginTop: t.space.md, lineHeight: 20,
  },
  logHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: t.space.sm,
  },
  clear: {
    fontFamily: t.font.sansMedium, fontSize: t.type.meta, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.accentText,
  },
  empty: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textMuted,
  },
  log: {
    paddingVertical: t.space.md,
    borderBottomWidth: t.hairline, borderBottomColor: t.color.border,
  },
  logHeadRow: { flexDirection: 'row', justifyContent: 'space-between' },
  logLevel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.meta, fontWeight: '700',
    letterSpacing: 0.4,
  },
  logTime: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textMuted,
    fontVariant: ['tabular-nums'],
  },
  logBody: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    marginTop: 3, lineHeight: 19,
  },
});
