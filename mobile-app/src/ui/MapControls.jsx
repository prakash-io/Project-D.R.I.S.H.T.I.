// Circular map controls stacked down the right edge: zoom in, zoom out,
// recentre. White pill-round buttons matching the home screen's control
// language, sized well past the 48dp minimum for a moving vehicle.
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

function RoundButton({ icon, onPress, label, tone, last, selected }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button, t.shadow.control,
        selected && styles.selected,
        pressed && styles.pressed,
        !last && styles.spaced,
      ]}
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      <Icon name={icon} size={26} color={tone ?? t.color.textPrimary}
            importantForAccessibility="no" />
    </Pressable>
  );
}

export default function MapControls({ onZoomIn, onZoomOut, onRecenter, follow, onToggleFollow, style }) {
  return (
    <View style={[styles.stack, style]} pointerEvents="box-none">
      <RoundButton icon="add" onPress={onZoomIn} label="Zoom in" />
      <RoundButton icon="remove" onPress={onZoomOut} label="Zoom out" />
      <RoundButton
        icon="near-me"
        onPress={onRecenter}
        label="Recentre on my position"
        tone={t.color.accent}
      />
      {/*
        Follow is a mode, not an action, so it is a toggle with a persistent
        state rather than a button that fires once. While it is OFF the camera
        is not driven at all and the driver can pan and zoom freely; the map
        stops yanking itself back on every location update.
      */}
      <RoundButton
        icon={follow ? 'gps-fixed' : 'gps-not-fixed'}
        onPress={onToggleFollow}
        label={follow ? 'Stop following my position' : 'Follow my position'}
        tone={follow ? t.color.accent : t.color.textMuted}
        selected={follow}
        last
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: 'center' },
  button: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: t.color.bgPanel,
    alignItems: 'center', justifyContent: 'center',
  },
  pressed: { backgroundColor: t.color.bgInset },
  selected: { borderWidth: 2, borderColor: t.color.accent },
  spaced: { marginBottom: t.space.md },
});
