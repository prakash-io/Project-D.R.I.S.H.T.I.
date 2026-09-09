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
import ErrorBoundary from './src/ui/ErrorBoundary';
import MapRail from './src/ui/MapRail';
import CorridorPicker from './src/ui/CorridorPicker';
import NavCard from './src/ui/NavCard';
import SpeedBubble from './src/ui/SpeedBubble';
import LinkChip from './src/ui/LinkChip';
import RouteSheet from './src/ui/RouteSheet';
import HudScreen from './src/ui/HudScreen';
import HazardScreen from './src/ui/HazardScreen';
import DiagnosticsScreen from './src/ui/DiagnosticsScreen';
import IncidentModal from './src/ui/IncidentModal';
import RerouteAlert from './src/ui/RerouteAlert';
import RerouteSheet from './src/ui/RerouteSheet';
import RoutePlanner, { HERE } from './src/ui/RoutePlanner';
import SourceToggle from './src/ui/SourceToggle';
import TabBar from './src/ui/TabBar';
import { Card, Stat } from './src/ui/Card';
import { t } from './src/ui/tokens';

import { createDatabase } from './src/db';
import { connect } from './src/services/socket';
import { watchConnectivity } from './src/services/network';
import { Tracker } from './src/services/tracking';
import { requestTrackingPermissions, requestCameraPermission } from './src/services/permissions';
import { drain, pendingCount } from './src/services/burstSync';
import { queueHazard, drainHazards, pendingHazardCount } from './src/services/hazardSync';
import { ensureEdgeAssets } from './src/services/edgeAssets';
import { refreshRouteHazards, cachedHazards, toFeatureCollection } from './src/services/hazards';
import { speakAlert } from './src/services/voiceAlert';
import { listCorridors, getCorridor, ensureTrip } from './src/services/corridors';
import { listPlaces, planTrip, ackReroute, routeCoordinates }
  from './src/services/routePlanner';
// Compile-time injection from .env, the same mechanism src/services/bhashini.js
// already uses. This file previously read process.env.* directly, which React
// Native's preset does NOT substitute -- so every value below silently fell
// through to its hardcoded literal and the shipped bundle pointed at whatever
// LAN address the machine happened to have on build day. That is a build-time
// constant either way; routing it through @env is what makes it CHANGEABLE
// without editing source.
import {
  API_URL as ENV_API_URL,
  TRUCK_ID as ENV_TRUCK_ID,
  ALERT_LANG as ENV_ALERT_LANG,
  SIM_DRIVE as ENV_SIM_DRIVE,
  SIM_CORRIDOR as ENV_SIM_CORRIDOR,
  SIM_SPEED_KMH as ENV_SIM_SPEED_KMH,
} from '@env';

// Resolved at BUILD time from mobile-app/.env (react-native-dotenv). The
// literals below are the last-resort defaults if a key is missing from .env;
// allowUndefined is on, so a missing key is `undefined` rather than a build
// error. Change .env and rebuild -- see scripts/build_apk.sh.
const API_URL = ENV_API_URL ?? 'http://172.60.2.75:4000';
const TRUCK_ID = ENV_TRUCK_ID ?? '651692e8-374b-401f-9b9f-e3ed86342ab5';
const ALERT_LANG = ENV_ALERT_LANG ?? 'as';

// ---------------------------------------------------------------- prototype
// Demonstration mode. The handset is not in the North East, so real GNSS puts
// the truck ~1,400 km outside the road graph where nothing snaps, nothing
// routes and no hazard resolves. With this on, the GNSS receiver is replaced
// by a truck driving a real pgr_astar corridor -- everything downstream of the
// fix (socket, WatermelonDB queue, burst sync, backend ingest) is the live
// path, untouched.
//
// SIM_DRIVE is now only the STARTING position of a runtime toggle, not the
// mode for the whole session -- the driver flips between the corridor drive
// and this handset's GNSS from the map screen (SourceToggle). Remember that
// process.env is not substituted in a release bundle, so THIS DEFAULT IS WHAT
// SHIPS as the initial state.
const SIM_DRIVE = (ENV_SIM_DRIVE ?? 'true') !== 'false';
const SIM_CORRIDOR = ENV_SIM_CORRIDOR ?? 'ghy-shl';
const SIM_SPEED_KMH = Number(ENV_SIM_SPEED_KMH ?? 60);

const MAX_LOGS = 40;

export default function App() {
  const [tab, setTab] = useState('map');
  const [mode, setMode] = useState('starting');
  const [fix, setFix] = useState(null);
  const [queued, setQueued] = useState(0);
  const [hazardQueued, setHazardQueued] = useState(0);
  const [alert, setAlert] = useState(null);
  const [incident, setIncident] = useState(null);
  /// What each hazard actually costs this truck, keyed by incident id.
  ///
  /// The alert modal quotes an extra distance and a delay, and those two
  /// numbers are NOT on `incident_reported` -- that event is the incidents row
  /// itself, which has no idea what any particular truck's detour looks like.
  /// They arrive on `route_updated`, and on the approval path the backend
  /// reroutes BEFORE it broadcasts the incident, so by the time the modal
  /// opens the figures have already gone past. Held in a ref so a late
  /// reroute, or an early one, both end up on the card.
  const rerouteCost = useRef(new Map());
  const [spokenBy, setSpokenBy] = useState(null);
  const [hazards, setHazards] = useState([]);
  const [route, setRoute] = useState(null);
  /// Distance and ETA for whatever `route` currently holds. Null until the
  /// backend has costed a route -- the driver client does not estimate its
  /// own ETA, because the graph the estimate comes from lives on the server.
  const [routeEta, setRouteEta] = useState(null);
  /// Where the position comes from. Runtime, not build-time: see SourceToggle.
  const [isSimulated, setIsSimulated] = useState(SIM_DRIVE);
  /// The routable place list feeding the origin/destination fields.
  const [places, setPlaces] = useState([]);
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState(null);
  /// A reroute the backend has OFFERED and the driver has not answered.
  /// Holding it here rather than applying it is the whole accept flow: the
  /// map keeps the road the driver chose until they tap Accept.
  const [proposal, setProposal] = useState(null);
  const [answering, setAnswering] = useState(false);
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
  // The route sheet: null, or which section the driver asked for. Everything
  // that used to be stacked permanently over the map lives in here.
  const [sheet, setSheet] = useState(null);
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

          // An unapproved report is addressed to the driver who SENT it and
          // to nobody else. The backend enforces that by room -- it emits to
          // `truck:<reporter>` and to the dispatchers rather than broadcasting
          // -- and this is the second lock on the same door: a handset running
          // against an older server, or against one where the scoping was
          // reverted, still refuses to raise a full-screen hazard alert about
          // a photograph another driver just uploaded.
          //
          // The check is on the REPORTER, not on the scope alone, because
          // "awaiting approval" is exactly the state in which the reporter
          // does want their receipt.
          const unapproved = payload?.scope === 'awaiting_approval'
            || payload?.requires_approval === true;
          const mine = payload?.reported_by_truck === TRUCK_ID
            || payload?.reported_by === TRUCK_ID;
          if (unapproved && payload?.reported_by_truck !== undefined && !mine) {
            log('INFO', 'HAZARD_SKIP',
                'Another driver filed a report; waiting for dispatch to approve it.');
            return;
          }

          // Attach the detour figures if this hazard has already been costed
          // for us. `costed` distinguishes "no detour exists" from "the detour
          // is still being calculated", which the card has to say differently:
          // a driver seeing a blank delay must know whether the answer is
          // zero or not yet.
          setIncident({ ...payload, ...(rerouteCost.current.get(payload?.id) ?? {}) });
          setSpokenBy(null);
          log(unapproved ? 'INFO' : 'WARN',
              unapproved ? 'HAZARD_SENT' : 'HAZARD_RX',
              unapproved
                ? `Your ${payload?.kind ?? 'hazard'} report is with dispatch.`
                : `Dispatch confirmed ${payload?.kind ?? 'a hazard'} ahead.`);
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

        // A detour has been costed for this truck. It arrives as an OFFER:
        // nothing on the map changes until the driver taps Accept. See
        // RerouteSheet for why that tap has to exist.
        onRouteUpdated: async (payload) => {
          // The reroute payload names its figures new_distance_m /
          // estimated_time_sec (workflow section 4). distance_m is still sent
          // alongside and is read here as a fallback so a backend that has
          // not been redeployed yet still drives the banner.
          const distanceM = payload?.new_distance_m ?? payload?.distance_m;
          const durationSec = payload?.estimated_time_sec;

          // Remember what this detour costs, against the hazard that caused
          // it, so the alert card can quote it whichever event lands first.
          const causedBy = payload?.incident?.id ?? payload?.incident_id;
          if (causedBy) {
            const cost = {
              costed: true,
              extra_distance_m: payload?.delta_distance_m ?? null,
              delay_sec: payload?.delta_time_sec ?? null,
            };
            rerouteCost.current.set(causedBy, cost);
            // If the card for this hazard is already open, fill it in place
            // rather than waiting for the driver to dismiss and re-open it.
            setIncident((shown) => (shown?.id === causedBy ? { ...shown, ...cost } : shown));
          }
          // The backend sends a GeoJSON LineString object, not a bare
          // coordinate array -- src/services/routing.js returns
          // `{ type: 'LineString', coordinates }` and incidents.js forwards it
          // untouched. An Array.isArray() guard here silently rejected every
          // real reroute, so the route was never drawn and the hazard forecast
          // was never requested. Both shapes are accepted now.
          // route_geom is the current name; the geometry is sent once under
          // it rather than duplicated under both keys, because these paths run
          // to thousands of coordinates over a 3G link.
          const line = routeCoordinates(payload?.route_geom ?? payload?.geometry);
          if (!line) {
            log('WARN', 'ROUTE_NO_GEOM', 'Reroute arrived without usable geometry.');
            return;
          }

          // An older backend sends no reroute_id, so there is nothing the
          // driver could answer and nothing to record their answer against.
          // Applying it immediately is then the only honest option, and it is
          // exactly what this client did before -- so a handset on a new build
          // still works against a server that has not been redeployed.
          if (!payload?.reroute_id || payload?.requires_ack === false) {
            applyRoute(line, { distanceM, durationSec, rerouted: true });
            setAlert(`Rerouted — ${(distanceM / 1000).toFixed(1)} km`);
            log('INFO', 'REROUTE',
                `New route ${(distanceM / 1000).toFixed(1)} km`
                + (Number.isFinite(durationSec)
                    ? `, about ${Math.round(durationSec / 60)} min.` : '.'));
            try {
              await speakAlert({
                language: ALERT_LANG,
                text: 'Warning: landslide ahead. Rerouting.',
              });
            } catch (error) {
              console.warn('[tts]', error.message);
            }
            return;
          }

          setProposal({
            rerouteId: payload.reroute_id,
            coordinates: line,
            distanceM,
            durationSec,
            deltaDistanceM: payload.delta_distance_m,
            deltaTimeSec: payload.delta_time_sec,
            kind: payload.incident?.kind ?? null,
          });
          log('WARN', 'REROUTE_OFFERED',
              `Detour offered: ${(distanceM / 1000).toFixed(1)} km`
              + (Number.isFinite(durationSec)
                  ? `, about ${Math.round(durationSec / 60)} min.` : '.')
              + ' Awaiting the driver.');

          // Spoken, because the driver must not have to look down to learn
          // there is a landslide ahead. The figures come with it: a driver who
          // has heard "96 kilometres, 3 hours" can decide before the phone is
          // even in view.
          try {
            await speakAlert({
              language: ALERT_LANG,
              text: hazardSentence(payload?.incident)
                + ` A new route is available: ${(distanceM / 1000).toFixed(0)} kilometres`
                + (Number.isFinite(durationSec)
                    ? `, about ${Math.round(durationSec / 60)} minutes.` : '.'),
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
      // The destination list. Fetched whatever the position source is: a
      // driver on real GNSS still has to be able to say where they are going.
      // Never throws -- it answers from an on-device cache when dispatch is
      // unreachable, which is the case a truck starting its shift in a valley
      // is actually in.
      const known = await listPlaces(API_URL);
      if (!disposed) setPlaces(known);
      if (known.length === 0) {
        log('WARN', 'PLACES_EMPTY',
          'No destinations available yet — the list will load when dispatch is reachable.');
      }

      // The corridor LIST is metadata only, ~3 KB, so it is fetched whatever
      // the source: the picker has to be populated the moment the driver
      // switches to the demonstration drive. The GEOMETRY is not -- one
      // corridor runs to thousands of coordinates, and there is no reason to
      // pull it on a session that never leaves real GNSS.
      const list = await listCorridors(API_URL);
      if (!disposed) setCorridors(list);

      let simulate = null;
      if (SIM_DRIVE) {
        try {
          const corridor = await getCorridor(API_URL, corridorId);
          activeCorridor.current = corridor;
          const coordinates = corridor?.geometry?.coordinates ?? [];
          if (coordinates.length >= 2) {
            if (!disposed) {
              setRoute(coordinates);
              // The corridor's own distance, so the summary card is populated
              // from launch rather than appearing for the first time when
              // something goes wrong -- which is what taught the driver to
              // read that card as bad news. No ETA: /routes/corridors does
              // not carry one and this client will not invent it.
              setRouteEta({ distanceM: corridor.distance_m, rerouted: false });
              // Seed the planner fields from the corridor, so the two ends
              // shown in the form are the ends of the road on the map. Left
              // blank they would invite the driver to "plan" a route that is
              // already drawn under their truck.
              setOrigin(asPlace(known, corridor.origin_name,
                corridor.origin_lat, corridor.origin_lng));
              setDestination(asPlace(known, corridor.destination_name,
                corridor.destination_lat, corridor.destination_lng));
            }
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

  /**
   * Put a route on the map, and keep everything that depends on it in step.
   *
   * ONE path for every source of a route -- the boot corridor, the corridor
   * picker, a plan the driver typed, an accepted detour. They used to each do
   * their own subset of this, which is how the corridor picker ended up
   * redrawing the line without moving the truck: a map showing a road the
   * vehicle is not on is a worse lie than no map.
   *
   * setCorridor is called unconditionally and is deliberately cheap when the
   * driver is on real GNSS: it STORES the geometry without starting a drive,
   * so the demonstration toggle has something to run the moment it is flipped.
   */
  const applyRoute = (coordinates, eta) => {
    setRoute(coordinates);
    setRouteEta(eta ?? null);
    tracker.current?.setCorridor(coordinates, SIM_SPEED_KMH);
    refreshHazards(coordinates);
  };

  /// The driver's own position as a place, for "My location" as an origin.
  /// Read from the ref rather than from `fix`, so a handler built on an
  /// earlier render still routes from where the truck is now.
  const fixAsPlace = () => {
    const here = latestFix.current;
    if (!here) return null;
    return { id: HERE.id, name: HERE.name, lat: here.latitude, lng: here.longitude };
  };

  /**
   * Plan the driver's route and open the trip on it.
   *
   * One server call does both -- see planTrip for why they are the same act.
   * A failure is shown IN the planner card rather than as a passing banner:
   * the driver is looking at the form, and the answer to "why did nothing
   * happen" has to be where they are looking.
   */
  const planRoute = async () => {
    if (planning) return;
    const from = origin?.id === HERE.id ? fixAsPlace() : origin;
    const to = destination;
    if (!from) {
      setPlanError('No position fix yet — "My location" cannot be used as a start.');
      return;
    }
    if (!to || from.id === to.id) {
      setPlanError('Choose two different places.');
      return;
    }

    setPlanning(true);
    setPlanError(null);
    try {
      const planned = await planTrip(API_URL, TRUCK_ID, from, to);
      applyRoute(planned.coordinates, {
        distanceM: planned.distanceM,
        durationSec: planned.durationSec,
        rerouted: false,
      });
      // Any outstanding offer was costed against a road the driver has just
      // abandoned. Leaving it up would let them accept a detour around a
      // hazard that is no longer on their way.
      setProposal(null);
      setPlannerOpen(false);
      log('INFO', 'ROUTE_PLANNED',
        `${from.name} → ${to.name}: ${(planned.distanceM / 1000).toFixed(1)} km`
        + (Number.isFinite(planned.durationSec)
            ? `, about ${Math.round(planned.durationSec / 60)} min.` : '.'));
    } catch (error) {
      setPlanError(error.message);
      log('ERR', 'ROUTE_FAIL', `Could not plan the route: ${error.message}`);
    } finally {
      setPlanning(false);
    }
  };

  /**
   * Flip the position source between the corridor drive and this handset.
   *
   * Refuses rather than silently doing nothing when there is no route to
   * drive: a toggle that appears to switch and then leaves the truck
   * motionless is indistinguishable from a broken GNSS receiver, which is the
   * exact diagnosis this screen exists to make possible.
   */
  const changeSource = (next) => {
    if (next === isSimulated) return;
    if (!tracker.current) {
      setAlert('Tracking is still starting up.');
      return;
    }
    if (tracker.current.setSimulated(next) === false) {
      setAlert('Plan a route or pick a corridor first — there is nothing to drive.');
      return;
    }
    setIsSimulated(next);
    log('INFO', 'SOURCE', next
      ? 'Position source: simulated corridor drive.'
      : 'Position source: this handset\'s GNSS receiver.');
  };

  /**
   * The driver takes the detour.
   *
   * The map switches FIRST and dispatch is told second, and that order is not
   * an optimisation. The tap happens on a mountain road in front of a
   * landslide, on a link that may not exist; making the new route wait on a
   * round trip would leave the driver staring at the blocked road while a
   * request times out. The acknowledgement is best-effort and idempotent, so
   * a lost one costs a record, not a reroute.
   */
  const acceptReroute = async () => {
    const offer = proposal;
    if (!offer || answering) return;
    setAnswering(true);
    applyRoute(offer.coordinates, {
      distanceM: offer.distanceM, durationSec: offer.durationSec, rerouted: true,
    });
    setProposal(null);
    setAlert(`Rerouted — ${(offer.distanceM / 1000).toFixed(1)} km`);
    log('INFO', 'REROUTE_ACCEPTED',
      `Driver accepted the detour: ${(offer.distanceM / 1000).toFixed(1)} km.`);
    try {
      await speakAlert({ language: ALERT_LANG, text: 'Rerouting now.' });
    } catch (error) {
      console.warn('[tts]', error.message);
    }
    const ack = await ackReroute(API_URL, offer.rerouteId, true);
    if (!ack.ok) {
      log('WARN', 'ACK_FAIL', `Dispatch was not told the reroute was accepted: ${ack.error}`);
    }
    setAnswering(false);
  };

  /**
   * The driver stays on the road they are on.
   *
   * This is a real answer, not a dismissal, and the server acts on it: the
   * trip is put back on the superseded path so the dispatcher's board does
   * not show this truck on a detour it refused.
   */
  const declineReroute = async () => {
    const offer = proposal;
    if (!offer || answering) return;
    setAnswering(true);
    setProposal(null);
    log('WARN', 'REROUTE_DECLINED',
      'Driver kept the current route — the hazard is still ahead of them.');
    const ack = await ackReroute(API_URL, offer.rerouteId, false);
    if (!ack.ok) {
      log('WARN', 'ACK_FAIL', `Dispatch was not told the reroute was declined: ${ack.error}`);
    }
    setAnswering(false);
  };

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
      // A corridor is costed by the server, but /routes/corridors carries only
      // its distance -- there is no stored ETA for it -- so the summary card
      // is given the distance and left honest about the missing duration
      // rather than shown a number this client invented.
      applyRoute(coordinates, { distanceM: corridor.distance_m, rerouted: false });
      setOrigin(asPlace(places, corridor.origin_name,
        corridor.origin_lat, corridor.origin_lng));
      setDestination(asPlace(places, corridor.destination_name,
        corridor.destination_lat, corridor.destination_lng));
      // A corridor change replaces the road; an offer against the road it
      // replaced is no longer a question the driver can answer.
      setProposal(null);

      try {
        await ensureTrip(API_URL, TRUCK_ID, corridor);
      } catch (error) {
        log('WARN', 'TRIP_FAIL', `No active trip: ${error.message}`);
      }
      log('INFO', 'CORRIDOR', `Now driving ${corridor.name} — `
        + `${(corridor.distance_m / 1000).toFixed(1)} km.`);
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
      // Asked here, not at launch: see requestCameraPermission. Without this
      // the library refuses to open the camera -- AndroidManifest declares
      // CAMERA, so it insists the app hold it -- and returns an error that
      // used to be swallowed below as though the driver had cancelled.
      if (!(await requestCameraPermission())) {
        log('WARN', 'HAZARD_NO_CAMERA', 'Camera permission refused.');
        setAlert('Drishti needs camera access to report a hazard. '
          + 'Allow it in Settings › Apps › Drishti › Permissions.');
        return;
      }

      const result = await launchCamera({
        mediaType: 'photo', quality: 0.7,
        maxWidth: 1600, maxHeight: 1600, saveToPhotos: false,
      });
      // A cancel is the driver changing their mind and says nothing. An
      // errorCode is the app failing, and it must never look the same: this
      // branch used to lump them together, so every failure was a tap that
      // did nothing with not one line in the log to explain it.
      if (result?.didCancel) return;
      if (result?.errorCode) {
        throw new Error(result.errorMessage ?? `camera error: ${result.errorCode}`);
      }
      if (!result?.assets?.length) throw new Error('the camera returned no photo');

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

      {/* The map is the only screen that earns a full-bleed surface, so it is
          the only one that loses the opaque header: an 80pt white band across
          the top of a navigation display buys a wordmark at the price of the
          road ahead. The brand and the link status are still there on the map,
          floating over it, in about a fifth of the height. The other three
          tabs are ordinary scrolling screens and keep the bar. */}
      {tab !== 'map' ? (
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
      ) : null}

      <View style={styles.body}>
        {/* The map is a native MapLibre surface, and this app has never been
            rendered on a handset -- so it is the single most likely thing here
            to fail on the first APK. Boundaried so that a map that will not
            mount costs the driver the map and nothing else: the tab bar still
            works, the HUD still shows speed and heading from the same fix, the
            hazard report still queues, and tracking never stopped. Without
            this, one native view failing blanks the entire app in exactly the
            place it is needed most. */}
        {tab === 'map' ? (
          <ErrorBoundary label="Map">
          <MapCanvas
            fix={fix} route={route}
            // The offered detour, drawn dashed BESIDE the current route. The
            // driver can see where it would take them before deciding, which
            // is the point of asking rather than telling.
            proposedRoute={proposal?.coordinates}
            hazards={hazards}
            forecast={toFeatureCollection(forecast)}
            zoom={zoom} follow={follow} followKey={followKey}
            // A drag, pinch or rotate hands the viewport to the driver. The
            // follow button on the rail is the only way back, which is the
            // Google Maps contract and the one drivers already expect.
            onUserPan={stopFollowing}
          >
            {/* LEVEL 1 -- always on the glass, and only these. Brand and link
                status on one line, then the single card that answers "where am
                I going and how far is left". Four cards used to say that. */}
            <View style={styles.mapTop} pointerEvents="box-none">
              <View style={styles.brandRow} pointerEvents="box-none">
                <View style={styles.brand}>
                  <Icon name="podcasts" size={15} color={t.color.accent}
                        importantForAccessibility="no" />
                  <Text style={styles.brandMark} accessibilityRole="header">
                    D.R.I.S.H.T.I.
                  </Text>
                </View>
                <LinkChip mode={mode} linkUp={linkUp} queued={queued} />
              </View>

              <NavCard
                destination={destination}
                distanceM={routeEta?.distanceM}
                durationSec={routeEta?.durationSec}
                rerouted={routeEta?.rerouted}
                onPress={() => setSheet('plan')}
                style={styles.navCard}
              />
            </View>

            <MapRail
              style={styles.mapRail}
              onZoomIn={() => setZoom((z) => Math.min(18, z + 1))}
              onZoomOut={() => setZoom((z) => Math.max(3, z - 1))}
              follow={follow}
              // Recentre and follow were two buttons holding two pieces of
              // state; to the driver they are one intent. Released, it flies
              // the camera back and re-arms following -- which is exactly what
              // the old recentre button did. Lit, it hands the viewport back.
              onFollow={() => {
                if (follow) { setFollow(false); return; }
                setFollow(true);
                setFollowKey((k) => k + 1);
              }}
              onSearch={() => { setPlannerOpen(true); setSheet('plan'); }}
              onRoutes={() => { setPlannerOpen(false); setSheet('routes'); }}
              onReport={reportHazard}
              reporting={picking}
            />

            {/* LEVEL 2 -- small, floating, bottom-left, clear of the rail. */}
            <SpeedBubble fix={fix} mode={mode} ageMs={fixAge}
                         style={styles.speedBubble} />
          </MapCanvas>
          </ErrorBoundary>
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

      {/* LEVEL 3 -- the planner, the position source, the ten corridors and
          the instruments. All of it still here, all of it one tap down. Kept
          below RerouteAlert and RerouteSheet in the tree so a hazard offer is
          never hidden behind a panel the driver opened to browse corridors. */}
      <RouteSheet open={sheet !== null} onClose={() => setSheet(null)}>
        <RoutePlanner
          places={places}
          origin={origin}
          destination={destination}
          hasFix={Boolean(fix)}
          open={plannerOpen}
          onOpenChange={setPlannerOpen}
          planning={planning}
          error={planError}
          onChange={(field, place) => {
            if (field === 'origin') setOrigin(place); else setDestination(place);
          }}
          onSwap={() => { setOrigin(destination); setDestination(origin); }}
          onPlan={planRoute}
          onClearError={() => setPlanError(null)}
        />

        <SourceToggle
          simulated={isSimulated}
          onChange={changeSource}
          disabled={!route}
          routeName={origin && destination
            ? `${origin.name} → ${destination.name}`
            : (activeCorridor.current?.name ?? null)}
        />

        {isSimulated ? (
          <CorridorPicker
            corridors={corridors}
            activeId={corridorId}
            busy={corridorBusy}
            onSelect={switchCorridor}
          />
        ) : null}

        {/* Bearing and altitude read from the same fix as the speed bubble.
            They are instruments, not driving controls -- looked at when
            someone asks, which is what this sheet is for. */}
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
      </RouteSheet>

      <RerouteAlert alert={alert} onDismiss={() => setAlert(null)} />

      <IncidentModal
        incident={incident}
        spokenBy={spokenBy}
        onDismiss={() => setIncident(null)}
        onViewMap={() => { setIncident(null); setTab('map'); }}
      />

      {/* Last in the tree, so the offer sits over the tab bar as well as the
          map. A driver deciding whether to take a detour should not be able to
          navigate away from the question by accident. */}
      <RerouteSheet
        proposal={proposal}
        busy={answering}
        onAccept={acceptReroute}
        onKeep={declineReroute}
      />
    </SafeAreaView>
  );
}

/**
 * A corridor endpoint as a place the planner can hold.
 *
 * Matched to the server's own list by name where possible, so the id in the
 * field is the id the picker will tick. Synthesised only when the list could
 * not be fetched -- the corridor already carries the coordinates, and a
 * planner that sat empty because a 3 KB request failed would be a worse
 * failure than a locally-derived id.
 */
function asPlace(places, name, lat, lng) {
  if (!name) return null;
  const known = (places ?? []).find((p) => p.name === name);
  if (known) return known;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, lat, lng };
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

  // The map runs full-bleed to the top of the screen, so the floating stack
  // clears the status bar itself rather than being pushed down by a header.
  mapTop: {
    position: 'absolute', left: t.space.md, right: t.space.md,
    top: (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0) + t.space.sm,
  },
  brandRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: t.space.sm,
  },
  brand: { flexDirection: 'row', alignItems: 'center' },
  brandMark: {
    fontFamily: t.font.sansMedium, fontSize: t.type.meta, fontWeight: '800',
    color: t.color.accent, letterSpacing: 1.1, marginLeft: 6,
    // The wordmark now sits on the map rather than on a white bar, and the
    // map behind it can be anything. A dark halo keeps it legible over a
    // river, a snowfield or a night raster without a card behind it.
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  navCard: {},

  // Bottom-anchored so the stack grows upward and the report button stays
  // under the thumb on any screen height.
  mapRail: { position: 'absolute', right: t.space.md, bottom: t.space.md },
  speedBubble: { position: 'absolute', left: t.space.md, bottom: t.space.md },

  statRow: { flexDirection: 'row', marginBottom: t.space.md },
  statCard: { flex: 1, paddingVertical: t.space.md },
  statCardRight: { marginLeft: t.space.md },
  tabWrap: { paddingBottom: t.space.md, paddingTop: t.space.xs },
});
