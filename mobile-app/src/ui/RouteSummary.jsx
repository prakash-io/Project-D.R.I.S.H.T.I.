// Route summary overlay -- the ETA band a driver navigates by (MOB-07).
//
// Modelled on the navigation card in Google Maps for a reason: duration is
// the headline in the largest type on the screen, distance and arrival clock
// are the supporting line. That ordering is what a driver actually asks --
// "how long until I'm there", not "how many kilometres of road remain" -- and
// matching an app every driver already knows means there is nothing to learn
// at 60 km/h.
//
// Currently fed only by the reroute payload, because the ETA is costed from
// the road graph on the server and the corridor picker's stored geometry does
// not carry one. That is a real gap, not a design choice: an ETA that appears
// only when something has gone wrong teaches the driver to read the card as
// bad news. Closing it means returning estimated_time_sec from
// /routes/corridors too, and this component already renders the moment it is
// given the two figures.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { t } from './tokens';

/// 8527 -> "2 hr 22 min", 900 -> "15 min". Hours are dropped entirely below
/// one hour rather than shown as "0 hr", which reads as a broken readout.
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/// Distance in the unit the number deserves: metres below a kilometre, one
/// decimal to 100 km, none above -- "415 km" not "415.1 km", because the
/// tenth is noise at that range and costs a glyph the driver has to read.
export function formatDistance(metres) {
  if (!Number.isFinite(metres) || metres < 0) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/// Wall-clock arrival, 24h. Computed at render from the phone's own clock so
/// it stays honest if the payload sat in a queue during a dark-zone gap.
export function arrivalClock(seconds, now = new Date()) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const at = new Date(now.getTime() + seconds * 1000);
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function RouteSummary({ distanceM, durationSec, rerouted, style }) {
  // Nothing to say without at least one of the two figures. Rendering the
  // card with two em-dashes would take space from the map for no information.
  if (!Number.isFinite(distanceM) && !Number.isFinite(durationSec)) return null;

  const eta = arrivalClock(durationSec);
  const duration = formatDuration(durationSec);
  const distance = formatDistance(distanceM);
  // A corridor picked from the rail carries a distance and no ETA -- there is
  // no stored duration for it, and this client will not invent one. Rather
  // than head the card with "—", the distance is promoted to the headline and
  // the supporting line drops out. The card then says less, which is correct,
  // instead of saying nothing in the largest type on the screen.
  const durationKnown = Number.isFinite(durationSec) && durationSec >= 0;
  const headline = durationKnown ? duration : distance;

  return (
    <View
      style={[styles.card, t.shadow.card, style]}
      accessibilityRole="summary"
      accessibilityLabel={
        `${rerouted ? 'New route. ' : ''}`
        + (durationKnown
            ? `${duration} remaining, ${distance}${eta ? `, arriving about ${eta}` : ''}`
            : `${distance} remaining`)}
    >
      {rerouted ? (
        <View style={styles.flag}>
          <Icon name="alt-route" size={14} color={t.color.accentText}
                importantForAccessibility="no" />
          <Text style={styles.flagText}>NEW ROUTE</Text>
        </View>
      ) : null}

      <View style={styles.row}>
        {/* The headline. accessibilityElementsHidden because the card above
            already speaks the whole sentence -- otherwise a screen reader
            reads the duration twice. */}
        <Text style={styles.duration} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {headline}
        </Text>
      </View>

      {durationKnown ? (
        <View style={styles.metaRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={styles.meta}>{distance}</Text>
          {eta ? (
            <>
              <Text style={styles.dot}>·</Text>
              <Icon name="schedule" size={13} color={t.color.textMuted} />
              <Text style={styles.meta}>{eta}</Text>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.card,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
    marginHorizontal: t.space.lg,
    marginBottom: t.space.md,
  },
  flag: { flexDirection: 'row', alignItems: 'center', marginBottom: t.space.xs },
  flagText: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 1.1, color: t.color.accentText, marginLeft: 5,
  },
  row: { flexDirection: 'row', alignItems: 'baseline' },
  duration: {
    fontFamily: t.font.sansMedium, fontSize: t.type.head, fontWeight: '700',
    color: t.color.textPrimary, fontVariant: ['tabular-nums'],
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  meta: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    fontVariant: ['tabular-nums'], marginRight: 4,
  },
  dot: { color: t.color.textMuted, marginRight: 6 },
});
