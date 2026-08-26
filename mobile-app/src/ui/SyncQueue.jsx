// Offline backlog depth (MOB-02, MOB-03).
//
// No progress bar: the queue has no denominator -- it grows for as long as the
// dark zone lasts. A bar would have to invent a maximum, so this shows the
// count and what will happen to it instead.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t } from './tokens';

export default function SyncQueue({ queued, mode }) {
  const holding = queued > 0;
  const draining = holding && mode === 'online';

  return (
    <View style={styles.wrap}>
      <View style={styles.left}>
        <Text style={styles.caption}>QUEUED ON DEVICE</Text>
        <Text style={styles.note}>
          {!holding
            ? 'Nothing held — every point acknowledged'
            : draining
              ? 'Burst sync draining to dispatch'
              : 'Held locally until the link returns'}
        </Text>
      </View>
      <Text
        style={[styles.count, holding ? styles.countHot : null]}
        accessibilityLabel={`${queued} points queued for sync`}
      >
        {queued}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.color.bgPanel,
    borderBottomWidth: t.hairline, borderBottomColor: t.color.border,
    paddingHorizontal: t.space.lg, paddingVertical: t.space.md,
  },
  left: { flex: 1, paddingRight: t.space.md },
  caption: {
    fontFamily: t.font.mono, fontSize: t.type.micro, letterSpacing: 1.6,
    color: t.color.textMuted,
  },
  note: {
    fontFamily: t.font.mono, fontSize: t.type.meta, color: t.color.textSecondary,
    marginTop: t.space.xs,
  },
  count: {
    fontFamily: t.font.mono, fontSize: t.type.head, fontWeight: '700',
    color: t.color.textMuted, fontVariant: ['tabular-nums'], letterSpacing: -1,
  },
  countHot: { color: t.color.sourceDeadReckoning },
});
