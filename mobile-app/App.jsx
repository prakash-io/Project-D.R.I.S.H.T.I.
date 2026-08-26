// D.R.I.S.H.T.I. driver client (Epic 4).
//
// Wires the four pieces together: GNSS when online, the C++ edge engine when
// not, WatermelonDB in between, and Bhashini reading reroutes aloud.
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaView, StatusBar, View, ScrollView, StyleSheet } from 'react-native';

import StatusBanner from './src/ui/StatusBanner';
import SpeedCluster from './src/ui/SpeedCluster';
import PositionReadout from './src/ui/PositionReadout';
import SyncQueue from './src/ui/SyncQueue';
import RerouteAlert from './src/ui/RerouteAlert';
import { t } from './src/ui/tokens';
import RNFS from 'react-native-fs';

import { createDatabase } from './src/db';
import { connect } from './src/services/socket';
import { watchConnectivity } from './src/services/network';
import { Tracker } from './src/services/tracking';
import { drain, pendingCount } from './src/services/burstSync';
import { speakRerouteAlert } from './src/services/bhashini';

const API_URL = process.env.API_URL ?? 'http://10.0.2.2:4000';
const TRUCK_ID = process.env.TRUCK_ID ?? '';
const ALERT_LANG = process.env.ALERT_LANG ?? 'as';

export default function App() {
  const [mode, setMode] = useState('starting');
  const [fix, setFix] = useState(null);
  const [queued, setQueued] = useState(0);
  const [alert, setAlert] = useState(null);

  const database = useRef(null);
  const tracker = useRef(null);
  const socket = useRef(null);

  useEffect(() => {
    database.current = createDatabase();

    socket.current = connect({
      apiUrl: API_URL,
      truckId: TRUCK_ID,
      onRouteUpdated: async (payload) => {
        setAlert(`Rerouted — ${(payload.distance_m / 1000).toFixed(1)} km`);
        try {
          // The audio IS the alert: a driver on a mountain road cannot look
          // at a screen. A TTS failure must never take the app down with it.
          await speakRerouteAlert({
            apiKey: process.env.BHASHINI_API_KEY,
            userId: process.env.BHASHINI_USER_ID,
            language: ALERT_LANG,
            text: 'Warning: landslide ahead. Rerouting.',
          });
        } catch (error) {
          console.warn('[tts]', error.message);
        }
      },
    });

    tracker.current = new Tracker({
      database: database.current,
      socket: socket.current,
      // Bundled asset, not downloaded: it has to be present precisely when
      // there is no network to fetch it with.
      graphPath: `${RNFS.MainBundlePath}/road_graph.sqlite`,
      modelPath: `${RNFS.MainBundlePath}/speed_model.tflite`,
      onFix: setFix,
    });
    tracker.current.truckId = TRUCK_ID;

    const unsubscribe = watchConnectivity({
      onOnline: async () => {
        setMode('online');
        tracker.current.startOnline();
        // Drain first, then resume streaming: the backlog is the older data
        // and the dashboard should paint the dark-zone path before the live
        // marker jumps ahead of it.
        const result = await drain(database.current, {
          apiUrl: API_URL,
          truckId: TRUCK_ID,
          onProgress: ({ sent }) => setQueued((q) => Math.max(0, q - sent)),
        });
        setQueued(await pendingCount(database.current));
        if (result.incomplete) console.warn('[sync] incomplete:', result.error);
      },
      onOffline: async () => {
        setMode('dark-zone');
        const started = await tracker.current.startOffline();
        if (!started) setMode('degraded');
      },
    });

    return () => {
      unsubscribe();
      tracker.current?.stop();
      socket.current?.close();
    };
  }, []);

  // Derived, not stored: `mode` is already the authority on connectivity, and
  // a second piece of state could disagree with it.
  const connected = mode === 'online';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={t.color.bgPanel} />

      <StatusBanner mode={mode} connected={connected} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        // The alert band is pinned below; keep the last row clear of it.
        contentInsetAdjustmentBehavior="automatic"
      >
        <SpeedCluster fix={fix} />
        <PositionReadout fix={fix} />
        <SyncQueue queued={queued} mode={mode} />
      </ScrollView>

      <RerouteAlert alert={alert} onDismiss={() => setAlert(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: t.color.bgBase },
  scroll: { flex: 1 },
  content: { paddingBottom: t.space.xl },
});
