// Socket.IO telemetry stream (API-01).
//
// Payload contract, from CLAUDE.md section 1:
//   { truck_id, lat, lng, speed, timestamp }
//
// Live GPS arrives here at ~1 Hz. Dark-zone points do NOT: they are written
// to WatermelonDB on the phone and arrive later through the burst-sync REST
// endpoint, which is why `source` distinguishes 'gps' from 'ekf'.
import { query } from '../db.js';

export const TELEMETRY_EVENT = 'truck_location_update';
export const ROUTE_EVENT = 'route_updated';
export const INCIDENT_EVENT = 'incident_reported';
/// A trip was opened (or replanned) on a route. Dispatchers only: this is how
/// the board learns what road each truck is actually driving, which it had no
/// way to know at all -- the map drew ten static corridors and the live
/// vehicles, and nothing joined the two.
export const TRIP_EVENT = 'trip_route';
/// The driver's answer to a reroute proposal, fanned out to dispatchers only.
/// A refused detour is the urgent case: that truck is still driving at the
/// hazard, and the board must not show it on a road it declined.
export const ROUTE_ACK_EVENT = 'reroute_ack';

let io = null;

export function attachTelemetry(server) {
  io = server;

  io.on('connection', (socket) => {
    console.log(`[socket] ${socket.id} connected`);

    // A dashboard joins `dispatchers` and receives every truck; a driver's app
    // joins its own truck room and receives only its reroutes.
    socket.on('subscribe', ({ room }) => {
      if (typeof room === 'string' && room.length <= 64) socket.join(room);
    });

    socket.on(TELEMETRY_EVENT, async (payload, ack) => {
      try {
        const saved = await recordTelemetry(payload);
        // Fan out to dispatchers before acknowledging: the dashboard is the
        // reason this event exists.
        io.to('dispatchers').emit(TELEMETRY_EVENT, saved);
        if (typeof ack === 'function') ack({ ok: true, ...saved });
      } catch (error) {
        console.error('[socket] telemetry rejected:', error.message);
        if (typeof ack === 'function') ack({ ok: false, error: error.message });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket] ${socket.id} disconnected (${reason})`);
    });
  });

  return io;
}

export function emitTo(room, event, payload) {
  if (io) io.to(room).emit(event, payload);
}

/**
 * Deliver one event to a named set of rooms, once each.
 *
 * This replaced a `broadcast()` helper that was `io.emit` -- every connected
 * socket -- and the replacement is the fix for a real defect, not a tidy-up.
 * `incident_reported` went through it, so the instant ANY driver uploaded a
 * photo, every handset in the fleet raised a full-screen ROAD OBSTRUCTION
 * AHEAD modal: before a dispatcher had seen the report, on trucks hundreds of
 * kilometres away, about roads the hazard had nothing to do with, while
 * nothing was blocked at all. There is no longer a function here that can
 * reach the whole fleet at once; the rooms have to be named.
 *
 * A set rather than a loop at each call site, because the sets overlap. A
 * hazard approval goes to the dispatchers, to every driver whose route
 * crosses the closure, and to the driver who reported it -- and that last one
 * is usually also in the second group. Socket.IO's `to()` accumulates rooms
 * and de-duplicates the sockets across them, so the driver who reported the
 * landslide they are now being rerouted around gets one alert, not two.
 */
export function emitToMany(rooms, event, payload) {
  if (!io) return;
  const unique = [...new Set((rooms ?? []).filter(Boolean))];
  if (unique.length === 0) return;
  io.to(unique).emit(event, payload);
}

/**
 * Validate and persist one fix.
 *
 * `truck_last_seen` is upserted as well as appending to `telemetry`, so the
 * dashboard's first paint never scans the history table.
 */
export async function recordTelemetry(payload) {
  const { truck_id: truckId, lat, lng, speed, timestamp } = payload ?? {};

  if (!truckId) throw new Error('truck_id is required');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('lat and lng must be finite numbers');
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error(`coordinate out of range: ${lat}, ${lng}`);
  }

  const source = payload?.source === 'ekf' ? 'ekf' : 'gps';
  // The schema requires covariance on every 'ekf' row -- a dead-reckoned
  // point without an uncertainty cannot be drawn with its halo, and silently
  // defaulting it would understate the drift.
  if (source === 'ekf' && !Number.isFinite(payload?.covariance_m2)) {
    throw new Error('ekf fixes require covariance_m2');
  }

  const capturedAt = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(capturedAt.getTime())) throw new Error(`bad timestamp: ${timestamp}`);

  const { rows } = await query(
    `WITH trip AS (
         SELECT id FROM trips
         WHERE truck_id = $1 AND status = 'active'
         ORDER BY started_at DESC LIMIT 1
     ),
     inserted AS (
         INSERT INTO telemetry (trip_id, truck_id, geom, source, speed_mps,
                                heading_deg, covariance_m2, map_matched,
                                captured_at, client_uid)
         SELECT trip.id, $1, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5,
                $6, $7, $8, $9, coalesce($10::uuid, gen_random_uuid())
         FROM trip
         -- Idempotent against a replayed burst-sync batch.
         ON CONFLICT (client_uid) DO NOTHING
         RETURNING id, trip_id
     ),
     moved AS (
         INSERT INTO truck_last_seen (truck_id, trip_id, geom, source, speed_mps, captured_at)
         SELECT $1, (SELECT id FROM trip), ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $9
         ON CONFLICT (truck_id) DO UPDATE
            SET geom = EXCLUDED.geom, trip_id = EXCLUDED.trip_id,
                source = EXCLUDED.source, speed_mps = EXCLUDED.speed_mps,
                captured_at = EXCLUDED.captured_at
         -- Only move the marker forward. A burst-sync batch replaying older
         -- dark-zone points must not drag a live truck backwards on the map.
         WHERE truck_last_seen.captured_at <= EXCLUDED.captured_at
         RETURNING truck_id
     )
     -- Two independent outcomes, and conflating them is a real reporting bug:
     -- a burst-synced point is almost always OLDER than the live fix that
     -- arrived when the truck regained signal, so it is correctly written to
     -- the telemetry table while correctly NOT moving the marker. Counting
     -- only the marker moves made the worker report 0/250 written on a batch
     -- it had fully persisted.
     -- (No backticks in here: this is inside a JS template literal.)
     SELECT (SELECT count(*) FROM inserted) AS inserted,
            (SELECT count(*) FROM moved)    AS moved`,
    [truckId, lat, lng, source, speed ?? null, payload?.heading_deg ?? null,
     payload?.covariance_m2 ?? null, payload?.map_matched ?? false,
     capturedAt.toISOString(), payload?.client_uid ?? null],
  );

  return {
    truck_id: truckId,
    lat,
    lng,
    speed: speed ?? null,
    source,
    map_matched: Boolean(payload?.map_matched),
    covariance_m2: payload?.covariance_m2 ?? null,
    timestamp: capturedAt.toISOString(),
    // Was a new telemetry row written? False means client_uid was a replay.
    inserted: Number(rows[0]?.inserted ?? 0) > 0,
    // Did the truck's marker move? False when an older point lost the race
    // against a newer one, which is normal during a burst sync, not an error.
    advanced_last_seen: Number(rows[0]?.moved ?? 0) > 0,
  };
}
