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

  const title = KIND_TITLE[incident.kind] ?? 'VERIFIED HAZARD AHEAD';
  const km = Number.isFinite(incident.distance_m)
    ? (incident.distance_m / 1000).toFixed(1) : null;
  const delay = Number.isFinite(incident.delay_min) ? incident.delay_min : null;

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
            <Icon name="warning" size={30} color={t.color.alertText}
                  importantForAccessibility="no" />
          </View>

          <Text style={styles.title}>{title}</Text>

          <Text style={styles.body}>
            {incident.message
              ?? `Reported by dispatch${km ? ` ${km} km ahead` : ''} on your route. Slow down and proceed with caution.`}
          </Text>

          <View style={styles.stats}>
            <View style={styles.stat}>
              <Icon name="schedule" size={20} color={t.color.alertText}
                    importantForAccessibility="no" />
              <Text style={styles.statLabel}>ESTIMATED{'\n'}DELAY</Text>
              <Text style={[styles.statValue, { color: t.color.alertText }]}>
                {delay == null ? '—' : `+${delay} MIN`}
              </Text>
            </View>
            <View style={styles.stat}>
              <Icon name="alt-route" size={20} color={t.color.accent}
                    importantForAccessibility="no" />
              <Text style={styles.statLabel}>EXTRA{'\n'}DISTANCE</Text>
              <Text style={styles.statValue}>{km == null ? '—' : `${km} KM`}</Text>
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
  },
  silent: {
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.alertText, marginTop: t.space.md,
  },
  action: { alignSelf: 'stretch', marginTop: t.space.lg },
  secondary: { alignSelf: 'stretch', marginTop: t.space.sm },
});
