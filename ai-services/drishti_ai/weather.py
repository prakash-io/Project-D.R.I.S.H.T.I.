"""Open-Meteo precipitation client (ML-03).

Supplies the three rainfall features the hazard model consumes:

    rainfall_intensity_mmh  peak of the 24 hourly values in the window
    rainfall_24h_mm         sum of the 24 hourly values in the window
    rainfall_72h_mm         sum of the 72 hourly values in the window

**Intensity is a peak, not an average.** A 24 mm day arriving as 1 mm/h for a
day and the same 24 mm arriving in a single hour are completely different
landslide hazards, and averaging makes them identical. The training data
agrees: `rainfall_intensity_mmh` reaches 32.96 mm/h against a
`rainfall_24h_mm` median of 70.8, which no averaging could produce.

Two window bugs this module exists to not have
----------------------------------------------
Both were live, and both produced confident, plausible, wrong numbers.

1.  **The series does not start "now".** With `timezone=UTC`, Open-Meteo
    returns whole days: `forecast_days=3` begins at 00:00 UTC *today*, not at
    the current hour. Measured at 16:42 UTC, `series[:24]` was 16 hours of
    already-elapsed weather plus 8 hours of forecast, and only 56 of the 72
    required forward hours existed at all. The window is therefore located by
    searching `hourly.time` for the current hour, never by slicing from 0.

2.  **Nulls must not be compacted.** Open-Meteo emits `null` for hours it has
    no value for. Dropping them from the list shifts every later hour
    *leftwards* into the window: with 6 leading nulls, a 40 mm/h cloudburst at
    true hour 28 -- four hours outside the window -- was reported as the 24 h
    peak, a 400x error on the feature carrying the most hazard signal. Nulls
    are now skipped in place, and the count of hours that actually backed each
    figure is reported alongside it.

`past_days=3` is requested as well as forward days, so the antecedent windows
come back in the same call. That makes `RAINFALL_WINDOW` a configuration
choice rather than a code change -- see the note on `WindowMode` below.
"""

from __future__ import annotations

import time as _time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from . import config

HOURS_24 = 24
HOURS_72 = 72

#: Days of history requested. Only needs to cover the 72 h antecedent window.
PAST_DAYS = 3
#: Days of forecast requested. 4, not 3: the series starts at 00:00 UTC, so up
#: to 23 hours of the first day are already spent. 4 days guarantees at least
#: 72 hours remain ahead of the current hour whatever the time of day.
FORECAST_DAYS = 4


class WeatherUnavailable(RuntimeError):
    """Open-Meteo could not be reached or returned an unusable payload."""


@dataclass
class Precipitation:
    rainfall_intensity_mmh: float
    rainfall_24h_mm: float
    rainfall_72h_mm: float
    window: str
    window_start_utc: str
    #: Hours in each window that carried a real value. Less than the window
    #: length means Open-Meteo had gaps, and the figures cover only what it had.
    hours_known_24h: int
    hours_known_72h: int
    source: str = "open-meteo"
    fetched_at: float = field(default_factory=_time.time)

    def as_features(self) -> dict[str, float]:
        return {
            "rainfall_72h_mm": self.rainfall_72h_mm,
            "rainfall_24h_mm": self.rainfall_24h_mm,
            "rainfall_intensity_mmh": self.rainfall_intensity_mmh,
        }


def _parse_hour(stamp: str) -> datetime:
    """Open-Meteo emits naive local-to-`timezone` stamps; ours are UTC."""
    return datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)


def _window_stats(values: list, start: int, length: int) -> tuple[float, float, int]:
    """(peak, total, hours_known) over `length` hours from index `start`.

    Nulls are skipped **in place** -- the slice is taken by hour index first,
    so a gap shortens the evidence rather than pulling later hours forward.
    """
    window = values[start:start + length]
    known = [float(v) for v in window if v is not None]
    if not known:
        return 0.0, 0.0, 0
    return max(known), sum(known), len(known)


class OpenMeteoClient:
    """Async precipitation client with a small bounded TTL cache.

    The cache key rounds the coordinate to `WEATHER_CACHE_PRECISION` decimal
    places. At the default of 1 that is ~11 km, which is Open-Meteo's own grid
    spacing -- so two queries that share a cache entry would have received the
    same upstream answer anyway.
    """

    #: Bounded so a long-running dispatcher sweep cannot grow it without limit.
    #: LRU eviction; ~11 km cells, so this covers a large operating area.
    MAX_CACHE_ENTRIES = 2048

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=config.OPEN_METEO_TIMEOUT_S)
        self._owns_client = client is None
        self._cache: OrderedDict[tuple[float, float], Precipitation] = OrderedDict()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _cache_key(self, lat: float, lon: float) -> tuple[float, float]:
        p = config.WEATHER_CACHE_PRECISION
        return (round(lat, p), round(lon, p))

    def _cache_get(self, key) -> Precipitation | None:
        hit = self._cache.get(key)
        if hit is None:
            return None
        if (_time.time() - hit.fetched_at) >= config.WEATHER_CACHE_TTL_S:
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        return hit

    def _cache_put(self, key, value: Precipitation) -> None:
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > self.MAX_CACHE_ENTRIES:
            self._cache.popitem(last=False)

    async def precipitation(
        self,
        lat: float,
        lon: float,
        *,
        use_cache: bool = True,
        window: str | None = None,
    ) -> Precipitation:
        """Precipitation aggregates around the current hour.

        `window` is 'forecast' (the next N hours, the default, and what
        workflow section 5's pre-emptive rerouting needs) or 'antecedent'
        (the previous N hours, which is what physically triggers a landslide).
        Defaults to `config.RAINFALL_WINDOW`.
        """
        window = window or config.RAINFALL_WINDOW
        if window not in ("forecast", "antecedent"):
            raise ValueError(f"window must be 'forecast' or 'antecedent', got {window!r}")

        key = (*self._cache_key(lat, lon), window)
        if use_cache:
            hit = self._cache_get(key)
            if hit is not None:
                return hit

        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": "precipitation",
            "past_days": PAST_DAYS,
            "forecast_days": FORECAST_DAYS,
            # UTC throughout. `timezone=auto` would re-base the series on the
            # location's local midnight, moving the window without saying so.
            "timezone": "UTC",
            "precipitation_unit": "mm",
        }
        try:
            response = await self._client.get(config.OPEN_METEO_URL, params=params)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPError as exc:
            raise WeatherUnavailable(f"Open-Meteo request failed: {exc}") from exc
        except ValueError as exc:
            raise WeatherUnavailable(f"Open-Meteo returned non-JSON: {exc}") from exc

        hourly = payload.get("hourly") or {}
        values = hourly.get("precipitation")
        stamps = hourly.get("time")
        if not values or not stamps:
            raise WeatherUnavailable(
                f"Open-Meteo response has no hourly precipitation/time series: "
                f"{str(payload)[:200]}"
            )
        if len(values) != len(stamps):
            raise WeatherUnavailable(
                f"Open-Meteo time/precipitation length mismatch: "
                f"{len(stamps)} vs {len(values)}"
            )

        # Locate the current hour rather than assuming index 0 is 'now'.
        now_hour = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        current = next((i for i, s in enumerate(stamps) if _parse_hour(s) >= now_hour), None)
        if current is None:
            raise WeatherUnavailable(
                f"Open-Meteo series ends at {stamps[-1]}, before the current hour "
                f"{now_hour.isoformat()} -- cannot locate the window"
            )

        if window == "forecast":
            start = current
            if start + HOURS_72 > len(values):
                raise WeatherUnavailable(
                    f"Open-Meteo returned only {len(values) - start} forward hours "
                    f"from {stamps[start]}; {HOURS_72} are required"
                )
        else:
            start = current - HOURS_72
            if start < 0:
                raise WeatherUnavailable(
                    f"Open-Meteo returned only {current} past hours; "
                    f"{HOURS_72} are required for the antecedent window"
                )

        if window == "forecast":
            peak, total_24, known_24 = _window_stats(values, start, HOURS_24)
            _, total_72, known_72 = _window_stats(values, start, HOURS_72)
        else:
            # The antecedent 24 h is the 24 hours immediately before now, which
            # is the END of the 72 h block, not its start.
            peak, total_24, known_24 = _window_stats(values, current - HOURS_24, HOURS_24)
            _, total_72, known_72 = _window_stats(values, start, HOURS_72)

        if known_24 == 0 and known_72 == 0:
            raise WeatherUnavailable(
                f"Open-Meteo returned no usable precipitation values in the "
                f"{window} window starting {stamps[start]}"
            )

        result = Precipitation(
            rainfall_intensity_mmh=peak,
            rainfall_24h_mm=total_24,
            rainfall_72h_mm=total_72,
            window=window,
            window_start_utc=stamps[start],
            hours_known_24h=known_24,
            hours_known_72h=known_72,
        )
        self._cache_put(key, result)
        return result
