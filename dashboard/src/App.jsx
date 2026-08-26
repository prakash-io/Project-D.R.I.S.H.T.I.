import React, { useCallback, useState } from 'react';
import MapView from './components/MapView';
import IncidentPanel from './components/IncidentPanel';
import ControlBar from './components/ControlBar';
import { useTelemetry } from './hooks/useTelemetry';
import { useIncidents } from './hooks/useIncidents';
import { useRiskSegments } from './hooks/useRiskSegments';

const RISK_THRESHOLD = 0.85;

export default function App() {
  const [showTrucks, setShowTrucks] = useState(true);
  const [showRisk, setShowRisk] = useState(false);
  const [incidentPing, setIncidentPing] = useState(null);
  const [selectedTruck, setSelectedTruck] = useState(null);

  const onIncident = useCallback((payload) => setIncidentPing(payload), []);
  const { trucks, connected, packets } = useTelemetry({ onIncident });
  const { incidents, approve, reject, busyId, error } = useIncidents(incidentPing);
  const { features, loading } = useRiskSegments({
    enabled: showRisk,
    threshold: RISK_THRESHOLD,
  });

  return (
    <div className="flex h-full flex-col bg-panel">
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
      />

      <div className="flex flex-1 min-h-0">
        <main className="relative flex-1">
          <MapView
            trucks={trucks}
            riskFeatures={features}
            showRisk={showRisk}
            showTrucks={showTrucks}
            onTruckClick={setSelectedTruck}
          />

          {selectedTruck && (
            <div className="absolute bottom-4 left-4 rounded-lg border border-edge
                            bg-panel/95 px-4 py-3 text-xs backdrop-blur">
              <div className="font-mono text-slate-100">
                {selectedTruck.truck_id.slice(0, 8)}
              </div>
              <div className={selectedTruck.source === 'ekf' ? 'text-warn' : 'text-live'}>
                {selectedTruck.source === 'ekf' ? 'DEAD RECKONING' : 'GNSS FIX'}
              </div>
              <div className="text-muted mt-1">
                {(selectedTruck.speed ?? 0).toFixed(1)} m/s
                {selectedTruck.covariance_m2
                  ? ` · ±${Math.sqrt(selectedTruck.covariance_m2).toFixed(0)} m`
                  : ''}
              </div>
              <button type="button" onClick={() => setSelectedTruck(null)}
                      className="mt-2 text-muted hover:text-slate-200">close</button>
            </div>
          )}

          {trucks.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="rounded-md border border-edge bg-panel/90 px-4 py-2 text-xs text-muted">
                {connected
                  ? 'Connected — waiting for telemetry.'
                  : 'No connection to the telemetry backend.'}
              </p>
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
  );
}
