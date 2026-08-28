// Live truck positions, interpolated for smooth movement (WEB-03).
//
// Telemetry arrives at ~1 Hz. Rendering it as it lands makes every truck jump
// once a second, which reads as a broken feed rather than a moving vehicle.
// So each truck holds a `from` and a `to` position and the map draws the
// interpolation between them on an animation frame.
//
// The interpolation is deliberately a LAG, not a prediction: the marker moves
// from where the truck was to where it now is, arriving as the next packet
// lands. Extrapolating ahead of the last fix would draw a truck somewhere no
// telemetry ever placed it -- which on a dispatcher's screen is a lie, and
// during a dark-zone gap would be a confident lie.
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL } from '../lib/api';

/// Matches the backend's 1 Hz telemetry. A packet that arrives late simply
/// makes the next leg start from wherever the marker had reached.
const INTERPOLATION_MS = 1000;

export function useTelemetry({
  onRouteUpdated, onIncident, onTripRoute, onRerouteAck,
  // The fleet's routes, keyed by truck id, each carrying a RouteTracker.
  //
  // A REF, deliberately. This is read on every animation frame to orient the
  // 3D models, and taking it as a normal prop would put it in this effect's
  // dependency list -- which would tear down and rebuild the socket every
  // time a truck was rerouted, dropping telemetry each time. The effect below
  // is mount-only and has to stay that way.
  routesRef,
} = {}) {
  const [trucks, setTrucks] = useState([]);
  const [connected, setConnected] = useState(false);
  const [packets, setPackets] = useState(0);

  // Mutable store, deliberately outside React state: this is written on every
  // animation frame, and putting it in state would re-render the whole tree
  // 60 times a second.
  const store = useRef(new Map());
  const frame = useRef(null);

  useEffect(() => {
    const socket = io(API_URL, { transports: ['websocket'] });

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('subscribe', { room: 'dispatchers' });
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('truck_location_update', (packet) => {
      const now = performance.now();
      const existing = store.current.get(packet.truck_id);
      const current = existing
        ? interpolate(existing, now)
        : { lng: packet.lng, lat: packet.lat };

      const next = { lng: packet.lng, lat: packet.lat };

      store.current.set(packet.truck_id, {
        truck_id: packet.truck_id,
        from: current,
        to: next,
        startedAt: now,
        speed: packet.speed,
        source: packet.source,
        map_matched: packet.map_matched,
        covariance_m2: packet.covariance_m2,
        timestamp: packet.timestamp,
        // Direction of travel between the last two fixes.
        //
        // Needed because the telemetry payload carries no heading -- the
        // socket contract is { truck_id, lat, lng, speed, source, timestamp }
        // -- and the map now draws a 3D model, which unlike a dot has a nose.
        // An unheaded model points due east and states a direction nothing
        // measured, which is the same class of error the interpolation comment
        // above refuses for position.
        //
        // This is now the FALLBACK, not the answer. A truck on a planned
        // route takes its heading from the road (see the tick loop below):
        // two consecutive 1 Hz fixes carry enough receiver noise that their
        // bearing swings tens of degrees on a vehicle driving dead straight,
        // and the marker being interpolated means the position on screen is
        // rarely the position that bearing was measured from. The road has
        // neither problem. This still runs, because a truck with no active
        // trip has no road to be pointed along.
        //
        // Derived, and therefore never sent onward or persisted: this is a
        // rendering property of two consecutive fixes, not telemetry.
        heading: headingFor(existing, current, next),
      });
      setPackets((n) => n + 1);
    });

    if (onRouteUpdated) socket.on('route_updated', onRouteUpdated);
    if (onIncident) socket.on('incident_reported', onIncident);
    if (onTripRoute) socket.on('trip_route', onTripRoute);
    if (onRerouteAck) socket.on('reroute_ack', onRerouteAck);

    const tick = () => {
      const now = performance.now();
      const snapshot = [];
      store.current.forEach((truck) => {
        const position = interpolate(truck, now);

        // Point the vehicle along the ROAD it is on, at the position it is
        // being drawn at -- not along the line between its last two fixes.
        //
        // Computed here, per frame, rather than once per packet, because the
        // marker is interpolated: over a 1 Hz leg it slides through a bend,
        // and a heading fixed at packet time would have it enter the curve
        // already facing the exit. The tracker keeps a cursor along the path,
        // so this is a short local search and not a scan of 4,400 vertices.
        const tracker = routesRef?.current?.get(truck.truck_id)?.tracker;
        const onRoute = tracker?.headingAt(position.lng, position.lat) ?? null;

        snapshot.push({
          ...truck,
          position: [position.lng, position.lat],
          // The fix-derived bearing survives as the fallback for a truck with
          // no active trip, or one that has wandered further off its route
          // than the tracker will vouch for.
          heading: onRoute ?? truck.heading,
          // Which of the two answered, so nothing downstream has to guess
          // whether a heading is measured against a road or inferred from two
          // noisy fixes.
          heading_source: onRoute === null ? 'fixes' : 'route',
        });
      });
      setTrucks(snapshot);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame.current);
      socket.close();
    };
    // Mount-only: re-subscribing on every callback identity change would drop
    // and rebuild the socket, losing packets each time a parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { trucks, connected, packets };
}

/// Below this, a "movement" is receiver noise rather than travel. Degrees:
/// 2e-5 is about 2.2 m at this latitude, comfortably under a single GNSS
/// error radius and well under the ~17 m a truck covers in one 1 Hz tick at
/// 60 km/h.
const HEADING_EPSILON_DEG = 2e-5;

/**
 * Compass bearing of the new leg, or the previous heading when the truck has
 * not meaningfully moved.
 *
 * Holding the old value on a stationary truck is the whole point. A parked
 * vehicle still emits 1 Hz packets that differ by centimetres of jitter, and
 * taking the bearing of those makes the model spin on the spot -- which reads
 * as a vehicle manoeuvring when nothing is happening at all.
 */
function headingFor(existing, from, to) {
  const dLng = to.lng - from.lng;
  const dLat = to.lat - from.lat;
  if (Math.abs(dLng) < HEADING_EPSILON_DEG && Math.abs(dLat) < HEADING_EPSILON_DEG) {
    return existing?.heading ?? 0;
  }
  // Longitude degrees shrink with latitude; without the cos correction a
  // due-east leg reads as north-east by roughly 10 degrees at 26 N.
  const x = dLng * Math.cos((to.lat * Math.PI) / 180);
  // atan2(east, north) gives degrees clockwise from north, which is what a
  // compass heading is and what the ScenegraphLayer's yaw expects.
  return ((Math.atan2(x, dLat) * 180) / Math.PI + 360) % 360;
}

function interpolate(truck, now) {
  const elapsed = now - truck.startedAt;
  // Clamped at 1: past the interpolation window the marker rests on the last
  // reported position rather than sliding past it.
  const t = Math.min(1, elapsed / INTERPOLATION_MS);
  // Smoothstep. A truck does not start and stop instantly between packets,
  // and linear interpolation makes each leg visibly begin with a jerk.
  const eased = t * t * (3 - 2 * t);
  return {
    lng: truck.from.lng + (truck.to.lng - truck.from.lng) * eased,
    lat: truck.from.lat + (truck.to.lat - truck.from.lat) * eased,
  };
}
