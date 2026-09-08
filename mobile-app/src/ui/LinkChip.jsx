// The connection chip -- one small pill, top right of the map.
//
// Replaces the LIVE LINK badge that used to sit inside a full-width white
// speed card. The status itself is not negotiable: a driver whose telemetry
// has stopped reaching dispatch is, from dispatch's point of view, missing.
// What was negotiable was the 340pt of glass it took to say so.
//
// One line, one dot, one word. Five states, and the word always carries the
// meaning -- colour is a second channel, never the only one, because the cab
// may be in full sun and the driver may be colour-blind.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t } from './tokens';

/**
 * Resolve the chip from the three signals the app already holds. Order is
 * deliberate: dead reckoning outranks everything, because a driver whose
 * position is being propagated by the EKF needs to know that before they need
 * to know the socket is fine.
 *
 * @param mode    tracker mode: starting | online | dark-zone | degraded
 * @param linkUp  socket connected
 * @param queued  telemetry rows waiting in WatermelonDB
 */
export function linkState({ mode, linkUp, queued }) {
  if (mode === 'dark-zone') return { label: 'DEAD RECK', tone: t.color.sourceDeadReckoning };
  if (mode === 'degraded') return { label: 'NO FIX', tone: t.color.alertFill };
  if (mode === 'starting') return { label: 'ACQUIRING', tone: t.color.textMuted };
  // Up, but carrying a backlog: the burst sync is draining what the dark zone
  // banked. Distinct from LIVE, because the two look identical on the map and
  // only one of them means dispatch has the whole track.
  if (linkUp && queued > 0) return { label: 'SYNCING', tone: t.color.warnText };
  if (linkUp) return { label: 'LIVE', tone: t.color.linkUp };
  // Fixes are still arriving, so the receiver and the service are alive and
  // it is only the socket that dropped -- socket.io is already retrying.
  if (mode === 'online') return { label: 'RECONNECTING', tone: t.color.warnText };
  return { label: 'OFFLINE', tone: t.color.alertFill };
}

export default function LinkChip({ mode, linkUp, queued, style }) {
  const s = linkState({ mode, linkUp, queued });
  return (
    <View
      style={[styles.chip, t.shadow.float, style]}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Dispatch link ${s.label.toLowerCase()}`}
    >
      <View style={[styles.dot, { backgroundColor: s.tone }]} />
      <Text style={styles.label} numberOfLines={1}>{s.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.color.glass,
    borderRadius: t.radius.pill,
    borderWidth: t.hairline, borderColor: t.color.glassEdge,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  label: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.9, color: t.color.onGlass,
  },
});
