// Where the position comes from: the North East corridor, or this handset.
//
// The demonstration drive used to be a build-time constant (SIM_DRIVE), which
// made showing both halves of the platform a two-build job. It is a runtime
// switch now, and the switch is honest about what it does: it substitutes the
// SENSOR, not the system. Everything downstream of the fix -- the socket emit,
// the WatermelonDB queue, the burst sync, the backend ingest, the EKF -- is
// the same code on both sides of this toggle.
//
// Why the toggle has to exist at all: the handset is not in the North East.
// Real GNSS puts the truck ~1,400 km outside the 486,784-edge extract, where
// no edge snaps, no route plans and no hazard resolves -- so every feature
// reads as broken when it is merely out of area. And why real GNSS has to stay
// available: a simulated drive proves nothing about the receiver, the
// permissions or the foreground service, which are exactly what a road test
// is for.
//
// A segmented control rather than a switch. A bare toggle labelled "Simulate"
// says what it does to the developer who wrote it and nothing to anyone else;
// two named segments say what the truck IS following.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

/**
 * @param simulated  current state
 * @param onChange   (bool) => void
 * @param disabled   no corridor loaded, so there is nothing to simulate
 * @param routeName  what the demo segment is driving, e.g. "Guwahati → Shillong"
 */
export default function SourceToggle({ simulated, onChange, disabled, routeName, style }) {
  return (
    <View style={[styles.wrap, style]}>
      <View
        style={styles.track}
        accessibilityRole="radiogroup"
        accessibilityLabel="Position source"
      >
        <Segment
          icon="alt-route"
          label="NE ROUTE"
          active={simulated}
          disabled={disabled}
          onPress={() => onChange?.(true)}
          hint={routeName
            ? `Drives the ${routeName} corridor`
            : 'Drives the planned corridor'}
        />
        <Segment
          icon="my-location"
          label="MY LOCATION"
          active={!simulated}
          onPress={() => onChange?.(false)}
          hint="Uses this phone's satellite receiver"
        />
      </View>
      <Text style={styles.caption} numberOfLines={1}>
        {simulated
          ? (routeName ? `Driving ${routeName}` : 'Driving the planned route')
          : 'Live GNSS from this handset'}
      </Text>
    </View>
  );
}

function Segment({ icon, label, active, disabled, onPress, hint }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || active}
      style={({ pressed }) => [
        styles.segment,
        active && styles.segmentActive,
        pressed && !active && styles.segmentPressed,
        disabled && !active && styles.segmentDisabled,
      ]}
      accessibilityRole="radio"
      accessibilityState={{ selected: active, disabled: Boolean(disabled) }}
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      <Icon
        name={icon}
        size={16}
        color={active ? t.color.onAccent : t.color.textSecondary}
        importantForAccessibility="no"
      />
      <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: t.space.md },
  track: {
    flexDirection: 'row',
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.pill,
    padding: 4,
    ...t.shadow.control,
  },
  segment: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    // Below the 48dp guidance on purpose: this is a two-state control set once
    // at the start of a demonstration, not a driving control, and a full-height
    // pill here would push the route card off a small screen. The tap target
    // is the full half-width of the card, which is the dimension that misses.
    minHeight: 40,
    borderRadius: t.radius.pill,
    paddingHorizontal: t.space.md,
  },
  segmentActive: { backgroundColor: t.color.accent },
  segmentPressed: { backgroundColor: t.color.bgInset },
  segmentDisabled: { opacity: 0.4 },
  label: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.9, color: t.color.textSecondary,
    marginLeft: 6,
  },
  labelActive: { color: t.color.onAccent },
  caption: {
    fontFamily: t.font.sans, fontSize: t.type.micro, color: t.color.textMuted,
    textAlign: 'center', marginTop: 6,
  },
});
