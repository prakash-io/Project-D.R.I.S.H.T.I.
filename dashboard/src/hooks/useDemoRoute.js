// The demonstration route the dispatcher has selected (WEB-02).
//
// One route at a time, deliberately: the sidebar is a demonstration of the
// routing engine, and two live A* results on the map at once stop reading as
// "this is the path" and start reading as a second corridor overlay -- which
// the corridors layer already is.
import { useCallback, useRef, useState } from 'react';
import { planRoute } from '../lib/api';

export function useDemoRoute() {
  const [route, setRoute] = useState(null);     // { id, name, coordinates, ... }
  const [pendingId, setPendingId] = useState(null);
  const [error, setError] = useState(null);

  // Every plan gets a sequence number and only the newest may write. A
  // dispatcher clicking Imphal-Dimapur (810 ms) and then Agartala-Udaipur
  // (224 ms) would otherwise watch the fast one paint and then be silently
  // replaced by the slow one landing second -- the map would end up showing
  // a route the sidebar does not have selected.
  const seq = useRef(0);

  const select = useCallback(async (corridor) => {
    const ticket = ++seq.current;
    setPendingId(corridor.id);
    setError(null);
    try {
      const body = await planRoute(
        { lat: corridor.origin_lat, lng: corridor.origin_lng },
        { lat: corridor.destination_lat, lng: corridor.destination_lng },
      );
      if (ticket !== seq.current) return;

      const coordinates = body.geometry?.coordinates ?? [];
      if (coordinates.length < 2) throw new Error('planner returned no geometry');

      setRoute({
        id: corridor.id,
        name: corridor.name,
        origin_name: corridor.origin_name,
        destination_name: corridor.destination_name,
        coordinates,
        distance_m: body.distance_m,
        estimated_time_sec: body.estimated_time_sec,
        edge_count: body.edge_count,
      });
    } catch (e) {
      if (ticket !== seq.current) return;
      // The planned route is cleared rather than left behind: a stale
      // polyline under a fresh error message is the dispatcher reading a
      // path that is not the one they asked for.
      setRoute(null);
      setError(e.message);
    } finally {
      if (ticket === seq.current) setPendingId(null);
    }
  }, []);

  const clear = useCallback(() => {
    seq.current++;            // cancels any plan still in flight
    setRoute(null);
    setPendingId(null);
    setError(null);
  }, []);

  return { route, pendingId, error, select, clear };
}
