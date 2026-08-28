// Hand-rolled SVG charts for the analytics deep-dive.
//
// No chart library. Not asceticism -- the console's whole visual language is
// hairlines, monospace and a 1px grid, and every charting library ships an
// opinion about axes, fonts and padding that then has to be fought back to
// this. Three chart forms, each about forty lines, is less code than the
// configuration required to make a library agree with tokens.css.
//
// ---------------------------------------------------------------- one axis
//
// Every chart here plots exactly ONE measure. That is a rule, not a
// simplification: a temperature line and a precipitation area sharing an x
// axis and two different y scales is the single most misleading thing a
// weather panel can draw, because the crossings between the two curves are
// artefacts of the scales chosen and readers reliably interpret them as
// events. Temperature, wind, humidity and visibility are carried in the stat
// tiles and the hourly table instead, where they are numbers rather than
// implied correlations.
//
// -------------------------------------------------------------- geometry
//
// The SVGs use preserveAspectRatio="none" so they stretch to whatever width
// the grid gives them, which is what keeps them responsive without measuring
// the container. That non-uniform scale would distort strokes and text, so:
// every stroked mark carries vector-effect="non-scaling-stroke", and NO text
// lives inside the SVG -- axis labels are HTML positioned over it in percent.
import React, { useMemo, useState } from 'react';

/// The chart hue. One series per chart, so this is a sequential/single-hue
/// choice rather than a categorical palette -- there is no second series for
/// it to be confused with, and no legend is needed because the title names it.
/// Measured >= 3:1 against this substrate. Blue because the measure it draws
/// is rainfall.
const SERIES = '#58A6FF';
/// Status, not series. Only ever applied to marks that are ALSO labelled --
/// the tooltip names the hour and the figure -- never as the sole encoding.
const OVER = '#F85149';

/// Above this, an hour's rainfall is worth marking rather than merely
/// plotting. IMD calls 7.5-35 mm/h "heavy"; 7.5 is the bottom of that band and
/// the point at which a hill road starts shedding material.
export const HEAVY_RAIN_MMH = 7.5;

/* ------------------------------------------------------------- sparkline */

/**
 * The shape of a metric, inside a stat tile.
 *
 * aria-hidden and unlabelled by design. It carries no readable value -- the
 * tile states the current figure beside it and the hourly table carries every
 * point -- so announcing it would read a decoration to a screen reader. It
 * exists to answer "is this rising" in peripheral vision.
 */
export function Sparkline({ values, color = SERIES, height = 28 }) {
  const points = values.filter(Number.isFinite);
  if (points.length < 2) return <div style={{ height }} />;

  const min = Math.min(...points);
  const max = Math.max(...points);
  // A flat series would divide by zero and, worse, draw a line at the top of
  // the box implying a maximum. Flat draws through the middle.
  const span = max - min || 1;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 100 - ((v - min) / span) * 100;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ height, width: '100%', display: 'block' }}
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ------------------------------------------------------------ area chart */

/**
 * One measure over time, with a crosshair and a tooltip.
 *
 * The hover layer is not optional decoration. An hourly series 48 points wide
 * is about 6 px per point at this width -- far too fine to read a value off by
 * eye -- so without a tooltip the chart can only communicate a shape, and the
 * exact figures would exist nowhere but the table.
 */
export function AreaChart({
  series, height = 260, valueKey = 'precipitation_mm', unit = 'mm',
  format = (v) => v.toFixed(1), markAbove = null,
}) {
  const [hover, setHover] = useState(null);

  const rows = useMemo(
    () => series.filter((r) => Number.isFinite(r?.[valueKey])),
    [series, valueKey]);

  const geometry = useMemo(() => {
    if (rows.length < 2) return null;
    const values = rows.map((r) => r[valueKey]);
    const max = Math.max(...values);
    const min = Math.min(0, ...values);
    // Headroom so the peak is not welded to the top edge, and a floor of 1 so
    // a dry forecast does not scale its own rounding noise to full height --
    // which would draw 0.02 mm as a mountain range.
    const top = Math.max(max * 1.15, 1);
    const at = (i) => (i / (rows.length - 1)) * 100;
    const to = (v) => 100 - ((v - min) / (top - min)) * 100;

    const line = rows
      .map((r, i) => `${i === 0 ? 'M' : 'L'}${at(i).toFixed(2)},${to(r[valueKey]).toFixed(2)}`)
      .join(' ');
    return { line, area: `${line} L100,100 L0,100 Z`, top, at, to, values };
  }, [rows, valueKey]);

  if (!geometry) {
    return (
      <div style={{ height }} className="grid place-items-center border border-edge">
        <p className="meta">Not enough data to plot</p>
      </div>
    );
  }

  // Four gridlines. Recessive: hairline, no labels on the plot itself, values
  // read off the axis column to the left.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    fraction: f,
    value: geometry.top * (1 - f),
  }));

  const onMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - box.left) / box.width;
    const index = Math.round(fraction * (rows.length - 1));
    if (index >= 0 && index < rows.length) setHover(index);
  };

  return (
    <div className="flex gap-2">
      {/* Axis labels as HTML, because the SVG is non-uniformly scaled and
          text inside it would stretch with the width. */}
      <div className="relative w-10 shrink-0" style={{ height }}>
        {ticks.map((tick) => (
          <span
            key={tick.fraction}
            className="meta absolute right-0 -translate-y-1/2 tabular-nums"
            style={{ top: `${tick.fraction * 100}%` }}
          >
            {tick.value >= 10 ? tick.value.toFixed(0) : tick.value.toFixed(1)}
          </span>
        ))}
      </div>

      <div
        className="relative min-w-0 flex-1"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ height: '100%', width: '100%', display: 'block' }}
          role="img"
          aria-label={`${valueKey} over ${rows.length} hours, in ${unit}. `
            + `Peak ${format(Math.max(...geometry.values))} ${unit}. `
            + 'Exact values are listed in the hourly table below.'}
        >
          {ticks.map((tick) => (
            <line
              key={tick.fraction}
              x1="0" x2="100"
              y1={tick.fraction * 100} y2={tick.fraction * 100}
              stroke="#2A2A2A" strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <defs>
            <linearGradient id="area-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES} stopOpacity="0.28" />
              <stop offset="100%" stopColor={SERIES} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          <path d={geometry.area} fill="url(#area-fade)" stroke="none" />
          <path
            d={geometry.line}
            fill="none"
            stroke={SERIES}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Hours over the heavy-rain threshold, marked. Status colour, and
              never the only encoding -- the tooltip names the hour and the
              figure, and the table repeats both. */}
          {markAbove !== null && rows.map((row, i) => (
            row[valueKey] > markAbove ? (
              <circle
                key={row.time}
                cx={geometry.at(i)} cy={geometry.to(row[valueKey])}
                r="1.6" fill={OVER}
                vectorEffect="non-scaling-stroke"
              />
            ) : null
          ))}

          {hover !== null && (
            <line
              x1={geometry.at(hover)} x2={geometry.at(hover)}
              y1="0" y2="100"
              stroke="#3D3D3D" strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* The marker and the tooltip are HTML, positioned in percent, for the
            same reason the axis labels are: they must not stretch. */}
        {hover !== null && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute h-2 w-2 -translate-x-1/2
                         -translate-y-1/2 rounded-full border border-base"
              style={{
                left: `${geometry.at(hover)}%`,
                top: `${geometry.to(rows[hover][valueKey])}%`,
                backgroundColor: rows[hover][valueKey] > (markAbove ?? Infinity)
                  ? OVER : SERIES,
              }}
            />
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 border
                         border-edge-active bg-base/95 px-2 py-1 font-mono text-[10px]
                         text-phosphor"
              style={{
                left: `${clamp(geometry.at(hover), 12, 88)}%`,
                top: 4,
              }}
            >
              <div className="text-muted">{hourLabel(rows[hover].time)}</div>
              <div className="tabular-nums">
                {format(rows[hover][valueKey])} {unit}
              </div>
            </div>
          </>
        )}

        <div className="pointer-events-none absolute inset-x-0 -bottom-4 flex justify-between">
          <span className="meta">{hourLabel(rows[0].time)}</span>
          <span className="meta">{hourLabel(rows[rows.length - 1].time)}</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- bar chart */

/**
 * Per-day totals.
 *
 * Bars, not a second line: a day is a bucket with a magnitude, and a line
 * between three daily totals implies values at the instants between them that
 * nothing measured.
 */
export function BarChart({ days, height = 200 }) {
  const [hover, setHover] = useState(null);
  const rows = days ?? [];
  if (rows.length === 0) {
    return (
      <div style={{ height }} className="grid place-items-center border border-edge">
        <p className="meta">No daily totals</p>
      </div>
    );
  }

  const max = Math.max(1, ...rows.map((d) => d.precipitation_mm ?? 0));

  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {rows.map((day, i) => {
          const value = day.precipitation_mm ?? 0;
          // Floor of 2px so a dry day is still a visible mark rather than a
          // gap the reader has to interpret as missing data.
          const pct = Math.max((value / max) * 100, 1.5);
          const partial = Number.isFinite(day.hours) && day.hours < 24;
          return (
            <div
              key={day.date}
              className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {hover === i && (
                <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-1
                                border border-edge-active bg-base/95 px-2 py-1
                                font-mono text-[10px] text-phosphor">
                  <div className="tabular-nums">{value.toFixed(1)} mm</div>
                  {partial && (
                    <div className="text-muted">{day.hours} h of forecast</div>
                  )}
                </div>
              )}
              <div
                // 4px rounded data-end, anchored to the baseline. The gap
                // between bars is the flex gap above, not a border, so the
                // substrate shows through rather than a drawn divider.
                className="w-full rounded-t"
                style={{
                  height: `${pct}%`,
                  backgroundColor: SERIES,
                  // A partial day is drawn hatched, because a first day that
                  // starts at the current hour is not comparable to a whole
                  // one and a plain shorter bar would read as "less rain".
                  opacity: partial ? 0.55 : 1,
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex gap-2">
        {rows.map((day) => (
          <div key={day.date} className="min-w-0 flex-1 text-center">
            <div className="meta truncate">{dayLabel(day.date)}</div>
            <div className="font-mono text-[11px] tabular-nums text-phosphor">
              {(day.precipitation_mm ?? 0).toFixed(1)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- utils */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/// "14:00". UTC, matching the series and the window the page states.
export function hourLabel(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${String(at.getUTCHours()).padStart(2, '0')}:00`;
}

/// "Fri 29" — a weekday, because "2026-08-29" makes a reader do arithmetic to
/// find out whether it is the weekend.
export function dayLabel(date) {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;
  return at.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', timeZone: 'UTC',
  });
}
