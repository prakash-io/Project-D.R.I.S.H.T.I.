"""Tests for the Open-Meteo client.

Three of these guard bugs that were live and silent. Each produced a
plausible number, which is exactly why they need a test rather than a
comment:

*   `test_intensity_is_peak_not_mean` -- peak and mean are both one-liners
    over the same array, and the wrong one erases the difference between a
    cloudburst and a day of drizzle.
*   `test_window_starts_at_the_current_hour_not_midnight` -- the series begins
    at 00:00 UTC, so slicing from index 0 reports mostly-elapsed weather as a
    forecast.
*   `test_nulls_do_not_shift_later_hours_into_the_window` -- compacting nulls
    drags later hours leftwards; a storm outside the window is reported as
    being inside it.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "ai-services"))

from drishti_ai.weather import (FORECAST_DAYS, PAST_DAYS,  # noqa: E402
                                OpenMeteoClient, WeatherUnavailable)


def run(coro):
    """Drive one coroutine to completion.

    Deliberately not pytest-asyncio: the client has one async method, and a
    plugin to await it would be more machinery than the thing being tested.
    """
    return asyncio.run(coro)


def series_start() -> datetime:
    """00:00 UTC, `PAST_DAYS` before today -- where Open-Meteo begins."""
    midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight - timedelta(days=PAST_DAYS)


def now_index() -> int:
    """Index of the current hour within the returned series."""
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return int((now - series_start()).total_seconds() // 3600)


TOTAL_HOURS = (PAST_DAYS + FORECAST_DAYS) * 24


def make_payload(values: list) -> dict:
    """A realistically-shaped Open-Meteo response around the current hour."""
    start = series_start()
    stamps = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M")
              for i in range(len(values))]
    return {"hourly": {"time": stamps, "precipitation": values}}


def client_returning(values: list, calls: dict | None = None) -> OpenMeteoClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls["n"] = calls.get("n", 0) + 1
            calls["params"] = dict(request.url.params)
        return httpx.Response(200, json=make_payload(values))

    return OpenMeteoClient(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def flat(value: float = 0.0) -> list:
    return [value] * TOTAL_HOURS


# ----------------------------------------------------------------- windowing

def test_window_starts_at_the_current_hour_not_midnight():
    """The bug: `series[:24]` is 'today 00:00-23:00 UTC', not 'the next 24h'.

    Measured live at 16:42 UTC, 16 of those 24 hours had already elapsed.
    Here every past hour is poisoned with 99 mm; a correct window must not
    see any of it.
    """
    idx = now_index()
    values = flat(0.0)
    for i in range(idx):
        values[i] = 99.0          # everything before now
    values[idx + 5] = 7.0         # the only real future rain

    result = run(client_returning(values).precipitation(27.5, 92.0))

    assert result.rainfall_intensity_mmh == 7.0, "past hours leaked into the window"
    assert result.rainfall_24h_mm == pytest.approx(7.0)
    assert result.window == "forecast"


def test_enough_forward_hours_are_requested_to_fill_72():
    """3 forecast days is not enough: the series starts at midnight.

    At 16:00 UTC, `forecast_days=3` leaves only 56 hours ahead of now. The
    client must ask for 4 days so 72 forward hours always exist.
    """
    calls: dict = {}
    run(client_returning(flat(1.0), calls).precipitation(27.5, 92.0))

    assert int(calls["params"]["forecast_days"]) >= 4
    assert int(calls["params"]["past_days"]) >= 3
    # timezone=auto would re-base the series on local midnight, silently
    # moving the window.
    assert calls["params"]["timezone"] == "UTC"


def test_truncated_series_raises_instead_of_reporting_a_short_window():
    idx = now_index()
    truncated = flat(1.0)[: idx + 40]      # only 40 forward hours
    with pytest.raises(WeatherUnavailable, match="forward hours"):
        run(client_returning(truncated).precipitation(27.5, 92.0))


# -------------------------------------------------------------------- nulls

def test_nulls_do_not_shift_later_hours_into_the_window():
    """The 400x bug: compacting nulls pulls out-of-window rain into it."""
    idx = now_index()
    values = flat(0.1)
    for i in range(idx, idx + 6):
        values[i] = None            # 6 null hours at the head of the window
    values[idx + 28] = 40.0         # a cloudburst 4 hours PAST the 24h window

    result = run(client_returning(values).precipitation(27.5, 92.0))

    assert result.rainfall_intensity_mmh == 0.1, "out-of-window storm leaked in"
    # 24 hours of window, 6 of them unknown -> 18 known hours at 0.1.
    assert result.hours_known_24h == 18
    assert result.rainfall_24h_mm == pytest.approx(1.8)
    # The 72h window does contain the storm, and should say so.
    assert result.rainfall_72h_mm > 40.0


def test_hours_known_reports_gaps_rather_than_hiding_them():
    idx = now_index()
    values = flat(2.0)
    for i in range(idx + 3, idx + 9):
        values[i] = None

    result = run(client_returning(values).precipitation(27.5, 92.0))

    assert result.hours_known_24h == 18
    assert result.hours_known_72h == 66
    assert result.rainfall_24h_mm == pytest.approx(36.0)  # 18 known hours only


def test_all_null_window_raises():
    values: list = [None] * TOTAL_HOURS
    with pytest.raises(WeatherUnavailable, match="no usable precipitation"):
        run(client_returning(values).precipitation(27.5, 92.0))


# ---------------------------------------------------------------- aggregates

def test_intensity_is_peak_not_mean():
    idx = now_index()
    values = flat(0.5)
    values[idx + 7] = 30.0

    result = run(client_returning(values).precipitation(27.5, 92.0))

    assert result.rainfall_intensity_mmh == 30.0
    mean_24h = (0.5 * 23 + 30.0) / 24
    assert result.rainfall_intensity_mmh > mean_24h * 15


def test_24h_and_72h_are_sums_over_their_own_windows():
    idx = now_index()
    values = flat(0.0)
    for i in range(idx, idx + 24):
        values[i] = 1.0
    for i in range(idx + 24, idx + 72):
        values[i] = 2.0

    result = run(client_returning(values).precipitation(26.0, 92.0))

    assert result.rainfall_24h_mm == pytest.approx(24.0)
    assert result.rainfall_72h_mm == pytest.approx(24.0 + 96.0)
    # The peak is the first 24 hours' peak, not the horizon's.
    assert result.rainfall_intensity_mmh == pytest.approx(1.0)


def test_antecedent_window_reads_backwards_from_now():
    """'antecedent' must cover the hours BEFORE now, not after."""
    idx = now_index()
    values = flat(0.0)
    values[idx - 5] = 12.0          # 5 hours ago
    values[idx + 5] = 99.0          # 5 hours ahead -- must be ignored

    result = run(client_returning(values).precipitation(
        27.5, 92.0, window="antecedent"))

    assert result.window == "antecedent"
    assert result.rainfall_intensity_mmh == 12.0
    assert result.rainfall_24h_mm == pytest.approx(12.0)


def test_forecast_and_antecedent_are_cached_separately():
    idx = now_index()
    values = flat(0.0)
    values[idx - 5] = 12.0
    values[idx + 5] = 34.0
    c = client_returning(values)

    forward = run(c.precipitation(27.5, 92.0, window="forecast"))
    backward = run(c.precipitation(27.5, 92.0, window="antecedent"))

    assert forward.rainfall_intensity_mmh == 34.0
    assert backward.rainfall_intensity_mmh == 12.0


def test_unknown_window_is_rejected():
    with pytest.raises(ValueError, match="forecast.*antecedent"):
        run(client_returning(flat(1.0)).precipitation(27.5, 92.0, window="yesterday"))


# --------------------------------------------------------------------- cache

def test_cache_collapses_nearby_queries():
    calls: dict = {}
    c = client_returning(flat(1.0), calls)
    run(c.precipitation(27.50, 92.00))
    run(c.precipitation(27.51, 92.02))      # same 0.1 deg cell
    assert calls["n"] == 1

    run(c.precipitation(28.90, 92.00))      # different cell
    assert calls["n"] == 2


def test_cache_can_be_bypassed():
    calls: dict = {}
    c = client_returning(flat(1.0), calls)
    run(c.precipitation(27.5, 92.0))
    run(c.precipitation(27.5, 92.0, use_cache=False))
    assert calls["n"] == 2


def test_cache_is_bounded():
    c = client_returning(flat(1.0))
    c.MAX_CACHE_ENTRIES = 8
    for i in range(40):
        run(c.precipitation(21.0 + i * 0.5, 92.0))
    assert len(c._cache) <= 8


# ------------------------------------------------------------------ failures

def test_upstream_failure_raises_rather_than_inventing_rain():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="upstream down")

    c = OpenMeteoClient(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(WeatherUnavailable):
        run(c.precipitation(27.5, 92.0))


def test_missing_time_array_raises():
    """Without `time` the window cannot be located, so guessing is refused."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"hourly": {"precipitation": flat(1.0)}})

    c = OpenMeteoClient(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(WeatherUnavailable, match="precipitation/time"):
        run(c.precipitation(27.5, 92.0))


def test_length_mismatch_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        payload = make_payload(flat(1.0))
        payload["hourly"]["precipitation"] = payload["hourly"]["precipitation"][:-5]
        return httpx.Response(200, json=payload)

    c = OpenMeteoClient(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(WeatherUnavailable, match="length mismatch"):
        run(c.precipitation(27.5, 92.0))
