// Analytics — network risk, fleet composition, and the way into one truck.
//
// The 3D chart here is Three.js. That is a deliberate boundary: three.js draws
// the console's own instruments (this chart, the navigation mark) and never
// anything geographic. The map is deck.gl over MapLibre and stays that way --
// one renderer owns the projection, the picking, and the CSS inversion that
// index.css scopes so carefully to the basemap canvas alone.
//
// -------------------------------------------------------------- the layout
//
// The rightmost column is the ACTIONABLE one: pick a truck, or read the
// segments that are about to become somebody's problem. The left column is
// standing context -- how big is the fleet, and what should every number on
// this page be read against. That is why the risk panel moved right and the
// truck selector sits above it: a dispatcher arriving here is choosing what to
// look at next, and both of those columns' worth of choosing now live in one
// place instead of on opposite sides of the screen.
import React, { useMemo } from 'react';
import RiskBars3D from '../components/RiskBars3D';
import ErrorBoundary from '../components/ErrorBoundary';
import TruckSelector from '../components/TruckSelector';
import FleetTable from '../components/FleetTable';

function Panel({ title, hint, children }) {
  return (
    <section className="border border-edge bg-panel/60">
      <header className="border-b border-edge px-4 py-3">
        <h2 className="font-display text-[13px] tracking-crush text-phosphor">
          {title}
        </h2>
        {hint && (
          <p className="meta mt-1 normal-case tracking-normal">{hint}</p>
        )}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default function Analytics({
  features, riskLoading, threshold, trucks, corridors,
  fleet, fleetLoading, fleetError,
}) {
  // The chart plots the worst segments, named by road. Unnamed edges are
  // labelled by id rather than dropped: an unnamed track carrying a 0.97 is
  // exactly the segment a dispatcher needs to see, and silently omitting it
  // because the OSM extract had no name would be the wrong kind of tidy.
  const bars = useMemo(() => (
    [...features]
      .sort((a, b) => b.properties.risk_score - a.properties.risk_score)
      // Ten rather than fourteen. The panel is in a narrower column now, and
      // a 3D bar chart that has to be dragged to separate two bars has stopped
      // ranking anything.
      .slice(0, 10)
      .map((f) => ({
        // The edge id, not the name, is the identity. Road names repeat
        // heavily in the extract -- a single highway is hundreds of edges all
        // called "NH 27" -- so keying on the name collided 185 times in one
        // render and would also have made hovering one bar highlight every
        // other segment of the same road.
        id: f.properties.id,
        label: f.properties.name ?? `edge ${f.properties.id}`,
        value: f.properties.risk_score,
        score: f.properties.risk_score,
      }))
  ), [features]);

  const deadReckoned = trucks.filter((t) => t.source === 'ekf').length;
  const gnss = trucks.length - deadReckoned;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="border-b border-edge px-5 py-4">
        <h1 className="font-display text-[18px] tracking-crush text-phosphor">
          ANALYTICS
        </h1>
        <p className="meta mt-1.5 normal-case tracking-normal">
          Scored road segments and live fleet composition.
        </p>
      </header>

      <div className="grid gap-4 p-5 xl:grid-cols-12">
        {/* ------------------------------------------- left: standing context */}
        <div className="flex flex-col gap-4 xl:col-span-7">
          <div className="grid gap-3 sm:grid-cols-4">
            <Tile label="Units reporting" value={trucks.length} />
            {/* The same split the map encodes. A console that shows a fleet
                count without this hides the one distinction the platform
                exists to make. */}
            <Tile label="On GNSS fix" value={gnss} tone="text-live" />
            <Tile label="Dead reckoning" value={deadReckoned} tone="text-warn" />
            <Tile label="Planned corridors" value={corridors.length} />
          </div>

          <FleetTable fleet={fleet} loading={fleetLoading} error={fleetError} />

          <Panel
            title="MODEL PROVENANCE"
            hint="Read every figure on this page against this"
          >
            <ul className="space-y-2.5">
              <Note>
                Hazard labels are <strong className="text-phosphor">synthetic</strong>.
                This is a demonstrator, and the probabilities are not
                forecasting skill.
              </Note>
              <Note>
                Rainfall is located by <code className="text-phosphor">hourly.time</code>,
                never sliced from index 0 — the series starts at 00:00 UTC.
              </Note>
              <Note>
                Routing is bidirectional: the extract carries no
                <code className="text-phosphor"> oneway</code> column.
              </Note>
              <Note>
                Each truck's colour is derived from its id, so the swatch in the
                selector is the colour the map draws that vehicle in.
              </Note>
            </ul>
          </Panel>
        </div>

        {/* -------------------------------------- right: what to look at next */}
        <div className="flex flex-col gap-4 xl:col-span-5">
          <TruckSelector
            fleet={fleet}
            loading={fleetLoading}
            error={fleetError}
          />

          <Panel
            title="HIGHEST-RISK SEGMENTS"
            hint={riskLoading
              ? 'Scoring…'
              : `Top ${bars.length} of ${features.length} segments at or above `
                + `${(threshold * 100).toFixed(0)}%. Drag to inspect.`}
          >
            {/* A decorative-but-informative canvas. If WebGL is unavailable
                the boundary keeps the rest of the page -- including the exact
                figures below -- intact. */}
            <ErrorBoundary
              label="3D chart"
              fallback={
                <div className="grid h-[220px] place-items-center border border-edge">
                  <p className="meta">3D chart unavailable — values listed below</p>
                </div>
              }
            >
              <RiskBars3D items={bars} threshold={threshold} height={220} />
            </ErrorBoundary>

            {/* The chart ranks; this states. Never only the canvas: a reader
                using a screen reader, or one who simply needs the number,
                must not have to interpret a 3D bar to get it. */}
            <ol className="mt-4 divide-y divide-edge/60 border-t border-edge">
              {bars.map((bar, i) => (
                <li key={bar.label + i}
                  className="flex items-baseline justify-between gap-4 py-1.5">
                  <span className="flex min-w-0 items-baseline gap-3">
                    <span className="meta w-5 shrink-0">{i + 1}</span>
                    <span className="truncate font-mono text-[11px] text-dim">
                      {bar.label}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-danger-text">
                    {(bar.value * 100).toFixed(1)}%
                  </span>
                </li>
              ))}
              {bars.length === 0 && (
                <li className="py-3">
                  <p className="meta">
                    {riskLoading ? 'Scoring…' : 'No segment currently over threshold'}
                  </p>
                </li>
              )}
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/// A single figure. Replaces the stacked <dl> the fleet panel used, because
/// four numbers in a row is a scan and four numbers in a column is a read.
function Tile({ label, value, tone = 'text-phosphor' }) {
  return (
    <div className="border border-edge bg-panel/60 p-3">
      <p className="meta truncate">{label}</p>
      <p className={`mt-1.5 font-mono text-[22px] tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function Note({ children }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-1 h-1 w-1 shrink-0 bg-edge-active" />
      <span className="font-mono text-[11px] leading-relaxed text-muted">
        {children}
      </span>
    </li>
  );
}
