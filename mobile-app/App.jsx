// D.R.I.S.H.T.I. driver client (Epic 4).
//
// Four top-level destinations over one live data path: HUD (full readout),
// MAP (glanceable, map-centric), HAZARD (report + queue), SYNC (diagnostics).
// Nothing about the data path changed with the redesign: GNSS when online, the
// C++ EKF when not, WatermelonDB in between, and Bhashini reading alerts aloud.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaView, StatusBar, View, Text, StyleSheet, Platform } from 'react-native';
import { launchCamera } from 'react-native-image-picker';
import Icon from 'react-native-vector-icons/MaterialIcons';
import RNFS from 'react-native-fs';

import MapCanvas from './src/ui/MapCanvas';
import MapControls from './src/ui/MapControls';
import CorridorPicker from './src/ui/CorridorPicker';
import SpeedCard from './src/ui/SpeedCard';
import HudScreen from './src/ui/HudScreen';
import HazardScreen from './src/ui/HazardScreen';
import DiagnosticsScreen from './src/ui/DiagnosticsScreen';
import IncidentModal from './src/ui/IncidentModal';
import RerouteAlert from './src/ui/RerouteAlert';
import TabBar from './src/ui/TabBar';
import Button from './src/ui/Button';
import { Card, Stat } from './src/ui/Card';
import { t } from './src/ui/tokens';

import { createDatabase } from './src/db';
import { connect } from './src/services/socket';
import { watchConnectivity } from './src/services/network';
import { Tracker } from './src/services/tracking';
import { requestTrackingPermissions } from './src/services/permissions';
import { drain, pendingCount } from './src/services/burstSync';
import { queueHazard, drainHazards, pendingHazardCount } from './src/services/hazardSync';
import { ensureEdgeAssets } from './src/services/edgeAssets';
import { refreshRouteHazards, cachedHazards, toFeatureCollection } from './src/services/hazards';
import { speakAlert } from './src/services/voiceAlert';
import { listCorridors, getCorridor, ensureTrip } from './src/services/corridors';

// NOTE: process.env.* is NOT substituted by React Native's Babel preset --
// only NODE_ENV is. Every one of these falls through to its literal default in
// a release bundle, so the default is the value that actually ships.
const API_URL = process.env.API_URL ?? 'http://172.60.2.75:4000';
const TRUCK_ID = process.env.TRUCK_ID ?? '651692e8-374b-401f-9b9f-e3ed86342ab5';
const ALERT_LANG = process.env.ALERT_LANG ?? 'as';

// ---------------------------------------------------------------- prototype
// Demonstration mode. The handset is not in the North East, so real GNSS puts
// the truck ~1,400 km outside the road graph where nothing snaps, nothing
// routes and no hazard resolves. With this on, the GNSS receiver is replaced
// by a truck driving a real pgr_astar corridor -- everything downstream of the
// fix (socket, WatermelonDB queue, burst sync, backend ingest) is the live
// path, untouched.
//
// Set SIM_DRIVE to false for a road test. Remember that process.env is not
// substituted in a release bundle, so THIS DEFAULT IS WHAT SHIPS.
const SIM_DRIVE = (process.env.SIM_DRIVE ?? 'true') !== 'false';
const SIM_CORRIDOR = process.env.SIM_CORRIDOR ?? 'ghy-shl';
const SIM_SPEED_KMH = Number(process.env.SIM_SPEED_KMH ?? 60);

const MAX_LOGS = 40;

export default function App() {
  const [tab, setTab] = useState('map');
  const [mode, setMode] = useState('starting');
  const [fix, setFix] = useState(null);
  const [queued, setQueued] = useState(0);
  const [hazardQueued, setHazardQueued] = useState(0);
  const [alert, setAlert] = useState(null);
  const [incident, setIncident] = useState(null);
  const [spokenBy, setSpokenBy] = useState(null);
  const [hazards, setHazards] = useState([]);
  const [route, setRoute] = useState(null);
  const [corridors, setCorridors] = useState([]);
  const [corridorId, setCorridorId] = useState(SIM_CORRIDOR);
  const activeCorridor = useRef(null);
  const [corridorBusy, setCorridorBusy] = useState(null);
  // Measured, not assumed. The map control rail used to sit at a fixed 36%
  // from the top, which cleared the stat cards but not the corridor picker
  // added above them -- the RECENTER button ended up behind the card, and
  // recenter is the one control a driver needs when the camera is not on the
  // truck. Anchoring to the real height of the bottom stack means the rail
  // stays clear whatever that stack grows to hold.
  const [bottomH, setBottomH] = useState(0);
  const [picking, setPicking] = useState(false);
  const [linkUp, setLinkUp] = useState(false);
  const [fixAge, setFixAge] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [logs, setLogs] = useState([]);
  const [zoom, setZoom] = useState(14);
  const [followKey, setFollowKey] = useState(0);
  // Follow starts OFF: the map should not seize the viewport before the driver
  // has asked it to.
  // Follows by default. It was opt-in while the only fix source was the
  // handset's own GNSS, where a driver testing indoors wants the map to stay
  // where they put it. With the corridor drive it is the opposite: the truck
  // is the thing to watch, and a first launch that framed the route bounds
  // instead left the truck off-screen with no way back -- see mapControls.
  const [follow, setFollow] = useState(true);
  /// Stable so MapCanvas's gesture handler is not rebuilt on every fix.
  const stopFollowing = useCallback(() => setFollow(false), []);
  const [forecast, setForecast] = useState([]);

  const database = useRef(null);
  const tracker = useRef(null);
  const socket = useRef(null);
  const latestFix = useRef(null);
  const latestFixAt = useRef(null);

  /// Session log feeding the SYNC tab. Real events only -- that screen exists
  /// to be trusted when something has gone wrong, so nothing is invented.
  const log = (level, code, message) => {
    setLogs((current) => [{
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      level, code, message,
      time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
    }, ...current].slice(0, MAX_LOGS));
  };

  // Ask both queues what they actually hold. Called after every persist and on
  // every link transition, so the counters are measurements, never assumptions.
  const refreshQueued = async () => {
    if (!database.current) return;
    try {
      setQueued(await pendingCount(database.current));
      setHazardQueued(await pendingHazardCount(database.current));
    } catch (error) {
      console.warn('[queue]', error.message);
    }
  };

  useEffect(() => {
    let unsubscribe = () => {};
    let disposed = false;

    (async () => {
      database.current = createDatabase();

      socket.current = connect({
        apiUrl: API_URL,
        truckId: TRUCK_ID,
        onConnected: async () => {
          setLinkUp(true);
          log('INFO', 'LINK_UP', 'Socket connected to dispatch.');
          // Drain here, not on the NetInfo transition: the backlog can only go
          // anywhere once the server is provably reachable.
          const result = await drain(database.current, {
            apiUrl: API_URL, truckId: TRUCK_ID,
            onProgress: ({ sent }) => setQueued((q) => Math.max(0, q - sent)),
          });
          if (result.incomplete) log('WARN', 'SYNC_PARTIAL', result.error ?? 'Drain interrupted.');
          else if (result.sent > 0) log('INFO', 'SYNC_OK', `${result.sent} telemetry points delivered.`);

          // Photos go second: telemetry is small and time-ordered, while a
          // photo can occupy a marginal link for a long time.
          const photos = await drainHazards(database.current, {
            apiUrl: API_URL, truckId: TRUCK_ID,
          });
          if (photos.incomplete) log('WARN', 'HAZARD_PARTIAL', photos.error ?? 'Upload interrupted.');
          else if (photos.sent > 0) log('INFO', 'HAZARD_OK', `${photos.sent} hazard report(s) delivered.`);

          setLastSyncAt(Date.now());
          await refreshQueued();
        },
        onDisconnected: (reason) => {
          setLinkUp(false);
          log('WARN', 'LINK_DOWN', `Dispatch link lost${reason ? `: ${reason}` : ''}.`);
        },

        onIncident: async (payload) => {
          if (disposed) return;
          setIncident(payload);
          setSpokenBy(null);
          log('WARN', 'HAZARD_RX', `Dispatch reported ${payload?.kind ?? 'a hazard'} ahead.`);
          if (Number.isFinite(payload?.lat) && Number.isFinite(payload?.lng)) {
            setHazards((current) => [
              ...current.filter((h) => h.id !== payload.id),
              { id: payload.id ?? String(Date.now()), latitude: payload.lat, longitude: payload.lng },
            ]);
          }
          const spoken = await speakAlert({
            language: ALERT_LANG,
            text: hazardSentence(payload),
          });
          if (!disposed) setSpokenBy(spoken.spoken);
        },

        onRouteUpdated: async (payload) => {
          setAlert(`Rerouted — ${(payload.distance_m / 1000).toFixed(1)} km`);
          // The backend sends a GeoJSON LineString object, not a bare
          // coordinate array -- src/services/routing.js returns
          // `{ type: 'LineString', coordinates }` and incidents.js forwards it
          // untouched. An Array.isArray() guard here silently rejected every
          // real reroute, so the route was never drawn and the hazard forecast
          // was never requested. Both shapes are accepted now.
          const line = routeCoordinates(payload?.geometry);
          if (line) {
            setRoute(line);
            refreshHazards(line);
          } else {
            log('WARN', 'ROUTE_NO_GEOM', 'Reroute arrived without usable geometry.');
          }
          log('INFO', 'REROUTE', `New route ${(payload.distance_m / 1000).toFixed(1)} km.`);
          try {
            await speakAlert({
              language: ALERT_LANG,
              text: 'Warning: landslide ahead. Rerouting.',
            });
          } catch (error) {
            console.warn('[tts]', error.message);
          }
        },
      });

      // The engine reads the graph and the model from the filesystem; neither
      // is reachable inside the APK. This extracts them once, and must finish
      // before the Tracker can hand paths to the JNI bridge.
      let graphPath = null;
      let modelPath = null;
      try {
        ({ graphPath, modelPath } = await ensureEdgeAssets());
        log('INFO', 'ASSETS_OK', 'Road graph and speed model extracted.');
      } catch (error) {
        console.error('[edge] asset extraction failed -- dead reckoning is ' +
          'UNAVAILABLE for this session:', error.message);
        log('ERR', 'ASSETS_FAIL', `Dead reckoning unavailable: ${error.message}`);
      }
      if (disposed) return;

      // Ask BEFORE the first watchPosition. Nothing requested these before, so
      // a clean install failed with PERMISSION_DENIED and looked like a GNSS
      // fault; the foreground service additionally refuses to start without
      // location, because Android 14 kills a location-typed service that has
      // no location permission.
      const granted = await requestTrackingPermissions();
      if (!granted.location) {
        log('ERR', 'NO_LOCATION_PERM',
          'Location denied — tracking cannot run. Grant it in Settings.');
      } else if (!granted.notifications) {
        log('WARN', 'NO_NOTIF_PERM',
          'Notifications denied — tracking still runs, but the trip notification is hidden.');
      }
      if (disposed) return;

      // The corridor the prototype drives, and the route the map draws. Both
      // come from the same pgr_astar geometry, so the line under the truck is
      // the line it is actually following -- not a decorative overlay.
      let simulate = null;
      if (SIM_DRIVE) {
        try {
          const list = await listCorridors(API_URL);
          if (!disposed) setCorridors(list);

          const corridor = await getCorridor(API_URL, corridorId);
          activeCorridor.current = corridor;
          const coordinates = corridor?.geometry?.coordinates ?? [];
          if (coordinates.length >= 2) {
            if (!disposed) setRoute(coordinates);
            simulate = { coordinates, speedKmh: SIM_SPEED_KMH, loop: true };

            // Without an ACTIVE trip the backend accepts every fix over the
            // socket and then drops it: recordTelemetry joins through `trip`,
            // gets zero rows and skips the insert WITHOUT raising. The
            // dashboard would show a truck that never moves.
            try {
              await ensureTrip(API_URL, TRUCK_ID, corridor);
              log('INFO', 'TRIP_OPEN', `Trip open on ${corridor.name}.`);
            } catch (error) {
              log('WARN', 'TRIP_FAIL',
                `No active trip (${error.message}) — fixes may not persist.`);
            }

            log('INFO', 'SIM_DRIVE',
              `Simulating ${corridor.name} — ${(corridor.distance_m / 1000).toFixed(1)} km `
              + `at ${SIM_SPEED_KMH} km/h.`);
            refreshHazards(coordinates);
          }
        } catch (error) {
          log('ERR', 'SIM_FAIL', `Corridor unavailable: ${error.message}`);
        }
      }
      if (disposed) return;

      tracker.current = new Tracker({
        database: database.current,
        socket: socket.current,
        simulate,
        graphPath: graphPath ?? `${RNFS.DocumentDirectoryPath}/road_graph.sqlite`,
        modelPath: modelPath ?? `${RNFS.DocumentDirectoryPath}/speed_model.tflite`,
        onFix: (next) => {
          latestFix.current = next;
          latestFixAt.current = Date.now();
          setFix(next);
        },
        onQueued: refreshQueued,
      });
      tracker.current.truckId = TRUCK_ID;

      unsubscribe = watchConnectivity({
        onOnline: async () => {
          setMode('online');
          tracker.current?.startOnline();
          await refreshQueued();
        },
        onOffline: async () => {
          setMode('dark-zone');
          log('WARN', 'DARK_ZONE', 'Network lost — switching to dead reckoning.');
          const started = await tracker.current?.startOffline();
          if (!started) {
            setMode('degraded');
            log('ERR', 'DR_NO_SEED', 'No GNSS fix to seed dead reckoning.');
          }
        },
      });

      await refreshQueued();
      // Cached forecast first, network second. A truck that started the shift
      // in a dark zone must still see the hazards it was told about earlier.
      setForecast(await cachedHazards(database.current));
    })();

    return () => {
      disposed = true;
      unsubscribe();
      tracker.current?.stop();
      socket.current?.close();
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setFixAge(latestFixAt.current ? Date.now() - latestFixAt.current : 0);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /// Ask the model for hazards along a route and cache them. Never throws:
  /// a failed refresh leaves the previous warnings in place, because "no
  /// hazards" and "could not ask" must not look the same.
  /**
   * Change the demonstration corridor without restarting the app.
   *
   * The route the map draws and the route the truck drives are set from the
   * SAME geometry here, so they cannot disagree -- a picker that redrew the
   * line without moving the truck would be a worse lie than no picker.
   */
  const switchCorridor = async (id) => {
    if (!id || id === corridorId || corridorBusy) return;
    setCorridorBusy(id);
    try {
      const corridor = await getCorridor(API_URL, id);
      const coordinates = corridor?.geometry?.coordinates ?? [];
      if (coordinates.length < 2) throw new Error('corridor has no geometry');

      activeCorridor.current = corridor;
      setCorridorId(id);
      setRoute(coordinates);
      tracker.current?.setCorridor(coordinates, SIM_SPEED_KMH);

      try {
        await ensureTrip(API_URL, TRUCK_ID, corridor);
      } catch (error) {
        log('WARN', 'TRIP_FAIL', `No active trip: ${error.message}`);
      }
      log('INFO', 'CORRIDOR', `Now driving ${corridor.name} — `
        + `${(corridor.distance_m / 1000).toFixed(1)} km.`);
      refreshHazards(coordinates);
    } catch (error) {
      log('ERR', 'CORRIDOR_FAIL', `Could not load corridor: ${error.message}`);
    } finally {
      setCorridorBusy(null);
    }
  };

  const refreshHazards = async (coordinates) => {
    if (!database.current) return;
    const result = await refreshRouteHazards(database.current, {
      apiUrl: API_URL, coordinates,
    });
    setForecast(result.hazards);
    if (result.fetched) {
      log('INFO', 'HAZARD_FORECAST',
        `${result.hazards.length} predicted hazard(s) over ${result.sampled} sampled point(s).`);
    } else {
      log('WARN', 'HAZARD_FORECAST_STALE',
        `Using cached forecast: ${result.error}`);
    }
  };

  const reportHazard = async () => {
    const here = latestFix.current;
    if (!here) {
      setAlert('No position fix yet — a report cannot be placed on the map');
      return;
    }
    setPicking(true);
    try {
      const result = await launchCamera({
        mediaType: 'photo', quality: 0.7,
        maxWidth: 1600, maxHeight: 1600, saveToPhotos: false,
      });
      if (result?.didCancel || !result?.assets?.length) return;

      const asset = result.assets[0];
      // Written to WatermelonDB BEFORE any network is attempted. A landslide
      // is reported from precisely the places with no signal.
      await queueHazard(database.current, {
        uri: asset.uri,
        mimeType: asset.type ?? 'image/jpeg',
        latitude: here.latitude,
        longitude: here.longitude,
        kind: 'obstruction',
      });
      log('INFO', 'HAZARD_QUEUED', 'Hazard photo saved on device.');
      await refreshQueued();

      if (linkUp) {
        await drainHazards(database.current, { apiUrl: API_URL, truckId: TRUCK_ID });
        setLastSyncAt(Date.now());
        await refreshQueued();
      }
    } catch (error) {
      console.warn('[hazard]', error.message);
      log('ERR', 'HAZARD_FAIL', error.message);
      setAlert(`Could not capture the report: ${error.message}`);
    } finally {
      setPicking(false);
    }
  };

  const heading = fix?.heading ?? fix?.heading_deg ?? fix?.headingDeg;
  const altitude = fix?.altitude ?? fix?.altitude_m;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="transparent" translucent />

      <View style={styles.header}>
        <Icon name="podcasts" size={22}
              color={linkUp ? t.color.accent : t.color.textMuted}
              importantForAccessibility="no" />
        <Text style={styles.wordmark} accessibilityRole="header">D.R.I.S.H.T.I.</Text>
        <Icon
          name={linkUp ? 'signal-cellular-alt' : 'signal-cellular-connected-no-internet-4-bar'}
          size={22}
          color={linkUp ? t.color.accent : t.color.alertText}
          accessibilityLabel={linkUp ? 'Dispatch link up' : 'Dispatch link down'}
        />
      </View>

      <View style={styles.body}>
        {tab === 'map' ? (
          <MapCanvas
            fix={fix} route={route} hazards={hazards}
            forecast={toFeatureCollection(forecast)}
            zoom={zoom} follow={follow} followKey={followKey}
            // A drag, pinch or rotate hands the viewport to the driver. The
            // recentre button below is the only way back, which is the
            // Google Maps contract and the one drivers already expect.
            onUserPan={stopFollowing}
          >
            <View style={styles.mapTop} pointerEvents="box-none">
              <SpeedCard fix={fix} mode={mode} ageMs={fixAge} />
            </View>

            <MapControls
              style={[styles.mapControls, { bottom: bottomH + t.space.md }]}
              onZoomIn={() => setZoom((z) => Math.min(18, z + 1))}
              onZoomOut={() => setZoom((z) => Math.max(3, z - 1))}
              onRecenter={() => { setFollow(true); setFollowKey((k) => k + 1); }}
              follow={follow}
              onToggleFollow={() => setFollow((f) => !f)}
            />

            <View
              style={styles.mapBottom}
              pointerEvents="box-none"
              onLayout={(e) => setBottomH(e.nativeEvent.layout.height)}
            >
              {SIM_DRIVE ? (
                <CorridorPicker
                  corridors={corridors}
                  activeId={corridorId}
                  busy={corridorBusy}
                  onSelect={switchCorridor}
                />
              ) : null}

              <View style={styles.statRow}>
                <Card style={styles.statCard}>
                  <Stat label="BEARING" unit="°"
                        value={Number.isFinite(heading) ? pad3(heading) : '—'} />
                </Card>
                <Card style={[styles.statCard, styles.statCardRight]}>
                  <Stat label="ALTITUDE" unit="m"
                        value={Number.isFinite(altitude) ? Math.round(altitude) : '—'} />
                </Card>
              </View>

              <Button
                label="Report Hazard"
                icon="warning"
                onPress={reportHazard}
                disabled={picking}
                accessibilityHint="Photographs a road hazard and queues it for dispatch"
              />
            </View>
          </MapCanvas>
        ) : null}

        {tab === 'hud' ? (
          <HudScreen fix={fix} mode={mode} linkUp={linkUp} ageMs={fixAge} />
        ) : null}

        {tab === 'hazard' ? (
          <HazardScreen
            onReport={reportHazard}
            picking={picking}
            hazardQueued={hazardQueued}
            linkUp={linkUp}
            canReport={Boolean(fix)}
          />
        ) : null}

        {tab === 'sync' ? (
          <DiagnosticsScreen
            mode={mode} linkUp={linkUp} fix={fix}
            queued={queued} hazardQueued={hazardQueued}
            lastSyncAt={lastSyncAt} logs={logs}
            onClearLogs={() => setLogs([])}
          />
        ) : null}
      </View>

      <View style={styles.tabWrap}>
        <TabBar
          active={tab}
          onChange={setTab}
          badges={{ hazard: hazardQueued || undefined, sync: queued || undefined }}
        />
      </View>

      <RerouteAlert alert={alert} onDismiss={() => setAlert(null)} />

      <IncidentModal
        incident={incident}
        spokenBy={spokenBy}
        onDismiss={() => setIncident(null)}
        onViewMap={() => { setIncident(null); setTab('map'); }}
      />
    </SafeAreaView>
  );
}

/// Normalise whatever the backend sent into [[lng, lat], ...], or null.
function routeCoordinates(geometry) {
  if (Array.isArray(geometry) && geometry.length >= 2) return geometry;
  const coords = geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) return coords;
  return null;
}

/// What the driver hears. Short and imperative: it is spoken aloud at speed.
function hazardSentence(payload) {
  const kind = payload?.kind ?? 'obstruction';
  const noun = kind === 'landslide' ? 'Landslide'
    : kind === 'flood' ? 'Flooding'
      : 'Road obstruction';
  return `Warning: ${noun} reported ahead. Slow down and proceed with caution.`;
}

/// 007°, not 7° — a bearing is always three digits on an instrument.
function pad3(n) {
  return String(Math.round(n)).padStart(3, '0');
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: t.color.bgBase },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.color.bgPanel,
    paddingHorizontal: t.space.lg,
    paddingBottom: t.space.sm,
    // The status bar is translucent so the map runs full-bleed behind it.
    paddingTop: (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0) + t.space.sm,
    borderBottomWidth: t.hairline, borderBottomColor: t.color.border,
  },
  wordmark: {
    fontFamily: t.font.sansMedium, fontSize: t.type.title, fontWeight: '800',
    color: t.color.accent, letterSpacing: 1.2,
  },
  body: { flex: 1 },
  mapTop: {
    position: 'absolute', top: t.space.md, left: t.space.lg, right: t.space.lg,
  },
  mapControls: { position: 'absolute', right: t.space.lg },
  mapBottom: {
    position: 'absolute', left: t.space.lg, right: t.space.lg, bottom: t.space.md,
  },
  statRow: { flexDirection: 'row', marginBottom: t.space.md },
  statCard: { flex: 1, paddingVertical: t.space.md },
  statCardRight: { marginLeft: t.space.md },
  tabWrap: { paddingBottom: t.space.md, paddingTop: t.space.sm },
});
