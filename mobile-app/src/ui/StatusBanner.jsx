// Network / mode indicator (MOB-03).
//
// The single most safety-relevant element in the app: it says whether the
// position below it came from a satellite or from an estimate. It is a full
// bleed band rather than a chip because the driver must catch it peripherally,
// without looking for it.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t, modePresentation } from './tokens';

export default function StatusBanner({ mode, connected }) {
  const m = modePresentation(mode);

  return (
    <View
      style={[styles.band, { borderLeftColor: m.tone }]}
      accessibilityRole="header"
      // Announce the transition -- a driver whose eyes are on the road needs
      // to hear that the link dropped, not discover it later.
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Mode ${m.label}. ${m.note}.`}
    >
      <View style={styles.row}>
        <Text style={[styles.glyph, { color: m.tone }]} accessibilityElementsHidden>
          {m.glyph}
        </Text>
        <Text style={[styles.label, { color: m.tone }]}>{m.label}</Text>
        <View style={styles.spacer} />
        <View style={[styles.dot, { backgroundColor: connected ? t.color.linkUp : t.color.alertFill }]} />
        <Text style={styles.link}>{connected ? 'LINK UP' : 'LINK DOWN'}</Text>
      </View>
      <Text style={styles.note}>{m.note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    backgroundColor: t.color.bgPanel,
    borderLeftWidth: 4,
    borderBottomWidth: t.hairline,
    borderBottomColor: t.color.border,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  glyph: { fontFamily: t.font.mono, fontSize: t.type.body, marginRight: t.space.sm },
  label: {
    fontFamily: t.font.mono, fontSize: t.type.lead, fontWeight: '700',
    letterSpacing: 2,
  },
  spacer: { flex: 1 },
  dot: { width: 8, height: 8, marginRight: t.space.sm },
  link: {
    fontFamily: t.font.mono, fontSize: t.type.micro, letterSpacing: 1.4,
    color: t.color.textMuted,
  },
  note: {
    fontFamily: t.font.mono, fontSize: t.type.meta, color: t.color.textMuted,
    marginTop: t.space.xs,
  },
});
