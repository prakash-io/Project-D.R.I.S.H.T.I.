// The road each truck is actually driving (WEB-03).
//
// This is the feed the console was missing. `useTelemetry` gives positions and
// `useCorridors` gives ten fixed pieces of NER geography, and nothing joined
// the two -- so a dispatcher watching two trucks converge on Guwahati could
// see where they were and had no way to see where either was going. The map
// in the bug report is exactly that: vehicles on a basemap, no route under
// them.
//
// Three ways a route arrives, and all three matter:
//
//   the fetch      -- what the fleet is driving when the console opens. A
//                     dispatcher arriving mid-shift must not have to wait for
//                     a truck to be rerouted before its path appears.
//   `trip_route`   -- a driver planned a new journey. Emitted by POST /trips.
//   `route_updated`-- a detour was offered. The board draws it AS SOON AS THE
//                     DRIVER IS TOLD, not when they accept: the dispatcher's
//                     job during an incident is to know what each driver is
//                     looking at, and a board that lags the handset by however
//                     long it takes someone to read a modal is a board that
//                     disagrees with the cab.
//
// ...and one way a route is taken back: `reroute_ack` with route_restored,
// which is a driver DECLINING a detour. That truck is still heading at the
// hazard and the board must stop drawing it on a road nobody is driving.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveTrips } from '../lib/api';
import { RouteTracker } from '../lib/routeHeading';

export function useFleetRoutes() {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // The same routes, keyed by truck and carrying a RouteTracker each.
  //
  // A ref and not state because useTelemetry reads this on every animation
  // frame to orient the 3D models. Passing the array down as a prop would
  // make the socket effect depend on it, and that effect is mount-only for a
  // reason -- re-running it tears down the connection and drops packets.
  const byTruck = useRef(new Map());

  const publish = useCallback(() => {
    setRoutes([...byTruck.current.values()].map(({ tracker, ...rest }) => rest));
  }, []);

  /// One truck's route, from any of the three sources.
  const upsert = useCallback((entry) => {
    if (!entry?.truck_id) return;
    const coordinates = entry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return;

    const existing = byTruck.current.get(entry.truck_id);
    // The tracker is REUSED across a reroute rather than rebuilt, so a truck
    // that is offered a detour does not lose its position along its path and
    // spend a frame pointing the wrong way while the cursor re-finds itself.
    const tracker = existing?.tracker ?? new RouteTracker(coordinates);
    if (existing) tracker.setCoordinates(coordinates);

    byTruck.current.set(entry.truck_id, { ...existing, ...entry, tracker });
    publish();
  }, [publish]);

  const refresh = useCallback(async () => {
    try {
      const body = await getActiveTrips();
      const next = new Map();
      for (const trip of body.trips ?? []) {
        const coordinates = trip.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
        // Carried over so a refresh does not reset every truck's cursor.
        const tracker = byTruck.current.get(trip.truck_id)?.tracker
          ?? new RouteTracker(coordinates);
        tracker.setCoordinates(coordinates);
        next.set(trip.truck_id, {
          truck_id: trip.truck_id,
          trip_id: trip.trip_id,
          plate: trip.plate,
          coordinates,
          distance_m: trip.planned_distance_m,
          duration_sec: trip.planned_duration_sec,
          progress: trip.progress,
          alternative_count: trip.alternative_count,
          tracker,
        });
      }
      byTruck.current = next;
      publish();
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [publish]);

  useEffect(() => { refresh(); }, [refresh]);

  // Stable identities, all of them: these are handed to useTelemetry, whose
  // socket effect must never re-run. Every one of these closes over refs and
  // over the [] -dependency callbacks above, so [] is honest here.
  const onTripRoute = useCallback((payload) => {
    upsert({
      truck_id: payload?.truck_id,
      trip_id: payload?.trip_id,
      coordinates: payload?.geometry?.coordinates,
      distance_m: payload?.distance_m,
      duration_sec: payload?.estimated_time_sec,
      alternative_count: payload?.alternatives,
      progress: 0,
    });
  }, [upsert]);

  const onRouteUpdated = useCallback((payload) => {
    upsert({
      truck_id: payload?.truck_id,
      trip_id: payload?.trip_id,
      // route_geom is the current name; `geometry` is read as a fallback so a
      // backend that has not been redeployed still moves the line.
      coordinates: (payload?.route_geom ?? payload?.geometry)?.coordinates,
      distance_m: payload?.new_distance_m ?? payload?.distance_m,
      duration_sec: payload?.estimated_time_sec,
      // Flagged rather than merely drawn. A detour the driver has not answered
      // yet is a proposal, and the board should not present it with the same
      // confidence as a road someone is on.
      proposed: payload?.requires_ack === true,
      // False means the road is shut and there was nothing to route around
      // it -- the truck is being sent through the closure because there is no
      // alternative. That has to reach the dispatcher.
      avoids_closure: payload?.avoids_closure !== false,
    });
  }, [upsert]);

  // A declined detour restores the previous path server-side, and the only
  // copy of that path is in the database -- the client threw it away when it
  // drew the proposal. So this refetches rather than trying to undo locally.
  const onRerouteAck = useCallback((payload) => {
    if (payload?.route_restored) refresh();
    else if (payload?.driver_response === 'accepted') {
      const entry = byTruck.current.get(payload?.truck_id);
      if (entry) upsert({ ...entry, proposed: false });
    }
  }, [refresh, upsert]);

  return { routes, byTruck, loading, error, refresh,
           onTripRoute, onRouteUpdated, onRerouteAck };
}
