// The fleet, merged from two sources that each know half of it.
//
// The telemetry socket knows which trucks are MOVING -- it has a truck only
// once that truck has emitted, and it carries speed, source and position.
// GET /trucks knows which trucks EXIST -- plate, driver, last known fix, and
// crucially the ones that have not emitted this session.
//
// The selector needs both. Live-only would leave the grid empty whenever the
// simulator is not running, which reads as a broken feature rather than as a
// quiet depot. Roster-only would drop the live source and speed that make the
// grid worth looking at. So they are merged, keyed on the truck id, and every
// row states which of the two it came from.
import { useEffect, useMemo, useState } from 'react';
import { getTrucks } from '../lib/api';

export function useFleetRoster(liveTrucks) {
  const [roster, setRoster] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetched once. The roster is plates and drivers -- it changes when someone
  // adds a vehicle, not at telemetry rate -- and the live half of the merge
  // below already updates on every packet.
  useEffect(() => {
    let alive = true;
    getTrucks()
      .then(({ trucks }) => { if (alive) setRoster(trucks ?? []); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const fleet = useMemo(() => {
    const byId = new Map();

    for (const truck of roster) {
      byId.set(truck.id, {
        id: truck.id,
        plate: truck.plate,
        driver_name: truck.driver_name,
        source: truck.source ?? null,
        speed: Number.isFinite(truck.speed_mps) ? truck.speed_mps : null,
        captured_at: truck.captured_at ?? null,
        live: false,
      });
    }

    // Live wins on every field it carries: a roster row's `source` is the last
    // fix ever persisted for that truck, which may be days old, while the
    // socket's is what is arriving now.
    for (const truck of liveTrucks ?? []) {
      const existing = byId.get(truck.truck_id) ?? {};
      byId.set(truck.truck_id, {
        ...existing,
        id: truck.truck_id,
        source: truck.source ?? existing.source ?? null,
        speed: Number.isFinite(truck.speed) ? truck.speed : existing.speed ?? null,
        covariance_m2: truck.covariance_m2 ?? null,
        live: true,
      });
    }

    // Live first, then by plate. A dispatcher opening this is looking for a
    // truck that is moving; the depot can be below the fold.
    return [...byId.values()].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return String(a.plate ?? a.id).localeCompare(String(b.plate ?? b.id));
    });
  }, [roster, liveTrucks]);

  return { fleet, loading, error };
}
