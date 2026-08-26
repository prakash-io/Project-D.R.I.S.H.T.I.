// HAZARD tab — report a hazard, and see what is still queued.
//
// The queue is shown rather than hidden because a report that has not reached
// dispatch has not warned anybody. A driver who photographed a landslide is
// entitled to know it is still sitting on the phone.
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Button from './Button';
import { Card, StatusPill, IconBadge } from './Card';
import { t } from './tokens';

export default function HazardScreen({
  onReport, picking, hazardQueued, linkUp, canReport,
}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        <View style={styles.headRow}>
          <IconBadge name="report-problem" tone={t.color.alertText}
                     wash={t.color.alertWash} size={52} />
          <View style={styles.headBody}>
            <Text style={styles.title}>Report a hazard</Text>
            <Text style={styles.body}>
              Photograph a landslide, flood or blockage. The report is saved on
              this device first, so it survives a dark zone and uploads itself
              when the link returns.
            </Text>
          </View>
        </View>

        {/* Same pill as the map screen's control — one button system. */}
        <Button
          label={picking ? 'OPENING CAMERA…' : 'REPORT HAZARD'}
          icon="add-a-photo"
          onPress={onReport}
          disabled={picking || !canReport}
          style={styles.action}
          accessibilityHint="Opens the camera to photograph a road hazard"
        />

        {!canReport ? (
          <Text style={styles.blocked}>
            No position fix yet — a report cannot be placed on the map.
          </Text>
        ) : null}
      </Card>

      <Card style={styles.card}>
        <View style={styles.queueHead}>
          <Text style={styles.title}>Queued reports</Text>
          <StatusPill
            label={hazardQueued === 0 ? 'ALL SENT' : `${hazardQueued} WAITING`}
            tone={hazardQueued === 0 ? t.color.okText : t.color.warnText}
            wash={hazardQueued === 0 ? t.color.okWash : t.color.warnWash}
            icon={hazardQueued === 0 ? 'check-circle' : 'schedule'}
          />
        </View>
        <Text style={styles.body}>
          {hazardQueued === 0
            ? 'Nothing held. Every report has been acknowledged by dispatch.'
            : linkUp
              ? 'Uploading to dispatch now. Photos go after telemetry, since one photo can occupy a marginal link for a long time.'
              : 'Held on this device until the link returns. Nothing is lost — each report carries an id, so a retry cannot create a duplicate incident.'}
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: t.space.lg, paddingBottom: t.space.xxl },
  card: { marginBottom: t.space.lg },
  headRow: { flexDirection: 'row' },
  headBody: { flex: 1, marginLeft: t.space.md },
  title: {
    fontFamily: t.font.sansMedium, fontSize: t.type.lead, fontWeight: '700',
    color: t.color.textPrimary,
  },
  body: {
    fontFamily: t.font.sans, fontSize: t.type.meta, color: t.color.textSecondary,
    marginTop: t.space.xs, lineHeight: 20,
  },
  action: { marginTop: t.space.lg },
  blocked: {
    fontFamily: t.font.sansMedium, fontSize: t.type.meta, fontWeight: '600',
    color: t.color.alertText, marginTop: t.space.md, textAlign: 'center',
  },
  queueHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: t.space.sm,
  },
});
