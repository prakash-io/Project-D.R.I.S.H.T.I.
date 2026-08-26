// Reroute alert (MOB-07).
//
// The audio is the alert -- Bhashini speaks it in the driver's language and a
// driver on a mountain road must never need to look down. This band is the
// visual echo for when the cab is loud or the TTS call failed, so it repeats
// the message rather than replacing it.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { t } from './tokens';

export default function RerouteAlert({ alert, onDismiss }) {
  if (!alert) return null;

  return (
    <View
      style={styles.band}
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
    >
      <View style={styles.stripe} />
      <View style={styles.body}>
        <Text style={styles.title}>ROUTE CHANGED</Text>
        <Text style={styles.message}>{alert}</Text>
      </View>
      <Pressable
        onPress={onDismiss}
        style={({ pressed }) => [styles.dismiss, pressed && styles.dismissPressed]}
        // The visual glyph is small; the tap area is not.
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Dismiss route alert"
      >
        <Text style={styles.dismissText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    flexDirection: 'row', alignItems: 'stretch',
    backgroundColor: t.color.bgRaised,
    borderTopWidth: t.hairline, borderTopColor: t.color.alertFill,
  },
  stripe: { width: 4, backgroundColor: t.color.alertFill },
  body: { flex: 1, paddingHorizontal: t.space.lg, paddingVertical: t.space.md },
  title: {
    fontFamily: t.font.mono, fontSize: t.type.micro, letterSpacing: 1.8,
    color: t.color.alertText,
  },
  message: {
    fontFamily: t.font.mono, fontSize: t.type.lead, color: t.color.textPrimary,
    marginTop: t.space.xs,
  },
  dismiss: {
    width: t.touchMin, minHeight: t.touchMin,
    alignItems: 'center', justifyContent: 'center',
    borderLeftWidth: t.hairline, borderLeftColor: t.color.border,
  },
  // Opacity/colour only -- never a transform, which would shift the band's
  // layout under the driver's thumb.
  dismissPressed: { backgroundColor: t.color.bgInset },
  dismissText: { fontFamily: t.font.mono, fontSize: t.type.lead, color: t.color.textMuted },
});
