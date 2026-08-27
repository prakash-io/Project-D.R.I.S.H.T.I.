import React, { useCallback, useState } from 'react';
import MapView from './components/MapView';
import IncidentPanel from './components/IncidentPanel';
import ControlBar from './components/ControlBar';
import CommandRail from './components/CommandRail';
import DemoSidebar from './components/DemoSidebar';
import { useTelemetry } from './hooks/useTelemetry';
import { useIncidents } from './hooks/useIncidents';
import { useRiskSegments } from './hooks/useRiskSegments';
import { useCorridors } from './hooks/useCorridors';
import { useDemoRoute } from './hooks/useDemoRoute';

const RISK_THRESHOLD = 0.85;

export default function App() {
  const [showTrucks, setShowTrucks] = useState(true);
  const [showRisk, setShowRisk] = useState(false);
  // On by default: with no truck moving, the corridors are the only thing
  // that tells a dispatcher opening the console what this platform routes.
  const [showCorridors, setShowCorridors] = useState(true);
  const [incidentPing, setIncidentPing] = useState(null);
  const [selectedTruck, setSelectedTruck] = useState(null);

  const onIncident = useCallback((payload) => setIncidentPing(payload), []);
  const { trucks, connected, packets } = useTelemetry({ onIncident });
  const { incidents, approve, reject, busyId, error } = useIncidents(incidentPing);
  const { features, loading } = useRiskSegments({
    enabled: showRisk,
    threshold: RISK_THRESHOLD,
  });
  const { corridors, loading: corridorLoading } = useCorridors();
  const demo = useDemoRoute();

  const dr = selectedTruck?.source === 'ekf';

  return (
    // `grain` lays one global noise field over every compartment (section 7).
    <div className="grain flex h-full bg-base">
      <CommandRail
        connected={connected}
        unitCount={trucks.length}
        segmentCount={showRisk ? features.length : 0}
        corridorCount={showCorridors ? corridors.length : 0}
        queueCount={incidents.length}
      />

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
          riskLoading={loading}
          threshold={RISK_THRESHOLD}
          showCorridors={showCorridors}
          setShowCorridors={setShowCorridors}
          corridorCount={corridors.length}
          corridorLoading={corridorLoading}
        />

        <div className="flex min-h-0 flex-1">
          <main className="relative flex-1">
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

            {selectedTruck && (
              <div className="absolute bottom-4 left-4 w-[248px] border border-edge
                              bg-panel/95 backdrop-blur">
                {/* The source band is the headline, not a footnote: whether a
                    position is a fix or an estimate is the whole product. */}
                <div className={`flex items-center justify-between px-3 py-1.5
                                 ${dr ? 'bg-warn/15' : 'bg-live/15'}`}>
                  <span className={`font-mono text-[10px] uppercase tracking-term
                                    ${dr ? 'text-warn' : 'text-live'}`}>
                    {dr ? 'Dead Reckoning' : 'GNSS Fix'}
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
            error={error}
          />
        </div>
      </div>
    </div>
  );
}
