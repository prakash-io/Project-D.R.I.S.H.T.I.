// Polls the hazard model along every planned corridor (workflow section 5).
//
// One request per corridor, run in sequence rather than in parallel. The
// backend scores each sampled point with a separate call into FastAPI, which
// in turn hits Open-Meteo and samples two GeoTIFFs -- firing ten corridors at
// once puts ~120 model calls on the service simultaneously and the whole
// batch times out together. Sequential is slower per sweep and is the only
// version that finishes.
//
// The poll interval is deliberately slow. Open-Meteo publishes HOURLY
// precipitation, and the KDTree/raster features behind the other seven inputs
// do not change at all, so a faster poll re-derives an identical answer at
// real cost. Five minutes is already far inside the rate at which the
// underlying data can move.
import { useCallback, useEffect, useRef, useState } from 'react';
import { forecastRoute } from '../lib/api';

const POLL_MS = 5 * 60 * 1000;

/**
 * @param corridors  from useCorridors — needs `.geometry.coordinates`
 * @param threshold  flag level; the backend's own value wins when it reports one
 */
export function useHazardAlerts({ corridors, threshold = 0.85, enabled = true }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [degraded, setDegraded] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);

  // A sweep can outlive the component, and a slow one can still be running
  // when the next tick fires. This lets both be abandoned without touching
  // state after unmount.
  const runId = useRef(0);

  const sweep = useCallback(async () => {
    if (!enabled || corridors.length === 0) return;

    const id = runId.current + 1;
    runId.current = id;
    setLoading(true);

    const found = [];
    let sawDegraded = null;
    let failure = null;

    for (const corridor of corridors) {
      if (runId.current !== id) return;      // superseded or unmounted
      const path = corridor.geometry?.coordinates;
      if (!Array.isArray(path) || path.length < 2) continue;

      try {
        const body = await forecastRoute(path);
        // The service reports the threshold it flagged against; prefer it over
        // ours so the page cannot disagree with the model about what "high
        // risk" means.
        const cut = Number.isFinite(body.threshold) ? body.threshold : threshold;
        if (body.degraded) sawDegraded = body.degraded;

        for (const hazard of body.hazards ?? []) {
          // Strictly greater than the threshold, per the requirement. The
          // backend already filters at >=, so this only ever removes exact
          // ties at the boundary.
          if (!(hazard.probability > cut)) continue;
          found.push({
            // Stable across sweeps so React keeps card identity and the
            // highest-risk pulse does not jump between re-renders.
            key: `${corridor.id ?? corridor.name}:${hazard.lat.toFixed(4)}:${hazard.lng.toFixed(4)}`,
            corridor: corridor.name ?? 'unnamed corridor',
            lat: hazard.lat,
            lng: hazard.lng,
            kind: hazard.kind,
            probability: hazard.probability,
            rainfall24h: hazard.rainfall_24h_mm,
            rainfallIntensity: hazard.rainfall_intensity_mmh,
            weatherSource: hazard.weather_source,
            windowStart: hazard.window_start_utc,
          });
        }
      } catch (e) {
        // Keep going. One corridor failing should not cost the operator the
        // other nine forecasts.
        failure = e.message;
      }
    }

    if (runId.current !== id) return;
    // Worst first: the page's job is to put the most dangerous segment under
    // the dispatcher's eye, not to preserve corridor order.
    found.sort((a, b) => b.probability - a.probability);
    setAlerts(found);
    setDegraded(sawDegraded);
    setError(found.length === 0 ? failure : null);
    setCheckedAt(new Date());
    setLoading(false);
  }, [corridors, threshold, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    sweep();
    const timer = setInterval(sweep, POLL_MS);
    return () => {
      // Invalidate any sweep in flight, so a response landing after unmount
      // cannot call setState.
      runId.current += 1;
      clearInterval(timer);
    };
  }, [sweep, enabled]);

  return { alerts, loading, error, degraded, checkedAt, refresh: sweep };
}
