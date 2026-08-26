// The button. One shape, used everywhere.
//
// The home screen's "Report Hazard" defines the system: a fully-rounded pill,
// orange fill, white bold label, optional leading icon. Every other primary
// action in the app reuses THIS component rather than restating the geometry,
// which is what keeps the hazard modal's "New Route Calculated" identical to
// the home screen's control instead of merely similar.
import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

/**
 * @param variant  'primary' filled orange | 'secondary' white pill | 'danger'
 * @param size     'lg' the home-screen hazard control | 'md' in-card actions
 */
export default function Button({
  label, icon, onPress, variant = 'primary', size = 'lg',
  disabled, accessibilityLabel, accessibilityHint, style,
}) {
  const palette = VARIANT[variant] ?? VARIANT.primary;
  const metrics = SIZE[size] ?? SIZE.lg;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: palette.bg, minHeight: metrics.height,
          paddingHorizontal: metrics.padX },
        palette.border ? { borderWidth: 1, borderColor: palette.border } : null,
        variant === 'secondary' ? t.shadow.control : t.shadow.card,
        pressed && { backgroundColor: palette.pressed },
        disabled && styles.disabled,
        style,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
    >
      <View style={styles.row}>
        {icon ? (
          // Decorative: the visible label already carries the meaning, so this
          // is hidden from the accessibility tree rather than read twice.
          <Icon
            name={icon}
            size={metrics.icon}
            color={palette.fg}
            style={styles.icon}
            importantForAccessibility="no"
          />
        ) : null}
        <Text style={[styles.label, { color: palette.fg, fontSize: metrics.font }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const VARIANT = {
  primary: { bg: t.color.accent, pressed: t.color.accentPressed, fg: t.color.onAccent },
  danger: { bg: t.color.alertFill, pressed: t.color.alertPressed, fg: t.color.onAlert },
  secondary: {
    bg: t.color.bgPanel, pressed: t.color.bgInset,
    fg: t.color.textPrimary, border: t.color.border,
  },
};

const SIZE = {
  // Comfortably past the 48dp minimum: this is a gloved, hurried, one-handed
  // tap taken while stopped in front of a landslide.
  lg: { height: 68, padX: t.space.xl, font: t.type.title, icon: 26 },
  md: { height: t.touchMin, padX: t.space.lg, font: t.type.body, icon: 20 },
};

const styles = StyleSheet.create({
  base: {
    borderRadius: t.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  icon: { marginRight: t.space.sm },
  label: { fontFamily: t.font.sansMedium, fontWeight: '700', textAlign: 'center' },
  disabled: { opacity: 0.45 },
});
