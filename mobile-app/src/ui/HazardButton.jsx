// Hazard report trigger (Workflow 4).
//
// Deliberately the largest touch target in the app. It is pressed by a driver
// who has just stopped in front of a landslide, in rain, possibly wearing
// gloves, without taking time to aim. Size and contrast are the feature.
import React from 'react';
import { Pressable, Text, StyleSheet, View } from 'react-native';
import { t } from './tokens';

export default function HazardButton({ onPress, busy, queued }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        busy && styles.busy,
      ]}
      accessibilityRole="button"
      accessibilityLabel="Report a hazard. Opens the camera."
      accessibilityHint="Photographs a landslide or blockage and queues it for dispatch"
    >
      <View style={styles.row}>
        <Text style={styles.glyph} accessibilityElementsHidden>▲</Text>
        <Text style={styles.label}>{busy ? 'OPENING CAMERA…' : 'REPORT HAZARD'}</Text>
      </View>
      {queued > 0 ? (
        <Text style={styles.queued}>
          {queued} report{queued === 1 ? '' : 's'} waiting to upload
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: t.color.alertFill,
    paddingVertical: t.space.lg,
    paddingHorizontal: t.space.lg,
    borderTopWidth: 3,
    borderTopColor: t.color.alertText,
    // Well past the 48dp minimum: this is a gloved, hurried, one-handed tap.
    minHeight: 96,
    justifyContent: 'center',
  },
  pressed: { backgroundColor: t.color.alertPressed },
  busy: { opacity: 0.6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  glyph: {
    fontFamily: t.font.mono, fontSize: t.type.lead, color: t.color.onAlert,
    marginRight: t.space.sm,
  },
  label: {
    fontFamily: t.font.mono, fontSize: t.type.head, fontWeight: '700',
    letterSpacing: 2, color: t.color.onAlert,
  },
  queued: {
    fontFamily: t.font.mono, fontSize: t.type.meta, color: t.color.onAlert,
    textAlign: 'center', marginTop: t.space.xs, opacity: 0.85,
  },
});
