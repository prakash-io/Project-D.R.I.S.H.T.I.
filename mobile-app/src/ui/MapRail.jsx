// The floating control rail down the right edge of the map.
//
// The home screen used to carry two separate control stacks and a full-width
// orange button: four round buttons on the right (zoom in, zoom out, recentre,
// follow), a segmented source control and a corridor rail across the bottom,
// and Report Hazard as a 56pt bar. Nine tap targets, no hierarchy between
// them.
//
// This is one stack with a stated order. Zoom is a joined capsule rather than
// two circles, because +/- is one control the driver reads as one thing;
// recentre and follow are one button, because "put me back on the map" and
// "keep me there" are the same intent and were only ever split because they
// are two pieces of state; and Report Hazard is the only coloured thing on the
// glass, sitting last where the thumb rests.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

function RoundButton({ icon, onPress, label, tone, selected, style }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.round, t.shadow.float, pressed && styles.pressed, style]}
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      accessibilityLabel={label}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
    >
      <Icon name={icon} size={24} color={tone ?? t.color.onGlass}
            importantForAccessibility="no" />
    </Pressable>
  );
}

/**
 * @param onZoomIn/onZoomOut  camera zoom
 * @param follow              camera is tracking the truck
 * @param onFollow            recentre and resume following, or release it
 * @param onSearch            opens the route sheet on the planner
 * @param onRoutes            opens the route sheet on the corridor list
 * @param onReport            the hazard capture flow -- unchanged behind this
 * @param reporting           camera is open, so the button is spent
 */
export default function MapRail({
  onZoomIn, onZoomOut, follow, onFollow, onSearch, onRoutes,
  onReport, reporting, style,
}) {
  return (
    <View style={[styles.stack, style]} pointerEvents="box-none">
      <View style={[styles.capsule, t.shadow.float]}>
        <Pressable
          onPress={onZoomIn}
          style={({ pressed }) => [styles.capsuleHalf, pressed && styles.pressed]}
          accessibilityRole="button" accessibilityLabel="Zoom in"
        >
          <Icon name="add" size={22} color={t.color.onGlass} importantForAccessibility="no" />
        </Pressable>
        <View style={styles.capsuleRule} />
        <Pressable
          onPress={onZoomOut}
          style={({ pressed }) => [styles.capsuleHalf, pressed && styles.pressed]}
          accessibilityRole="button" accessibilityLabel="Zoom out"
        >
          <Icon name="remove" size={22} color={t.color.onGlass} importantForAccessibility="no" />
        </Pressable>
      </View>

      {/* One button, two states. While following, it is lit and releasing it
          hands the viewport to the driver; while released, pressing it flies
          the camera back to the truck and re-arms the follow. That is the
          Google Maps contract, and it is the one drivers already have. */}
      <RoundButton
        icon={follow ? 'gps-fixed' : 'near-me'}
        onPress={onFollow}
        tone={follow ? t.color.accent : t.color.onGlass}
        selected={follow}
        label={follow ? 'Stop following my position' : 'Recentre on my position'}
        style={styles.spaced}
      />

      <RoundButton icon="search" onPress={onSearch} label="Plan a route"
                   style={styles.spaced} />
      <RoundButton icon="alt-route" onPress={onRoutes} label="Route and corridor options"
                   style={styles.spaced} />

      <Pressable
        onPress={onReport}
        disabled={reporting}
        style={({ pressed }) => [
          styles.report, t.shadow.float,
          pressed && styles.reportPressed,
          reporting && styles.reportBusy,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Report hazard"
        accessibilityState={{ disabled: Boolean(reporting) }}
        accessibilityHint="Photographs a road hazard and queues it for dispatch"
      >
        <Icon name="warning" size={22} color={t.color.onAccent}
              importantForAccessibility="no" />
        <Text style={styles.reportLabel}>Report</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: 'flex-end' },
  round: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: t.color.glass,
    borderWidth: t.hairline, borderColor: t.color.glassEdge,
    alignItems: 'center', justifyContent: 'center',
  },
  spaced: { marginTop: t.space.md },
  pressed: { backgroundColor: t.color.glassSoft, opacity: 0.85 },
  capsule: {
    width: 52, borderRadius: 26,
    backgroundColor: t.color.glass,
    borderWidth: t.hairline, borderColor: t.color.glassEdge,
    overflow: 'hidden',
  },
  capsuleHalf: { height: 50, alignItems: 'center', justifyContent: 'center' },
  capsuleRule: { height: t.hairline, backgroundColor: t.color.glassEdge, marginHorizontal: 12 },
  report: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.color.accent,
    borderRadius: t.radius.pill,
    height: 52, paddingHorizontal: t.space.lg,
    marginTop: t.space.lg,
  },
  reportPressed: { backgroundColor: t.color.accentPressed },
  reportBusy: { opacity: 0.55 },
  reportLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.body, fontWeight: '700',
    color: t.color.onAccent, marginLeft: 8,
  },
});
