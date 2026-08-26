// D.R.I.S.H.T.I. command state (Deliverable 3).
//
// Everything the dispatcher's screen knows lives here, and every socket frame
// and REST response enters through one of the actions at the bottom. Nothing
// else in the app holds domain state.
//
// TWO stores, on purpose:
//
//   commandStore   changes at packet rate (~1 Hz per truck) and at human rate
//                  (a dispatcher approving something). Every panel subscribes.
//
//   positionStore  changes at frame rate (60 Hz) because it holds the
//                  interpolated marker positions. ONLY CommandMap subscribes.
//
// Merging the two would make every readout in the sidebar re-evaluate its
// selector sixty times a second to discover that its truck's speed had not
// changed. Splitting them means the interpolation costs one subscriber.
//
// -------------------------------------------------------------------------
// WIRE CONTRACT -- verified against backend/src/sockets/telemetry.js
// -------------------------------------------------------------------------
// Server -> dispatcher, on room 'dispatchers':
//   truck_location_update  { truck_id, lat, lng, speed, source, map_matched,
//                            covariance_m2, timestamp, inserted,
//                            advanced_last_seen }
//   route_updated          { trip_id, truck_id, incident_id, distance_m,
//                            geometry }            (GeoJSON LineString)
//   incident_reported      { id, kind, status, confidence, ai_class,
//                            blocked_edge, lat, lng, ... }
//
// Dispatcher -> server:
//   subscribe              { room: 'dispatchers' }
//
// Fields the Telemetry HUD wants that are NOT on the wire today -- the mobile
// client reads altitude and then explicitly does not send it, and never
// samples pitch/roll for transmission at all. They are read here as optional
// keys so that the moment they appear the HUD lights up, and rendered as "NO
// STREAM" until then. They are never invented: a fabricated attitude readout
// on a dispatcher's screen is worse than an absent one.
import { createStore } from './createStore';

/// 15 minutes of 1 Hz history per truck. Long enough to hold a whole dark-zone
/// crossing, bounded so a week-long session cannot grow without limit.
const TRAIL_LIMIT = 900;

/// A fix older than this is not "live" any more, whatever the socket says. The
/// stream is 1 Hz, so 8 s is eight missed packets -- past coincidence.
const STALE_AFTER_MS = 8_000;

/// Δt outside this range makes a speed difference useless as an acceleration:
/// too short and it is GNSS noise, too long and it averages away the event.
const G_FORCE_WINDOW = [0.2, 5];
const GRAVITY = 9.80665;

export const NETWORK = {
  LIVE: 'LIVE',
  DARK: 'DARK ZONE',
  STALE: 'STALE',
  OFFLINE: 'OFFLINE',
};

const initialUi = {
  selectedTruckId: null,
  // Overlay switches. Trucks and hazards default on because they are the two
  // things a dispatcher opened this screen to see; risk defaults off because
  // fetching it is expensive (see useDispatcherFeeds).
  showTrucks: true,
  showTrails: true,
  showRoutes: true,
  showHazards: true,
  showRisk: false,
  // Basemap: the ISRO/NRSC sovereign raster, or the offline-safe dark vector
  // fallback. See lib/bhuvan.js -- this flips automatically if Bhuvan cannot
  // be reached, so the map is never blank.
  basemap: 'bhuvan',
  // How hard to sink the basemap behind the data. Bhuvan vec1 is a light
  // cartographic raster; at 0 it glares under a dark HUD and the cyan markers
  // lose contrast against it.
  basemapDim: 0.55,
};

export const useCommandStore = createStore((set, get) => ({
  // ---------------------------------------------------------------- link
  link: {
    connected: false,
    since: null,
    packets: 0,
    lastPacketAt: null,
    error: null,
  },

  // ------------------------------------------------------------- domain
  /** truck_id -> record. See ingestTelemetry for the shape. */
  trucks: {},
  /** truck_id -> [{ position, source, t }], oldest first, capped. */
  trails: {},
  /** truck_id -> { segments, points, syncedAt } -- the burst-synced blackout. */
  darkZone: {},
  /** truck_id -> { geometry, distance_m, provider, updatedAt, incident_id }. */
  routes: {},
  /** Verified hazards drawn on the map. */
  hazards: [],
  /** Reports awaiting a dispatcher decision. */
  queue: [],
  /**
   * Bumped every time an incident event lands.
   *
   * A socket event only says "something changed"; the queue is re-FETCHED
   * rather than patched locally, so the panel can never disagree with the
   * database about what is still awaiting a decision. This counter is the
   * trigger for that refetch -- an effect watching it re-runs, whereas
   * watching the queue array itself would loop.
   */
  incidentEpoch: 0,
  /** The live socket, owned by useCommandSocket. */
  socket: null,
  risk: { features: [], threshold: 0.85, loading: false, error: null, fetchedAt: null },
  /** Transient banners. */
  alerts: [],

  ui: initialUi,

  // --------------------------------------------------------------- link
  setLink: (patch) => set((s) => ({ link: { ...s.link, ...patch } })),

  // ---------------------------------------------------------- telemetry
  /**
   * One fix from `truck_location_update`.
   *
   * Also sets up the interpolation leg in positionStore. The leg runs FROM
   * wherever the marker had visually reached TO the position just reported --
   * it is a lag, never an extrapolation (CLAUDE.md decision 12). Drawing ahead
   * of the last fix would put a truck where no telemetry ever placed it, and
   * during a dark-zone gap that would be a confident lie.
   */
  ingestTelemetry: (packet, { live = true } = {}) => {
    if (!packet?.truck_id || !Number.isFinite(packet.lat) || !Number.isFinite(packet.lng)) {
      return;
    }
    const now = performance.now();
    const wallClock = Date.now();
    const id = packet.truck_id;
    const previous = get().trucks[id];

    const record = {
      // Identity is carried forward, not re-derived. It arrives ONLY from
      // GET /trucks (useDispatcherFeeds) -- the telemetry packet carries a
      // bare UUID -- so rebuilding the record from the packet alone would
      // blank the plate and driver name on the very next fix, one second
      // after they appeared.
      plate: previous?.plate ?? null,
      driver_name: previous?.driver_name ?? null,
      alert_lang: previous?.alert_lang ?? 'en',

      truck_id: id,
      lat: packet.lat,
      lng: packet.lng,
      speed: Number.isFinite(packet.speed) ? packet.speed : null,
      heading_deg: Number.isFinite(packet.heading_deg) ? packet.heading_deg : null,
      source: packet.source === 'ekf' ? 'ekf' : 'gps',
      map_matched: Boolean(packet.map_matched),
      covariance_m2: Number.isFinite(packet.covariance_m2) ? packet.covariance_m2 : null,
      timestamp: packet.timestamp ?? new Date(wallClock).toISOString(),
      receivedAt: wallClock,

      // Optional, absent from today's wire payload. Passed through untouched.
      pitch_deg: Number.isFinite(packet.pitch_deg) ? packet.pitch_deg : null,
      roll_deg: Number.isFinite(packet.roll_deg) ? packet.roll_deg : null,
      altitude_m: Number.isFinite(packet.altitude_m) ? packet.altitude_m : null,

      // Derived, and labelled as derived wherever it is shown.
      gForce: deriveGForce(previous, packet, wallClock),
    };

    positionStore.getState().startLeg(id, [packet.lng, packet.lat], now);

    set((s) => ({
      trucks: { ...s.trucks, [id]: record },
      trails: { ...s.trails, [id]: appendTrail(s.trails[id], record) },
      // Only fixes that arrived over the SOCKET count as packets. The roster
      // seed (GET /trucks) replays each truck's last known position through
      // this same action, and counting those would have the status bar report
      // "8 packets" on a dead link -- the precise readout a dispatcher uses to
      // decide whether the stream is alive. Seeded fixes still populate the
      // map and the HUD; they just do not claim to be telemetry.
      link: live
        ? { ...s.link, packets: s.link.packets + 1, lastPacketAt: wallClock }
        : s.link,
    }));
  },

  /**
   * A burst-synced backlog arrived (Task 2, workflow section 3).
   *
   * Accepts either a BullMQ worker result `{ truck_id, points, written }` or a
   * plain `{ truck_id, points }`. `points` are the dark-zone fixes in
   * chronological order; they are drawn as a dashed path rather than folded
   * into the live trail, because they are HISTORY being painted in after the
   * fact, not the truck's current movement.
   */
  ingestBurstSync: (result) => {
    const id = result?.truck_id;
    const points = Array.isArray(result?.points) ? result.points : [];
    if (!id || points.length === 0) return;

    const path = points
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p) => [p.lng, p.lat]);
    if (path.length < 2) return;

    set((s) => ({
      darkZone: {
        ...s.darkZone,
        [id]: {
          segments: path,
          points: path.length,
          written: result.written ?? path.length,
          syncedAt: Date.now(),
        },
      },
    }));
    get().pushAlert({
      tone: 'info',
      title: 'Burst sync complete',
      body: `${id.slice(0, 8)} uploaded ${path.length} dark-zone fixes`,
      truckId: id,
    });
  },

  // -------------------------------------------------------------- routes
  /** `route_updated`, or a route this dashboard planned itself. */
  ingestRoute: (payload) => {
    const id = payload?.truck_id;
    if (!id || !payload?.geometry) return;
    set((s) => ({
      routes: {
        ...s.routes,
        [id]: {
          geometry: payload.geometry,
          distance_m: payload.distance_m ?? null,
          incident_id: payload.incident_id ?? null,
          provider: payload.provider ?? 'pgrouting',
          updatedAt: Date.now(),
        },
      },
    }));
  },

  // ----------------------------------------------------------- incidents
  /**
   * `incident_reported` fires both when a driver reports and when a dispatcher
   * approves. The payload carries `approved` in the second case.
   */
  ingestIncident: (payload) => {
    if (!payload?.id) return;
    const verified = payload.approved === true || payload.status === 'verified';

    set((s) => {
      const hazards = verified
        ? [payload, ...s.hazards.filter((h) => h.id !== payload.id)]
        : s.hazards;
      return { hazards, incidentEpoch: s.incidentEpoch + 1 };
    });

    get().pushAlert({
      tone: verified ? 'critical' : 'warn',
      title: verified ? `${labelKind(payload.kind)} — road blocked` : `${labelKind(payload.kind)} reported`,
      body: verified
        ? `Edge ${payload.blocked_edge ?? '—'} closed. Affected trucks rerouted.`
        : 'Awaiting dispatcher verification — no road is blocked yet.',
      incidentId: payload.id,
      sticky: verified,
    });
  },

  setQueue: (queue) => set({ queue: Array.isArray(queue) ? queue : [] }),
  setHazards: (hazards) => set({ hazards: Array.isArray(hazards) ? hazards : [] }),
  setRisk: (patch) => set((s) => ({ risk: { ...s.risk, ...patch } })),

  // ----------------------------------------------------------------- ui
  selectTruck: (truckId) =>
    set((s) => ({ ui: { ...s.ui, selectedTruckId: truckId ?? null } })),

  setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),

  toggleOverlay: (key) => set((s) => ({ ui: { ...s.ui, [key]: !s.ui[key] } })),

  // -------------------------------------------------------------- alerts
  pushAlert: (alert) =>
    set((s) => ({
      alerts: [
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), ...alert },
        // Four is what fits the stack without covering the map. Older banners
        // fall off rather than scrolling: a dispatcher reads the newest.
        ...s.alerts,
      ].slice(0, 4),
    })),

  dismissAlert: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
}));

// ---------------------------------------------------------------------------
// positionStore -- 60 Hz, one subscriber
// ---------------------------------------------------------------------------

/// Matches the backend's 1 Hz telemetry. A packet that arrives late simply
/// makes the next leg start from wherever the marker had reached.
const INTERPOLATION_MS = 1000;

export const positionStore = createStore((set, get) => ({
  /** truck_id -> { from, to, startedAt }. */
  legs: {},
  /** truck_id -> [lng, lat], recomputed each frame. */
  positions: {},

  startLeg: (truckId, to, now) => {
    const leg = get().legs[truckId];
    let from = leg ? lerpLeg(leg, now) : to;

    // Snap, do not glide, across a discontinuity. Interpolating a teleport
    // would slide the marker smoothly over ground the truck never covered --
    // for one second the map would show a vehicle travelling at Mach 6 down a
    // road, which is a more convincing lie than simply jumping. Same threshold
    // the trail uses to break a run.
    if (leg && haversineMetres(from, to) > MAX_JUMP_M) from = to;

    set((s) => ({ legs: { ...s.legs, [truckId]: { from, to, startedAt: now } } }));
  },

  /** Called once per animation frame by useCommandSocket. */
  tick: (now) => {
    const { legs } = get();
    const positions = {};
    let changed = false;
    const previous = get().positions;

    for (const [truckId, leg] of Object.entries(legs)) {
      const next = lerpLeg(leg, now);
      positions[truckId] = next;
      const before = previous[truckId];
      if (!before || before[0] !== next[0] || before[1] !== next[1]) changed = true;
    }
    // Every truck at rest means nothing to publish. Skipping the set() keeps
    // the map from re-rendering sixty times a second over a static fleet.
    if (changed || Object.keys(positions).length !== Object.keys(previous).length) {
      set({ positions });
    }
  },

  drop: (truckId) =>
    set((s) => {
      const legs = { ...s.legs };
      const positions = { ...s.positions };
      delete legs[truckId];
      delete positions[truckId];
      return { legs, positions };
    }),
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lerpLeg(leg, now) {
  const elapsed = now - leg.startedAt;
  // Clamped at 1: past the interpolation window the marker rests on the last
  // reported position rather than sliding past it.
  const t = Math.min(1, Math.max(0, elapsed / INTERPOLATION_MS));
  // Smoothstep. A truck does not start and stop instantly between packets, and
  // linear interpolation makes each leg visibly begin with a jerk.
  const eased = t * t * (3 - 2 * t);
  return [
    leg.from[0] + (leg.to[0] - leg.from[0]) * eased,
    leg.from[1] + (leg.to[1] - leg.from[1]) * eased,
  ];
}

function appendTrail(existing, record) {
  const trail = existing ? [...existing] : [];
  trail.push({
    position: [record.lng, record.lat],
    source: record.source,
    t: record.receivedAt,
  });
  return trail.length > TRAIL_LIMIT ? trail.slice(trail.length - TRAIL_LIMIT) : trail;
}

/**
 * Longitudinal g-force from two consecutive speed reports.
 *
 * This is a DERIVED value and is labelled as one everywhere it is shown. The
 * phone has an accelerometer and the C++ edge engine consumes it at 100 Hz,
 * but none of that reaches this socket -- so the honest thing available here
 * is Δv/Δt over the GNSS speed series, which catches hard braking and little
 * else. Returns null rather than a plausible-looking zero when it cannot be
 * computed.
 */
function deriveGForce(previous, packet, wallClock) {
  if (!previous) return null;
  if (!Number.isFinite(previous.speed) || !Number.isFinite(packet.speed)) return null;

  const dt = (wallClock - previous.receivedAt) / 1000;
  if (dt < G_FORCE_WINDOW[0] || dt > G_FORCE_WINDOW[1]) return null;

  return (packet.speed - previous.speed) / dt / GRAVITY;
}

function labelKind(kind) {
  return { landslide: 'Landslide', flood: 'Flash flood', obstruction: 'Obstruction' }[kind]
    ?? (kind ? String(kind).toUpperCase() : 'Hazard');
}

/**
 * What the link looks like for ONE truck, which is not the same question as
 * whether the dashboard's own socket is up.
 *
 * A truck reporting `source: 'ekf'` is in a dark zone by definition: the edge
 * engine only takes over when GNSS is lost. A truck that has simply gone quiet
 * is stale, which is a different failure and gets a different colour.
 */
export function networkStatus(truck, linkConnected, now = Date.now()) {
  if (!truck) return NETWORK.OFFLINE;
  if (!linkConnected) return NETWORK.OFFLINE;
  if (truck.source === 'ekf') return NETWORK.DARK;
  if (now - truck.receivedAt > STALE_AFTER_MS) return NETWORK.STALE;
  return NETWORK.LIVE;
}

/// A truck cannot cross this much ground between two 1 Hz fixes. Anything
/// larger is a teleport -- a restarted feed, a trip reassigned, a GNSS fix
/// that landed in the wrong hemisphere -- not travel. 2 km at 1 Hz would be
/// Mach 6.
const MAX_JUMP_M = 2000;

/// A gap this long means the truck was somewhere the trail does not record.
/// Joining across it draws a straight line through terrain it never crossed.
const MAX_GAP_MS = 120_000;

/**
 * Split a trail into drawable runs.
 *
 * Two different reasons to break a run, and they are not the same thing:
 *
 *   SOURCE changed   the map draws GNSS solid and dead-reckoned dashed, so it
 *                    needs the boundary. Consecutive runs SHARE the boundary
 *                    point, so the rendered path has no visible gap where the
 *                    mode changed -- the line simply becomes dashed.
 *
 *   DISCONTINUITY    the two points are impossibly far apart, or too far apart
 *                    in time to know what happened between them. Here the runs
 *                    must NOT share a point: the whole purpose is to leave the
 *                    gap empty rather than draw across it.
 *
 * The second case is why this function exists in its current form. Without it
 * a restarted feed -- or any truck whose telemetry gaps and resumes elsewhere
 * -- renders as a long straight line spanning whatever it skipped, which reads
 * as a road the truck drove down. On a dispatcher's screen that is not a
 * cosmetic glitch; it is a claim about where a vehicle went.
 */
export function splitTrailBySource(trail) {
  if (!trail || trail.length < 2) return [];
  const runs = [];
  let current = { source: trail[0].source, path: [trail[0].position] };

  const flush = () => {
    if (current.path.length >= 2) runs.push(current);
  };

  for (let i = 1; i < trail.length; i += 1) {
    const point = trail[i];
    const previous = trail[i - 1];

    const jumped = haversineMetres(previous.position, point.position) > MAX_JUMP_M;
    const stalled = point.t - previous.t > MAX_GAP_MS;

    if (jumped || stalled) {
      // Hard break. The new run starts AT the new point with nothing joining
      // it to the old one.
      flush();
      current = { source: point.source, path: [point.position] };
      continue;
    }

    if (point.source !== current.source) {
      current.path.push(point.position);
      flush();
      current = { source: point.source, path: [point.position] };
    } else {
      current.path.push(point.position);
    }
  }
  flush();
  return runs;
}

/**
 * Great-circle distance in metres.
 *
 * Duplicated from lib/googleRoutes rather than imported: the store is the one
 * module with no dependencies on the app's service layer, and reaching into a
 * routing/Directions module from here to borrow one trigonometric function
 * would invert that. Ten lines is cheaper than the coupling.
 */
function haversineMetres([lng1, lat1], [lng2, lat2]) {
  const R = 6_371_008.8;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
