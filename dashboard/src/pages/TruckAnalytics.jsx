// One truck, in depth — /analytics/:truckId (task 2).
//
// Reached by clicking a box in the truck selector on /analytics. Four things,
// in the order a dispatcher asks for them when a driver is on the radio:
// which truck is this, where is it going and when does it arrive, who do I
// call, and what is the weather doing to the road in front of them.
//
// The weather is the bulk of the page and it is deliberately NOT a single
// reading. A 95 km corridor from Guwahati to Shillong climbs about 1,400 m,
// and the difference between the two ends is routinely the difference between
// rain and no rain -- so the forecast is sampled at the origin, the midpoint
// and the destination, the headline figures are the WORST of the three, and
// the per-point breakdown is one click away in the table. A dispatcher told
// "12 mm/h" for a corridor needs to know that is the Shillong end.
import React, { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AreaChart, BarChart, Sparkline, hourLabel, HEAVY_RAIN_MMH } from '../components/Charts';
import { useTruckAnalytics } from '../hooks/useTruckAnalytics';
import { truckHex, truckRgba } from '../lib/truckColors';

/// The five metrics the page leads with, and how each is read.
///
/// `worst` is the direction that matters operationally, and it is not the
/// same for all five: more rain and more wind are worse, LESS visibility is
/// worse, and temperature has no worse direction at all -- it is context, so
/// it reports its range rather than an extreme.
const METRICS = [
  {
    key: 'precipitation_mm',
    label: 'Precipitation',
    unit: 'mm/h',
    digits: 1,
    worst: 'max',
    // The one metric with a threshold worth naming on the tile.
    threshold: HEAVY_RAIN_MMH,
  },
  { key: 'temperature_c', label: 'Temperature', unit: '°C', digits: 1, worst: 'range' },
  { key: 'wind_speed_kmh', label: 'Wind speed', unit: 'km/h', digits: 0, worst: 'max' },
  { key: 'humidity_pct', label: 'Humidity', unit: '%', digits: 0, worst: 'max' },
  {
    key: 'visibility_m',
    label: 'Visibility',
    unit: 'km',
    digits: 1,
    worst: 'min',
    // Metres on the wire, kilometres on the glass: 6,060 m is a number a
    // reader has to convert before it means anything about a road.
    scale: (v) => v / 1000,
  },
];

export default function TruckAnalytics({ trucks }) {
  const { truckId } = useParams();
  const { detail, weather, loading, error, weatherError, refresh } = useTruckAnalytics(truckId);

  // Which series the tiles, chart and table are reading: the route-wide worst
  // case, or one sampled point. Route is the default because a dispatcher
  // asking "can this truck get through" is asking about the whole corridor.
  const [view, setView] = useState('route');

  const live = useMemo(
    () => (trucks ?? []).find((t) => t.truck_id === truckId) ?? null,
    [trucks, truckId]);

  const series = useMemo(() => {
    if (!weather) return [];
    if (view === 'route') return weather.route ?? [];
    return weather.points?.find((p) => p.label === view)?.hourly ?? [];
  }, [weather, view]);

  const truck = detail?.truck;
  const trip = detail?.trip;
  const hex = truckHex(truckId);

  if (error) {
    return (
      <Shell truckId={truckId} hex={hex}>
        <div className="p-5">
          <p className="meta text-danger-text">Could not load this truck — {error}</p>
          <button type="button" onClick={refresh}
            className="focus-ring mt-3 border border-edge px-3 py-1.5 font-mono
                       text-[11px] text-phosphor hover:border-edge-active">
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      truckId={truckId}
      hex={hex}
      plate={truck?.plate}
      live={live}
      windowStart={weather?.window_start_utc}
      onRefresh={refresh}
    >
      <div className="grid gap-4 p-5 xl:grid-cols-12">
        {/* --------------------------------------------------- the metrics */}
        <div className="xl:col-span-12">
          <h2 className="meta mb-2">Forecast — next {weather?.hours ?? 48} hours</h2>

          {weatherError ? (
            <div className="border border-edge bg-panel/60 p-4">
              <p className="meta text-danger-text">Forecast unavailable — {weatherError}</p>
              <p className="meta mt-1 normal-case tracking-normal">
                Route and driver details below are unaffected.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {METRICS.map((metric) => (
                <MetricTile
                  key={metric.key}
                  metric={metric}
                  series={series}
                  loading={loading}
                />
              ))}
            </div>
          )}
        </div>

        {/* ---------------------------------------------------- the charts */}
        {series.length > 0 && (
          <>
            <div className="xl:col-span-8">
              <Panel
                title="PRECIPITATION"
                hint={`Hourly, ${viewLabel(view)}. Marked above `
                  + `${HEAVY_RAIN_MMH} mm/h — IMD 'heavy'. Hover for a value.`}
                action={(
                  <ViewSwitch
                    view={view}
                    setView={setView}
                    points={weather?.points ?? []}
                  />
                )}
              >
                {/* One measure, one axis. See the note at the top of
                    Charts.jsx for why temperature is not overlaid here. */}
                <AreaChart
                  series={series}
                  valueKey="precipitation_mm"
                  unit="mm"
                  markAbove={HEAVY_RAIN_MMH}
                  height={260}
                />
                <div className="h-4" />
              </Panel>
            </div>

            <div className="xl:col-span-4">
              <Panel
                title="DAILY RAINFALL"
                hint="UTC days. A part-day bar is drawn faded — today starts at the current hour."
              >
                <BarChart days={weather?.daily ?? []} height={200} />
              </Panel>
            </div>
          </>
        )}

        {/* ----------------------------------------- hourly table + details */}
        <div className="xl:col-span-8">
          <Panel
            title="HOURLY DETAIL"
            hint={`${viewLabel(view)} · all times UTC`}
          >
            <HourlyTable series={series} loading={loading} />
          </Panel>
        </div>

        <div className="flex flex-col gap-4 xl:col-span-4">
          <Panel title="ACTIVE ROUTE" hint={trip ? undefined : 'No active trip'}>
            <RouteDetails trip={trip} loading={loading} />
          </Panel>

          <Panel title="DRIVER">
            <DriverDetails truck={truck} loading={loading} />
          </Panel>

          {weather && (
            <Panel title="PROVENANCE" hint="Read the figures above against this">
              <ul className="space-y-2.5">
                <Note>
                  Open-Meteo, sampled at {weather.sampled} point
                  {weather.sampled === 1 ? '' : 's'} along the planned route.
                </Note>
                <Note>
                  The window starts <strong className="text-phosphor">
                    {weather.window_start_utc}
                  </strong> — located by searching <code className="text-phosphor">hourly.time</code>,
                  never sliced from index 0.
                </Note>
                <Note>
                  Route figures are the <strong className="text-phosphor">worst</strong> of the
                  sampled points per hour, not a mean. A corridor is only as
                  passable as its worst point.
                </Note>
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </Shell>
  );
}

/* ---------------------------------------------------------------- shell */

function Shell({ truckId, hex, plate, live, windowStart, onRefresh, children }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="border-b border-edge px-5 py-4">
        <Link
          to="/analytics"
          className="focus-ring meta inline-block normal-case tracking-normal
                     text-muted transition-colors hover:text-phosphor"
        >
          ← Analytics
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          {/* The swatch. Same colour this truck is drawn in on the map, from
              the same function -- see lib/truckColors. */}
          <span
            aria-hidden
            className="h-5 w-5 shrink-0 border border-edge"
            style={{ backgroundColor: hex }}
          />
          <h1 className="font-display text-[18px] tracking-crush text-phosphor">
            {plate ?? String(truckId).slice(0, 8)}
          </h1>
          {live && (
            <span className={`meta ${live.source === 'ekf' ? 'text-warn' : 'text-live'}`}>
              {live.source === 'ekf' ? 'DEAD RECKONING' : 'GNSS FIX'}
              {' · '}
              {(live.speed ?? 0).toFixed(1)} m/s
            </span>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="focus-ring ml-auto border border-edge px-2.5 py-1
                         font-mono text-[10px] uppercase tracking-term text-muted
                         transition-colors hover:border-edge-active hover:text-phosphor"
            >
              Refresh
            </button>
          )}
        </div>

        <p className="meta mt-1.5 truncate normal-case tracking-normal">
          {truckId}
          {windowStart ? ` · forecast from ${windowStart}` : ''}
        </p>
      </header>

      {children}
    </div>
  );
}

function Panel({ title, hint, action, children }) {
  return (
    <section className="border border-edge bg-panel/60">
      <header className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-display text-[13px] tracking-crush text-phosphor">{title}</h2>
          {hint && <p className="meta mt-1 normal-case tracking-normal">{hint}</p>}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/* ----------------------------------------------------------- stat tiles */

/**
 * One metric: the current hour, how it moves over the next 24, and its shape.
 *
 * The chip states the change over 24 hours rather than a percentage. A
 * percentage of a rainfall rate is close to meaningless -- 0.1 mm/h to
 * 0.4 mm/h is "+300%" and also nothing at all -- so the delta is in the
 * metric's own unit, which is the only form that survives a near-zero base.
 */
function MetricTile({ metric, series, loading }) {
  const scale = metric.scale ?? ((v) => v);
  const values = series
    .map((row) => row[metric.key])
    .filter(Number.isFinite)
    .map(scale);

  if (loading && values.length === 0) {
    return (
      <div className="border border-edge bg-panel/60 p-3">
        <p className="meta">{metric.label}</p>
        <p className="mt-2 font-mono text-[22px] text-muted">…</p>
      </div>
    );
  }
  if (values.length === 0) {
    return (
      <div className="border border-edge bg-panel/60 p-3">
        <p className="meta">{metric.label}</p>
        <p className="mt-2 font-mono text-[22px] text-muted">—</p>
      </div>
    );
  }

  const now = values[0];
  // 24 hours ahead where the series reaches that far, the last hour otherwise.
  const ahead = values[Math.min(24, values.length - 1)];
  const delta = ahead - now;

  const next24 = values.slice(0, 25);
  const extreme = metric.worst === 'min'
    ? Math.min(...next24)
    : Math.max(...next24);

  const over = metric.threshold !== undefined
    && Math.max(...next24) > metric.threshold;

  return (
    <div className="border border-edge bg-panel/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="meta truncate">{metric.label}</p>
        {/* Direction in a glyph AND a sign, never colour alone. */}
        <span className={`shrink-0 font-mono text-[10px] tabular-nums
                          ${delta === 0 ? 'text-muted' : 'text-dim'}`}>
          {delta > 0 ? '▲' : delta < 0 ? '▼' : '·'}
          {' '}
          {Math.abs(delta).toFixed(metric.digits)} / 24h
        </span>
      </div>

      <p className="mt-1.5 font-mono text-[22px] tabular-nums text-phosphor">
        {now.toFixed(metric.digits)}
        <span className="ml-1 text-[11px] text-muted">{metric.unit}</span>
      </p>

      <div className="mt-1">
        <Sparkline values={values} />
      </div>

      <p className={`meta mt-1 normal-case tracking-normal
                     ${over ? 'text-danger-text' : ''}`}>
        {metric.worst === 'range'
          ? `${Math.min(...next24).toFixed(metric.digits)}–`
            + `${Math.max(...next24).toFixed(metric.digits)} over 24 h`
          : `${metric.worst === 'min' ? 'Low' : 'Peak'} `
            + `${extreme.toFixed(metric.digits)} ${metric.unit} in 24 h`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ the table */

function HourlyTable({ series, loading }) {
  if (series.length === 0) {
    return <p className="meta">{loading ? 'Loading forecast…' : 'No hourly data'}</p>;
  }

  return (
    // Scrolls in its own box rather than growing the page: 48 rows is a long
    // way past the route and driver panels beside it, and a table that pushes
    // them off screen makes the page worse at its main job.
    <div className="max-h-[360px] overflow-y-auto">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-edge text-left">
            <Th>UTC</Th>
            <Th align="right">Temp °C</Th>
            <Th align="right">Rain mm</Th>
            <Th align="right">Prob %</Th>
            <Th align="right">Wind km/h</Th>
            <Th align="right">RH %</Th>
            <Th align="right">Vis km</Th>
          </tr>
        </thead>
        <tbody>
          {series.map((row) => {
            const heavy = Number.isFinite(row.precipitation_mm)
              && row.precipitation_mm > HEAVY_RAIN_MMH;
            return (
              <tr key={row.time} className="border-b border-edge/50">
                <Td>{hourLabel(row.time)}</Td>
                <Td align="right">{fmt(row.temperature_c, 1)}</Td>
                <Td align="right" tone={heavy ? 'text-danger-text' : undefined}>
                  {fmt(row.precipitation_mm, 1)}
                </Td>
                <Td align="right">{fmt(row.precipitation_probability_pct, 0)}</Td>
                <Td align="right">{fmt(row.wind_speed_kmh, 0)}</Td>
                <Td align="right">{fmt(row.humidity_pct, 0)}</Td>
                <Td align="right">
                  {Number.isFinite(row.visibility_m)
                    ? (row.visibility_m / 1000).toFixed(1) : '—'}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// NOTE: the alignment class is a whole literal, never `text-${align}`.
// Tailwind's JIT scans source text for complete class names; an interpolated
// one is never emitted, so a right-aligned column would silently render left
// and the numbers would not line up under their headers.
function Th({ children, align = 'left' }) {
  return (
    <th className={`meta whitespace-nowrap px-2 py-1.5 font-normal
                    ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', tone = 'text-dim' }) {
  return (
    <td className={`whitespace-nowrap px-2 py-1 font-mono text-[11px] tabular-nums
                    ${align === 'right' ? 'text-right' : 'text-left'} ${tone}`}>
      {children}
    </td>
  );
}

/* ------------------------------------------------------- route + driver */

function RouteDetails({ trip, loading }) {
  if (!trip) {
    return (
      <p className="meta">
        {loading
          ? 'Loading…'
          : 'This truck has no active trip. Plan one from the command center.'}
      </p>
    );
  }

  const measured = trip.progress_source === 'route_position';
  const pct = Number.isFinite(trip.progress) ? trip.progress * 100 : null;

  return (
    <>
      <dl className="divide-y divide-edge/60">
        <Row label="Origin" value={placeLabel(trip.origin)} />
        <Row label="Destination" value={placeLabel(trip.destination)} />
        <Row label="Distance" value={km(trip.distance_m)} />
        <Row
          label="ETA"
          // Local time, not UTC. Every other timestamp on this page is UTC
          // and labelled so, but an arrival time is the one figure a
          // dispatcher acts on in their own day.
          value={trip.eta_utc
            ? new Date(trip.eta_utc).toLocaleString('en-GB', {
              hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
            })
            : '—'}
          tone="text-phosphor"
        />
        <Row label="Remaining" value={km(trip.remaining_distance_m)} />
        <Row
          label="Journey time"
          value={trip.duration_sec ? duration(trip.duration_sec) : '—'}
        />
      </dl>

      {pct !== null && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <span className="meta">Progress</span>
            <span className="font-mono text-[11px] tabular-nums text-phosphor">
              {pct.toFixed(0)}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full bg-inset">
            <div className="h-full bg-live" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          {/* Says HOW it was derived. A progress bar that cannot be traced to
              a measurement is a progress bar nobody should plan around. */}
          <p className="meta mt-1.5 normal-case tracking-normal">
            {measured
              ? 'Measured from the last fix against the planned route.'
              : 'No fix to locate against the route — planned figures shown.'}
          </p>
        </div>
      )}
    </>
  );
}

function DriverDetails({ truck, loading }) {
  if (!truck) return <p className="meta">{loading ? 'Loading…' : 'Unknown'}</p>;
  return (
    <dl className="divide-y divide-edge/60">
      <Row label="Name" value={truck.driver_name ?? 'Unassigned'} />
      <Row
        label="Contact"
        value={(
          <span className="flex items-center justify-end gap-2">
            <a
              href={`tel:${String(truck.phone).replace(/\s/g, '')}`}
              className="focus-ring text-phosphor underline decoration-edge-active
                         underline-offset-2"
            >
              {truck.phone}
            </a>
            {/* The flag matters more than the number. trucks.phone has been in
                the schema since migration 001 and is simply unpopulated on the
                demo fleet, so this is a stable placeholder derived from the
                truck id -- and an unmarked fake number in an incident console
                is something somebody eventually dials. */}
            {truck.phone_is_placeholder && (
              <span className="shrink-0 border border-edge px-1 font-mono text-[9px]
                               uppercase tracking-term text-warn">
                demo
              </span>
            )}
          </span>
        )}
      />
      <Row label="Plate" value={truck.plate} />
      <Row label="Alert language" value={langName(truck.alert_lang)} />
    </dl>
  );
}

/* ----------------------------------------------------------------- bits */

function ViewSwitch({ view, setView, points }) {
  const options = ['route', ...points.map((p) => p.label)];
  return (
    <div className="flex shrink-0 flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setView(option)}
          aria-pressed={view === option}
          className={`focus-ring border px-2 py-1 font-mono text-[10px] uppercase
                      tracking-term transition-colors
                      ${view === option
            ? 'border-edge-active bg-inset text-phosphor'
            : 'border-edge text-muted hover:text-phosphor'}`}
        >
          {option === 'route' ? 'Route' : option}
        </button>
      ))}
    </div>
  );
}

function Row({ label, value, tone = 'text-dim' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="meta shrink-0">{label}</dt>
      <dd className={`min-w-0 text-right font-mono text-[11px] ${tone}`}>{value}</dd>
    </div>
  );
}

function Note({ children }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-1 h-1 w-1 shrink-0 bg-edge-active" />
      <span className="font-mono text-[11px] leading-relaxed text-muted">{children}</span>
    </li>
  );
}

function viewLabel(view) {
  return view === 'route' ? 'route worst case' : `at the ${view.toLowerCase()}`;
}

function placeLabel(point) {
  if (!point) return '—';
  // The name when the endpoint matched a seeded place, the coordinates
  // otherwise. Never an invented name -- see nearestPlaceName in the backend.
  if (point.name) return point.name;
  if (!Number.isFinite(point.lat)) return '—';
  return `${point.lat.toFixed(3)}, ${point.lng.toFixed(3)}`;
}

function km(metres) {
  return Number.isFinite(metres) ? `${(metres / 1000).toFixed(1)} km` : '—';
}

function duration(seconds) {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m} min` : `${h} hr ${m} min`;
}

function fmt(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function langName(code) {
  return { as: 'Assamese', hi: 'Hindi', en: 'English' }[code] ?? (code ?? '—');
}
