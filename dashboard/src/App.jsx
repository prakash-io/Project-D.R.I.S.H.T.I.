// The console shell: navigation rail, routes, and every piece of shared state.
//
// All the data hooks live HERE rather than in the pages that read them, and
// that placement is the whole reason the multi-page console is safe to build.
// useTelemetry opens the Socket.IO connection and drives an animation frame
// loop; if it were mounted inside the map page, every navigation would close
// the socket, drop the packets that arrived during the transition, and reset
// the interpolation state on every truck. A dispatcher who checks the alerts
// page for ten seconds must come back to a map that never stopped moving.
//
// The cost of this shape is prop drilling into the pages, which is preferred
// here to a context: there are three consumers and one owner, and a context
// would hide exactly which page depends on which feed.
import React, { useCallback, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import NavBar from './components/NavBar';
import ErrorBoundary from './components/ErrorBoundary';
import CommandCenter from './pages/CommandCenter';
import WeatherAlerts from './pages/WeatherAlerts';
import Analytics from './pages/Analytics';
import { useTelemetry } from './hooks/useTelemetry';
import { useIncidents } from './hooks/useIncidents';
import { useRiskSegments } from './hooks/useRiskSegments';
import { useCorridors } from './hooks/useCorridors';
import { useDemoRoute } from './hooks/useDemoRoute';
import { useHazardAlerts } from './hooks/useHazardAlerts';

const RISK_THRESHOLD = 0.85;

export default function App() {
  const location = useLocation();

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
  const { corridors, loading: corridorLoading } = useCorridors();
  const demo = useDemoRoute();

  // Fetched when the overlay is on OR the analytics page is open, so the two
  // consumers share one request instead of each holding their own copy of a
  // set that can run to thousands of segments.
  const onAnalytics = location.pathname.startsWith('/analytics');
  const { features, loading } = useRiskSegments({
    enabled: showRisk || onAnalytics,
    threshold: RISK_THRESHOLD,
  });

  // Deliberately NOT gated on the alerts route. The badge in the rail is the
  // point -- a dispatcher watching the map has to learn that a corridor went
  // over threshold without having to go and look. The sweep costs roughly
  // ten requests every five minutes, which is well inside what the model
  // service absorbs, and the hook keeps its own in-flight guard.
  const hazard = useHazardAlerts({ corridors, threshold: RISK_THRESHOLD });

  return (
    // `grain` lays one global noise field over every compartment (section 7).
    <div className="grain flex h-full bg-base">
      <NavBar
        connected={connected}
        alertCount={hazard.alerts.length}
        unitCount={trucks.length}
        segmentCount={showRisk ? features.length : 0}
        corridorCount={showCorridors ? corridors.length : 0}
        queueCount={incidents.length}
      />

      {/* One boundary per page, inside the rail rather than around it. A page
          that throws must not take the navigation with it -- otherwise the
          dispatcher has no way back to a page that still works. */}
      <ErrorBoundary label="Page" key={location.pathname}>
        <Routes>
          <Route
            path="/"
            element={(
              <CommandCenter
                trucks={trucks}
                connected={connected}
                packets={packets}
                incidents={incidents}
                approve={approve}
                reject={reject}
                busyId={busyId}
                incidentError={error}
                features={features}
                riskLoading={loading}
                threshold={RISK_THRESHOLD}
                corridors={corridors}
                corridorLoading={corridorLoading}
                demo={demo}
                showTrucks={showTrucks}
                setShowTrucks={setShowTrucks}
                showRisk={showRisk}
                setShowRisk={setShowRisk}
                showCorridors={showCorridors}
                setShowCorridors={setShowCorridors}
                selectedTruck={selectedTruck}
                setSelectedTruck={setSelectedTruck}
              />
            )}
          />
          <Route
            path="/weather"
            element={(
              <WeatherAlerts
                alerts={hazard.alerts}
                loading={hazard.loading}
                error={hazard.error}
                degraded={hazard.degraded}
                checkedAt={hazard.checkedAt}
                refresh={hazard.refresh}
                corridors={corridors}
                threshold={RISK_THRESHOLD}
              />
            )}
          />
          <Route
            path="/analytics"
            element={(
              <Analytics
                features={features}
                riskLoading={loading}
                threshold={RISK_THRESHOLD}
                trucks={trucks}
                corridors={corridors}
              />
            )}
          />
          {/* A wrong URL lands on the map rather than a 404 page. This console
              has one job, and a dead end in front of a dispatcher during an
              incident is worse than a silent redirect. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </div>
  );
}
