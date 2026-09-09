// The route sheet -- everything about the route that is not "where am I going".
//
// This is where the home screen's clutter went. The planner, the position
// source toggle, the ten-corridor rail and the bearing/altitude instruments
// were all mounted permanently over the map, stacked five deep, and together
// they cost roughly half the screen. None of them is a driving control: the
// source is set once at the start of a run, a corridor is picked once, and
// bearing and altitude are read when someone asks, not while turning.
//
// So they are one tap down instead of always on. Nothing was removed and no
// prop changed shape -- the same components mount here, with the same
// callbacks, inside a scroll view that can grow without ever pushing the
// hazard button off the bottom of a small handset.
//
// It follows the RerouteSheet idiom deliberately: same scrim, same grabber,
// same top radius. A driver should not have to learn two kinds of sheet.
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

/**
 * @param open      visible
 * @param onClose   scrim tap or the close button
 * @param children  the existing planner / toggle / picker / instruments
 */
export default function RouteSheet({ open, onClose, children }) {
  if (!open) return null;

  return (
    <View style={styles.scrim}>
      {/* The scrim is a dismiss target, not a wall. Tapping the map to get
          back to driving is the fastest way out of a panel a driver opened by
          accident, and it is the gesture they will try first. */}
      <Pressable
        style={styles.scrimTap}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close route options"
      />

      <View style={styles.sheet}>
        <View style={styles.grabber} />

        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">Route</Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            accessibilityRole="button"
            accessibilityLabel="Close route options"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Icon name="close" size={22} color={t.color.textSecondary}
                  importantForAccessibility="no" />
          </Pressable>
        </View>

        {/* Bounded rather than full-height: the map stays visible above it, so
            the driver can see where the corridor they are picking actually
            goes while they pick it. */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(11, 18, 32, 0.32)',
    // Above the map rail, which casts at elevation 8 and would otherwise be
    // painted straight through this panel on Android.
    elevation: t.layer.sheet, zIndex: t.layer.sheet,
  },
  scrimTap: { flex: 1 },
  sheet: {
    backgroundColor: t.color.bgPanel,
    borderTopLeftRadius: t.radius.card,
    borderTopRightRadius: t.radius.card,
    paddingTop: t.space.md,
    paddingBottom: t.space.lg,
    maxHeight: '76%',
  },
  grabber: {
    alignSelf: 'center',
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: t.color.border,
  },
  head: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: t.space.xl,
    paddingTop: t.space.md,
    paddingBottom: t.space.sm,
  },
  title: {
    flex: 1,
    fontFamily: t.font.sansMedium, fontSize: t.type.title, fontWeight: '700',
    color: t.color.textPrimary,
  },
  close: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.color.bgInset,
  },
  closePressed: { backgroundColor: t.color.border },
  scroll: { flexGrow: 0 },
  content: { paddingHorizontal: t.space.xl, paddingTop: t.space.sm, paddingBottom: t.space.md },
});
