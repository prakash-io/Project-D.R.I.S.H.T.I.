// <DisruptionOverlay /> -- the layer switchboard and legend (Task 3).
//
// This is the only place a dispatcher changes what the map is showing, which
// is why the legend lives here rather than floating separately: a switch and
// the thing it turns on should be readable in one glance.
//
// The risk overlay is off by default and fetched lazily (see
// useDispatcherFeeds). Scoring is bounded server-side, but the response can
// still be thousands of segments, and a dispatcher who never opens the overlay
// should not pay for it on every page load.
import React from 'react';
import { useCommandStore } from '../store/commandStore';
import { shallow } from '../store/createStore';

function Toggle({ label, checked, onChange, swatch, hint, count }) {
  return (
    <label
      // 44px minimum row height: these are toggled mid-incident, sometimes on
      // a control-room touch panel.
      className="flex min-h-[var(--ctl-min-h)] cursor-pointer items-center gap-3 px-3 py-2
                 transition-colors hover:bg-inset/60"
      title={hint}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        // The tick is drawn by the class below, not by the browser: an
        // appearance-none box that only changes fill colour reads as "two
        // shades of grey" rather than as on/off at a glance.
        className="focus-ring toggle-box h-[18px] w-[18px] shrink-0 cursor-pointer"
      />
      {/* Colour is never the only carrier here -- the checkbox state and the
          label both say the same thing, so the swatch is decorative. */}
      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 ${swatch}`} />
      <span className="min-w-0 flex-1 font-mono text-[11px] text-dim">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">{count}</span>
      )}
    </label>
  );
}

export default function DisruptionOverlay() {
  const ui = useCommandStore(
    (s) => ({
      showTrucks: s.ui.showTrucks,
      showTrails: s.ui.showTrails,
      showRoutes: s.ui.showRoutes,
      showHazards: s.ui.showHazards,
      showRisk: s.ui.showRisk,
    }),
    shallow,
  );
  const toggleOverlay = useCommandStore((s) => s.toggleOverlay);
  const setRisk = useCommandStore((s) => s.setRisk);
  const risk = useCommandStore(
    (s) => ({
      count: s.risk.features.length,
      loading: s.risk.loading,
      error: s.risk.error,
      threshold: s.risk.threshold,
    }),
    shallow,
  );
  const hazardCount = useCommandStore((s) => s.hazards.length);
  const truckCount = useCommandStore((s) => Object.keys(s.trucks).length);

  return (
    <div className="flex flex-col">
      <header className="border-b border-edge px-3 py-2.5">
        <h2 className="font-display text-[13px] font-black uppercase leading-none
                       tracking-crush text-phosphor">
          Disruption Control
        </h2>
      </header>

      <div className="divide-y divide-edge/60">
        <Toggle
          label="Fleet"
          checked={ui.showTrucks}
          onChange={() => toggleOverlay('showTrucks')}
          swatch="bg-signal"
          count={truckCount}
          hint="Live truck markers — cyan on a GNSS fix, amber while dead reckoning"
        />
        <Toggle
          label="Tracks & dark zone"
          checked={ui.showTrails}
          onChange={() => toggleOverlay('showTrails')}
          swatch="bg-warn"
          hint="Travelled path. Dashed where the position was dead-reckoned or burst-synced."
        />
        <Toggle
          label="Planned routes"
          checked={ui.showRoutes}
          onChange={() => toggleOverlay('showRoutes')}
          swatch="bg-route"
          hint="Active route geometry pushed by the backend or planned here"
        />
        <Toggle
          label="Verified hazards"
          checked={ui.showHazards}
          onChange={() => toggleOverlay('showHazards')}
          swatch="bg-danger"
          count={hazardCount}
          hint="Incidents a dispatcher approved. These block routing."
        />
        <Toggle
          label="Predictive risk"
          checked={ui.showRisk}
          onChange={() => toggleOverlay('showRisk')}
          swatch="bg-hot"
          count={ui.showRisk ? risk.count : undefined}
          hint="XGBoost hazard probability over Open-Meteo rainfall, per road segment"
        />
      </div>

      {ui.showRisk && (
        <div className="border-t border-edge px-3 py-2.5">
          <label className="block">
            <span className="flex items-baseline justify-between">
              <span className="meta">Risk threshold</span>
              <span className="font-mono text-[11px] tabular-nums text-phosphor">
                {(risk.threshold * 100).toFixed(0)}%
              </span>
            </span>
            <input
              type="range"
              min="0.5" max="0.99" step="0.01"
              value={risk.threshold}
              // Committed on release, not on every drag frame: each change
              // refetches from the backend, and firing that on mousemove would
              // issue dozens of requests to land on one number.
              onChange={(event) => setRisk({ threshold: Number(event.target.value) })}
              className="focus-ring mt-1.5 h-1 w-full cursor-pointer accent-[rgb(230,25,25)]"
              aria-label="Minimum risk score to display"
            />
          </label>

          <p aria-live="polite" className="mt-2 font-mono text-[10px] leading-relaxed text-muted">
            {risk.loading
              ? 'Scoring segments…'
              : risk.error
                ? <span className="text-danger-text">{risk.error}</span>
                : risk.count === 0
                  ? 'No segment scores at or above this threshold.'
                  : `${risk.count} segment(s) at or above ${(risk.threshold * 100).toFixed(0)}%.`}
          </p>
        </div>
      )}

      {/* Legend. Deliberately spells out what dashed MEANS, because that is
          the single most important distinction on this map and a colour swatch
          cannot carry it. */}
      <div className="border-t border-edge px-3 py-2.5">
        <p className="meta">Reading the map</p>
        <ul className="mt-2 space-y-1.5">
          <li className="flex items-center gap-2">
            <span aria-hidden className="h-[2px] w-6 shrink-0 bg-signal" />
            <span className="font-mono text-[10px] text-muted">Solid — GNSS fix</span>
          </li>
          <li className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-[2px] w-6 shrink-0"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(90deg, rgb(var(--status-deadrec)) 0 5px, transparent 5px 9px)',
              }}
            />
            <span className="font-mono text-[10px] text-muted">Dashed — dead reckoned</span>
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-none bg-warn/25 ring-1 ring-warn/60" />
            <span className="font-mono text-[10px] text-muted">Halo — position uncertainty</span>
          </li>
          <li className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-[2px] w-6 shrink-0"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(90deg, rgb(var(--accent-alert-text)) 0 3px, transparent 3px 6px)',
              }}
            />
            <span className="font-mono text-[10px] text-muted">Leader — report point to road</span>
          </li>
        </ul>

        {/* The question this answers gets asked every time someone new looks
            at the map, so it is written down rather than explained twice. */}
        <p className="mt-2.5 border-l-2 border-edge-active pl-2 font-mono text-[10px]
                      leading-relaxed text-muted">
          A hazard pin sits where the driver stood when they reported it, not on
          the carriageway. The road that closed is named on the pin as
          <span className="text-danger-text"> EDGE n</span>, and the dashed
          leader points to it.
        </p>
      </div>
    </div>
  );
}
