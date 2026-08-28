// Everything the /analytics/:truckId page needs, in two dependent requests.
//
// Dependent, and therefore sequential rather than parallel: the weather is
// asked for ALONG A ROUTE, and the route is what the first request returns.
// Firing both at once would mean guessing the corridor from the truck's last
// position, which is exactly the kind of plausible-but-wrong shortcut this
// codebase keeps finding and removing.
//
// The two failures are tracked separately on purpose. Open-Meteo being
// unreachable must not blank the driver's phone number, and a truck with no
// active trip must still show its plate and its driver -- a deep-dive that
// renders nothing because one of its panels could not load is a page that
// tells a dispatcher less than the list they came from.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getTruckDetail, getRouteWeather } from '../lib/api';

/// Hours of forecast to request. Two days: the bar chart wants whole days and
/// the hourly table is read by scrolling, and past 48 h an hourly
/// precipitation figure is not worth the row it costs.
const FORECAST_HOURS = 48;
/// Origin, midpoint, destination. Enough to show that weather varies ALONG a
/// corridor -- which one reading hides -- without turning a page load into a
/// dozen upstream locations.
const SAMPLE_POINTS = 3;

export function useTruckAnalytics(truckId) {
  const [detail, setDetail] = useState(null);
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [weatherError, setWeatherError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Guards against a late response from a truck the dispatcher has already
  // navigated away from overwriting the one they are now looking at. The
  // fleet list is one click from here, so that race is routine, not exotic.
  const active = useRef(0);

  useEffect(() => {
    if (!truckId) return undefined;
    const token = active.current + 1;
    active.current = token;
    let alive = true;

    setLoading(true);
    setError(null);
    setWeatherError(null);

    (async () => {
      let loaded;
      try {
        loaded = await getTruckDetail(truckId);
      } catch (e) {
        if (alive && active.current === token) {
          setError(e.message);
          setDetail(null);
          setWeather(null);
          setLoading(false);
        }
        return;
      }
      if (!alive || active.current !== token) return;
      setDetail(loaded);

      // Prefer the trip's own planned geometry -- that is the road this truck
      // is actually on. Fall back to the straight origin/destination pair so a
      // trip recorded before planned_route was populated still gets weather at
      // both ends rather than none, and finally to the last known position, so
      // a truck between trips still shows the sky above it.
      const line = routeLine(loaded);
      if (!line) {
        setWeatherError('No route or position to place a forecast on.');
        setWeather(null);
        setLoading(false);
        return;
      }

      try {
        const forecast = await getRouteWeather(line, SAMPLE_POINTS, FORECAST_HOURS);
        if (alive && active.current === token) setWeather(forecast);
      } catch (e) {
        if (alive && active.current === token) {
          setWeatherError(e.message);
          setWeather(null);
        }
      } finally {
        if (alive && active.current === token) setLoading(false);
      }
    })();

    return () => { alive = false; };
  }, [truckId, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  return { detail, weather, loading, error, weatherError, refresh };
}

/// The coordinate list a forecast is sampled along. See the caller for why
/// the three fallbacks exist and in which order they are preferred.
function routeLine(detail) {
  const coordinates = detail?.trip?.geometry?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) return coordinates;

  const origin = detail?.trip?.origin;
  const destination = detail?.trip?.destination;
  if (Number.isFinite(origin?.lng) && Number.isFinite(destination?.lng)) {
    return [[origin.lng, origin.lat], [destination.lng, destination.lat]];
  }

  const seen = detail?.last_seen;
  if (Number.isFinite(seen?.lng)) return [[seen.lng, seen.lat]];
  return null;
}
