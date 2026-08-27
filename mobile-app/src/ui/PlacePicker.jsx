// Destination search: type a place, pick a place.
//
// A filtered list rather than a free-text box that geocodes. Every entry here
// is an end of a seeded corridor, so it is already proven reachable in this
// road extract -- which is the difference between "no route to Tinsukia" being
// a real answer and being a bug the driver has no way to diagnose. Typing
// filters; it never invents a destination the graph cannot reach.
//
// Full-screen rather than a dropdown. The driver is picking this while
// stopped, one-handed, and a 14-row list behind a 200 px popover over a moving
// map is a worse target than the whole screen.
import React, { useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, FlatList, StyleSheet, Platform, StatusBar,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

/// The driver's own position, offered as an origin. Not a row in `places`:
/// it has no fixed coordinates, it exists only while there is a fix, and it
/// is the one entry whose lat/lng the caller has to fill in at the moment of
/// selection rather than at render.
export const HERE = { id: '__here__', name: 'My location' };

/**
 * @param visible      show the sheet
 * @param title        'Choose origin' | 'Choose destination'
 * @param places       [{ id, name, lat, lng }]
 * @param selectedId   currently chosen, ticked in the list
 * @param excludeId    the OTHER field's choice -- greyed, because a route from
 *                     a place to itself is not a route
 * @param allowHere    offer "My location" (only when there is a fix)
 * @param onSelect     (place) => void
 * @param onClose      () => void
 */
export default function PlacePicker({
  visible, title, places, selectedId, excludeId, allowHere, onSelect, onClose,
}) {
  const [queryText, setQueryText] = useState('');

  const rows = useMemo(() => {
    const all = allowHere ? [HERE, ...(places ?? [])] : (places ?? []);
    const needle = queryText.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((p) => p.name.toLowerCase().includes(needle));
  }, [places, queryText, allowHere]);

  // Cleared on every open. A driver who searched "shil" yesterday should not
  // find the list still filtered to one row today and conclude the app has
  // forgotten every other town.
  const close = () => { setQueryText(''); onClose?.(); };

  return (
    <Modal
      visible={Boolean(visible)}
      animationType="slide"
      transparent={false}
      // Android's hardware back must close the sheet, not the app. Without
      // this the driver's instinct to go back exits to the launcher.
      onRequestClose={close}
    >
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable
            onPress={close}
            style={styles.back}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Close place search"
          >
            <Icon name="arrow-back" size={24} color={t.color.textPrimary} />
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">{title}</Text>
        </View>

        <View style={styles.searchWrap}>
          <Icon name="search" size={20} color={t.color.textMuted}
                importantForAccessibility="no" />
          <TextInput
            style={styles.search}
            value={queryText}
            onChangeText={setQueryText}
            placeholder="Type a town or city"
            placeholderTextColor={t.color.textMuted}
            autoCorrect={false}
            autoCapitalize="words"
            returnKeyType="search"
            accessibilityLabel="Search places"
          />
          {queryText ? (
            <Pressable
              onPress={() => setQueryText('')}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Icon name="close" size={20} color={t.color.textMuted} />
            </Pressable>
          ) : null}
        </View>

        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ListEmptyComponent={(
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {places?.length ? 'No place matches that' : 'No places loaded'}
              </Text>
              <Text style={styles.emptyBody}>
                {places?.length
                  ? 'Only towns the road network actually reaches are listed.'
                  : 'The place list could not be fetched and nothing is cached '
                    + 'on this device yet. It will load once dispatch is reachable.'}
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            const chosen = item.id === selectedId;
            const blocked = item.id === excludeId;
            return (
              <Pressable
                onPress={() => { if (!blocked) { setQueryText(''); onSelect?.(item); } }}
                disabled={blocked}
                style={({ pressed }) => [
                  styles.row,
                  pressed && !blocked && styles.rowPressed,
                  blocked && styles.rowBlocked,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen, disabled: blocked }}
                accessibilityHint={blocked
                  ? 'Already chosen as the other end of the route' : undefined}
              >
                <Icon
                  name={item.id === HERE.id ? 'my-location' : 'place'}
                  size={22}
                  color={chosen ? t.color.accent : t.color.textMuted}
                  importantForAccessibility="no"
                />
                <Text style={[styles.rowLabel, chosen && styles.rowLabelChosen]}>
                  {item.name}
                </Text>
                {chosen ? (
                  <Icon name="check" size={20} color={t.color.accent}
                        importantForAccessibility="no" />
                ) : null}
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: t.color.bgPanel },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: t.space.lg,
    paddingBottom: t.space.md,
    paddingTop: (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0) + t.space.md,
    borderBottomWidth: t.hairline, borderBottomColor: t.color.border,
  },
  back: {
    width: t.touchMin, height: t.touchMin,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: -t.space.md,
  },
  title: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '700',
    color: t.color.textPrimary,
  },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.color.bgInset,
    borderRadius: t.radius.pill,
    marginHorizontal: t.space.lg, marginTop: t.space.lg,
    paddingHorizontal: t.space.lg,
  },
  search: {
    flex: 1,
    minHeight: t.touchMin,
    marginLeft: t.space.sm,
    fontFamily: t.font.sans, fontSize: t.type.body, color: t.color.textPrimary,
    // Android draws its own underline inside a TextInput; the pill is the
    // affordance here and the line reads as a second, misaligned one.
    paddingVertical: 0,
  },
  list: { paddingVertical: t.space.sm },
  row: {
    flexDirection: 'row', alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: t.space.lg,
  },
  rowPressed: { backgroundColor: t.color.bgInset },
  rowBlocked: { opacity: 0.35 },
  rowLabel: {
    flex: 1,
    fontFamily: t.font.sans, fontSize: t.type.lead, color: t.color.textPrimary,
    marginLeft: t.space.lg,
  },
  rowLabelChosen: { fontFamily: t.font.sansMedium, fontWeight: '700' },
  empty: { paddingHorizontal: t.space.xl, paddingTop: t.space.xxl },
  emptyTitle: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '700',
    color: t.color.textPrimary, textAlign: 'center',
  },
  emptyBody: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    textAlign: 'center', marginTop: t.space.sm, lineHeight: 20,
  },
});
