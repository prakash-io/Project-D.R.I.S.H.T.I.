// Verified hazard ahead (Workflow 4, MOB-07).
//
// Fires on the backend's `incident_reported` broadcast. The spoken alert is
// the primary channel -- a driver on a mountain road must not look down -- so
// this is the visual echo for a loud cab or a failed TTS call, and it repeats
// the message rather than abbreviating it.
import React from 'react';
import { Modal, View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Button from './Button';
import { t } from './tokens';

const KIND_TITLE = {
  landslide: 'LANDSLIDE AHEAD',
  flood: 'FLOODING AHEAD',
  obstruction: 'ROAD OBSTRUCTION AHEAD',
};

export default function IncidentModal({ incident, spokenBy, onDismiss, onViewMap }) {
  if (!incident) return null;

  // Whose hazard is this: one a dispatcher has approved and that now closes a
  // road, or this driver's own report on its way to be looked at?
  //
  // The card could not tell the difference before, because the backend
  // broadcast every report to every handset the instant it was uploaded. So a
  // driver who had just photographed a landslide was shown ROAD OBSTRUCTION
  // AHEAD / "Reported by dispatch on your route" about their own photograph,
  // and so was every other truck in the fleet -- for a report no human had
  // seen and that was blocking nothing. Delivery is now scoped by room; this
  // is what makes the words match.
  const awaiting = incident.scope === 'awaiting_approval'
    || incident.requires_approval === true;

  const title = awaiting
    ? 'HAZARD REPORT SENT'
    : KIND_TITLE[incident.kind] ?? 'VERIFIED HAZARD AHEAD';

  // What the detour costs, straight from the figures the backend computed on
  // the road graph -- `delta_distance_m` and `delta_time_sec` off the reroute,
  // carried in by App.jsx.
  //
  // These used to read `incident.distance_m` and `incident.delay_min`, which
  // no service has ever sent: this card is fed by `incident_reported`, and
  // that payload is the incidents ROW -- kind, status, confidence, a lat and
  // a lng. It cannot know what a detour costs one particular truck, because
  // nothing about a detour is stored on it. Both tiles therefore rendered an
  // em-dash on every hazard the platform has ever raised, which read as "no
  // delay" rather than "never wired up".
  //
  // `costed` is the third state and the reason this is not just two null
  // checks: a hazard on the board that has not been routed around yet has no
  // figures AND no zero. Saying "—" there tells the driver a detour is free.
  const extraKm = Number.isFinite(incident.extra_distance_m)
    ? incident.extra_distance_m / 1000 : null;
  const delayMin = Number.isFinite(incident.delay_sec)
    ? Math.round(incident.delay_sec / 60) : null;
  const costed = incident.costed === true;

  // Signed, because a reroute is not always worse. pgr_astar can hand back a
  // shorter path than the one the truck was on, and printing "+-2.1 KM" or
  // silently dropping the sign would both misreport it.
  const signed = (value, unit) => {
    const rounded = unit === 'MIN' ? Math.round(value) : Number(value.toFixed(1));
    if (rounded === 0) return unit === 'MIN' ? 'NO DELAY' : 'SAME';
    return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} ${unit}`;
  };

  // A report awaiting a dispatcher has no detour to cost, and "COSTING…" on
  // it is a promise of a number that is not coming: nothing will be routed
  // around this hazard until a human approves it. Say what is actually true.
  const pending = awaiting ? 'ON REVIEW' : 'COSTING…';
  const delayText = delayMin != null ? signed(delayMin, 'MIN')
    : costed ? 'NO DELAY' : pending;
  const distanceText = extraKm != null ? signed(extraKm, 'KM')
    : costed ? 'SAME' : pending;

  return (
    <Modal visible transparent animationType="fade"
           onRequestClose={onDismiss} statusBarTranslucent>
      <View style={styles.scrim}>
        <View
          style={[styles.card, t.shadow.card]}
          accessibilityViewIsModal
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
        >
          <View style={styles.iconWrap}>
            {/* A warning triangle on a driver's OWN unreviewed report reads as
                "there is a hazard ahead of you", which is not what happened --
                what happened is that they sent a photograph. */}
            <Icon name={awaiting ? 'cloud-upload' : 'warning'} size={30}
                  color={t.color.alertText} importantForAccessibility="no" />
          </View>

          <Text style={styles.title}>{title}</Text>

          <Text style={styles.body}>
            {incident.message
              ?? (awaiting
                ? 'Your photo is with dispatch. Keep driving with care — other '
                  + 'drivers are warned, and any detour is offered, once it is approved.'
                : 'Reported by dispatch on your route. Slow down and proceed with caution.')}
          </Text>

          <View style={styles.stats}>
            <View style={styles.stat}>
              <Icon name="schedule" size={20} color={t.color.alertText}
                    importantForAccessibility="no" />
              <Text style={styles.statLabel}>ESTIMATED{'\n'}DELAY</Text>
              <Text
                style={[styles.statValue, { color: t.color.alertText },
                        !costed && styles.statPending]}
                // Read aloud in full: "+12 MIN" is unambiguous on screen and
                // not in a screen reader.
                accessibilityLabel={delayMin != null
                  ? `Estimated delay ${delayMin} minutes`
                  : costed ? 'No delay' : 'Delay still being calculated'}
              >
                {delayText}
              </Text>
            </View>
            <View style={styles.stat}>
              <Icon name="alt-route" size={20} color={t.color.accent}
                    importantForAccessibility="no" />
              <Text style={styles.statLabel}>EXTRA{'\n'}DISTANCE</Text>
              <Text
                style={[styles.statValue, !costed && styles.statPending]}
                accessibilityLabel={extraKm != null
                  ? `Extra distance ${extraKm.toFixed(1)} kilometres`
                  : costed ? 'No extra distance' : 'Distance still being calculated'}
              >
                {distanceText}
              </Text>
            </View>
          </View>

          {/* Says which engine spoke, because a driver who heard nothing needs
              to know whether the alert was silent or simply missed. */}
          {spokenBy === false ? (
            <Text style={styles.silent}>VOICE ALERT UNAVAILABLE — READ ABOVE</Text>
          ) : null}

          {/* Same pill as the home screen's Report Hazard control. */}
          <Button
            label="ACKNOWLEDGE"
            icon="check"
            onPress={onDismiss}
            style={styles.action}
            accessibilityHint="Dismisses this hazard alert"
          />
          <Button
            label="VIEW MAP"
            variant="secondary"
            size="md"
            onPress={onViewMap ?? onDismiss}
            style={styles.secondary}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(17,20,24,0.55)',
    justifyContent: 'center',
    paddingHorizontal: t.space.lg,
  },
  card: {
    backgroundColor: t.color.bgPanel,
    borderRadius: t.radius.card,
    paddingHorizontal: t.space.xl,
    paddingVertical: t.space.xl,
    alignItems: 'center',
  },
  iconWrap: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: t.color.alertWash,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: t.space.md,
  },
  title: {
    fontFamily: t.font.sansMedium, fontSize: t.type.title, fontWeight: '800',
    color: t.color.textPrimary, textAlign: 'center', letterSpacing: 0.3,
  },
  body: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    textAlign: 'center', marginTop: t.space.sm, lineHeight: 21,
  },
  stats: {
    flexDirection: 'row', alignSelf: 'stretch',
    marginTop: t.space.lg, gap: t.space.md,
  },
  stat: {
    flex: 1, alignItems: 'center',
    backgroundColor: t.color.bgInset,
    borderRadius: t.radius.inner,
    paddingVertical: t.space.md, paddingHorizontal: t.space.sm,
  },
  statLabel: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '600',
    letterSpacing: 1, color: t.color.textMuted, textAlign: 'center',
    marginTop: 6,
  },
  statValue: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '800',
    color: t.color.textPrimary, marginTop: 4, fontVariant: ['tabular-nums'],
    // "COSTING…" is longer than any figure it stands in for; without this it
    // wraps and pushes the two tiles to different heights.
    textAlign: 'center',
  },
  // A number not yet known must not look like a number. Same slot, quieter and
  // smaller, so the tile does not resize when the real figure lands.
  statPending: {
    fontSize: t.type.meta, fontWeight: '600', color: t.color.textMuted,
  },
  silent: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.alertText, marginTop: t.space.md,
  },
  action: { alignSelf: 'stretch', marginTop: t.space.lg },
  secondary: { alignSelf: 'stretch', marginTop: t.space.sm },
});
