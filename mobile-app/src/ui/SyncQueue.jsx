// Offline backlog depth (MOB-02, MOB-03).
//
// No progress bar: the queue has no denominator -- it grows for as long as the
// dark zone lasts. A bar would have to invent a maximum, so this shows the
// count and what will happen to it instead.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t } from './tokens';

export default function SyncQueue({ queued, linkUp, hud }) {
  const holding = queued > 0;
  // Draining requires a live link, not merely internet: the drain POSTs to
  // the same server the socket talks to.
  const draining = holding && linkUp;

  return (
    <View style={[styles.wrap, hud && styles.hudSurface]}>
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
