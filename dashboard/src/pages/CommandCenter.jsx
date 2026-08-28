// The Live Map Command Center — the index route.
//
// This is the page verify.mjs drives, and the reason the router's index route
// is this one and not a landing page. Every string that script matches
// (/Trucks\s*\d+/, /\d+ packets/, /Corridors\s*\d+/, /Disruption Overlay\s*\d+/,
// /\d+ awaiting approval/) lives in ControlBar and IncidentPanel below, and
// the assertions run against document.body.innerText at '/'. Moving either
// component behind a route that is not the index would break the console's
// only end-to-end verification without breaking the console -- which is the
// worst way for it to break.
//
// State lives in App, not here. The telemetry socket must survive a route
// change: rebuilding it on every navigation would drop packets and reset the
// interpolation, and a dispatcher who checks the weather page for ten seconds
// should not come back to an empty map.
import React from 'react';
import MapView from '../components/MapView';
import IncidentPanel from '../components/IncidentPanel';
import ControlBar from '../components/ControlBar';
import DemoSidebar from '../components/DemoSidebar';
import ErrorBoundary from '../components/ErrorBoundary';
import FleetLegend from '../components/FleetLegend';
import { truckHex } from '../lib/truckColors';

export default function CommandCenter({
  trucks, connected, packets,
  incidents, approve, reject, busyId, incidentError,
  features, riskLoading, threshold,
  corridors, corridorLoading,
  demo,
  showTrucks, setShowTrucks,
  showRisk, setShowRisk,
  showCorridors, setShowCorridors,
  selectedTruck, setSelectedTruck,
}) {
  const dr = selectedTruck?.source === 'ekf';

  return (
    <div className="flex min-h-0 flex-1">
      <DemoSidebar
        corridors={corridors}
        loading={corridorLoading}
        route={demo.route}
        pendingId={demo.pendingId}
        error={demo.error}
        onSelect={demo.select}
        onClear={demo.clear}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ControlBar
          connected={connected}
          packets={packets}
          truckCount={trucks.length}
          showTrucks={showTrucks}
          setShowTrucks={setShowTrucks}
          showRisk={showRisk}
          setShowRisk={setShowRisk}
          riskCount={features.length}
          riskLoading={riskLoading}
          threshold={threshold}
          showCorridors={showCorridors}
          setShowCorridors={setShowCorridors}
          corridorCount={corridors.length}
          corridorLoading={corridorLoading}
        />

        <div className="flex min-h-0 flex-1">
          <main className="relative flex-1">
            {/* The map is the one compartment whose failure is worth an
                explicit card rather than a blank: a dispatcher staring at
                empty space cannot tell a crashed layer from an empty region.
                The 3D truck layer loads an asset at runtime, which is a new
                way for this subtree to throw that the flat layers never had. */}
            <ErrorBoundary label="Map">
              <MapView
                trucks={trucks}
                riskFeatures={features}
                showRisk={showRisk}
                showTrucks={showTrucks}
                onTruckClick={setSelectedTruck}
                corridors={corridors}
                showCorridors={showCorridors}
                activeRoute={demo.route}
              />
            </ErrorBoundary>

            {/* The key to the per-truck colours the layers now draw. Only
                mounted when the truck layer is on -- a legend for symbols
                that are hidden explains nothing. */}
            {showTrucks && (
              <FleetLegend
                trucks={trucks}
                selectedId={selectedTruck?.truck_id}
                onSelect={setSelectedTruck}
              />
            )}

            {selectedTruck && (
              <div className="absolute bottom-4 left-4 w-[248px] border border-edge
                              bg-panel/95 backdrop-blur">
                {/* The source band is the headline, not a footnote: whether a
                    position is a fix or an estimate is the whole product. */}
                <div className={`flex items-center justify-between px-3 py-1.5
                                 ${dr ? 'bg-warn/15' : 'bg-live/15'}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    {/* This truck's own colour, from the same function the
                        map layer uses. The card is opened by clicking a
                        marker, so it has to agree with the thing clicked. */}
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: truckHex(selectedTruck.truck_id) }}
                    />
                    <span className={`font-mono text-[10px] uppercase tracking-term
                                      ${dr ? 'text-warn' : 'text-live'}`}>
                      {dr ? 'Dead Reckoning' : 'GNSS Fix'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedTruck(null)}
                    aria-label="Close"
                    className="focus-ring font-mono text-[11px] text-muted
                               transition-colors hover:text-phosphor"
                  >
                    ✕
                  </button>
                </div>

                <dl className="divide-y divide-edge/60 border-t border-edge">
                  <div className="flex items-center justify-between px-3 py-1.5">
                    <dt className="meta">Unit</dt>
                    <dd className="font-mono text-[11px] text-phosphor">
                      {selectedTruck.truck_id.slice(0, 8)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between px-3 py-1.5">
                    <dt className="meta">Speed</dt>
                    <dd className="font-mono text-[11px] text-dim">
                      {(selectedTruck.speed ?? 0).toFixed(1)} m/s
                    </dd>
                  </div>
                  {Number.isFinite(selectedTruck.heading) && (
                    <div className="flex items-center justify-between px-3 py-1.5">
                      <dt className="meta">Heading</dt>
                      <dd className="font-mono text-[11px] text-dim">
                        {selectedTruck.heading.toFixed(0)}°
                      </dd>
                    </div>
                  )}
                  {selectedTruck.covariance_m2 ? (
                    <div className="flex items-center justify-between px-3 py-1.5">
                      <dt className="meta">Uncertainty</dt>
                      <dd className="font-mono text-[11px] text-warn">
                        ±{Math.sqrt(selectedTruck.covariance_m2).toFixed(0)} m
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            )}

            {trucks.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="border border-edge bg-panel/90 px-5 py-3 text-center">
                  <div aria-hidden className="font-mono text-[18px] text-edge-active">+</div>
                  <p className="meta mt-2">
                    {connected
                      ? 'Connected — waiting for telemetry'
                      : 'No connection to the telemetry backend'}
                  </p>
                </div>
              </div>
            )}
          </main>

          <IncidentPanel
            incidents={incidents}
            approve={approve}
            reject={reject}
            busyId={busyId}
            error={incidentError}
          />
        </div>
      </div>
    </div>
  );
}
