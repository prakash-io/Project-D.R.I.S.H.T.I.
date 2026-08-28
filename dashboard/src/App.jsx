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
import React, { useCallback, useMemo, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import NavBar from './components/NavBar';
import ErrorBoundary from './components/ErrorBoundary';
import CommandCenter from './pages/CommandCenter';
import WeatherAlerts from './pages/WeatherAlerts';
import Analytics from './pages/Analytics';
import TruckAnalytics from './pages/TruckAnalytics';
import { useTelemetry } from './hooks/useTelemetry';
import { useIncidents } from './hooks/useIncidents';
import { useRiskSegments } from './hooks/useRiskSegments';
import { useCorridors } from './hooks/useCorridors';
import { useFleetRoutes } from './hooks/useFleetRoutes';
import { useDemoRoute } from './hooks/useDemoRoute';
import { useHazardAlerts } from './hooks/useHazardAlerts';
import { useFleetRoster } from './hooks/useFleetRoster';
import { assignFleetColors } from './lib/truckColors';

const RISK_THRESHOLD = 0.85;

export default function App() {
  const location = useLocation();

  const [showTrucks, setShowTrucks] = useState(true);
  const [showRisk, setShowRisk] = useState(false);
  // On by default: with no truck moving, the corridors are the only thing
  // that tells a dispatcher opening the console what this platform routes.
  const [showCorridors, setShowCorridors] = useState(true);
  // On by default, and this is the more important of the two route layers: a
  // dispatcher opening the console needs to see where the fleet is GOING, not
  // only where it is. The map used to answer only the second question.
  const [showFleetRoutes, setShowFleetRoutes] = useState(true);
  const [incidentPing, setIncidentPing] = useState(null);
  const [selectedTruck, setSelectedTruck] = useState(null);

  const onIncident = useCallback((payload) => setIncidentPing(payload), []);

  // Declared BEFORE useTelemetry: the socket effect subscribes this hook's
  // three handlers, and it runs once on mount, so they have to exist by then.
  // All three are useCallback([]) over refs for the same reason -- a handler
  // whose identity changed would not be re-bound anyway, since that effect
  // deliberately does not depend on them.
  const fleetRoutes = useFleetRoutes();

  const { trucks, connected, packets } = useTelemetry({
    onIncident,
    onTripRoute: fleetRoutes.onTripRoute,
    onRouteUpdated: fleetRoutes.onRouteUpdated,
    onRerouteAck: fleetRoutes.onRerouteAck,
    // The map's 3D models take their heading from the road under them, which
    // means the render loop needs the routes. Passed as the ref rather than
    // the array so the socket is never rebuilt when a truck is rerouted.
    routesRef: fleetRoutes.byTruck,
  });
  const { incidents, approve, reject, busyId, error } = useIncidents(incidentPing);
  const { corridors, loading: corridorLoading } = useCorridors();
  const demo = useDemoRoute();

  // A dispatcher approving a hazard reroutes trucks. Re-fetching the fleet's
  // routes afterwards is belt-and-braces over the `route_updated` events that
  // already arrive: a socket that reconnected mid-approval would otherwise
  // leave the board drawing roads nobody is on any more.
  //
  // Bound to `refresh` and not to the hook's return object -- that object is a
  // fresh literal every render, so closing over it would give this callback a
  // new identity on every frame of the telemetry loop and re-render the
  // incident panel sixty times a second.
  const refreshRoutes = fleetRoutes.refresh;
  const approveAndRefresh = useCallback(async (id) => {
    const result = await approve(id);
    refreshRoutes();
    return result;
  }, [approve, refreshRoutes]);

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

  // The roster lives here, not on the analytics page, because the COLOUR
  // ASSIGNMENT below has to see every truck. Resolved against the live list
  // alone, the map would assign colours over the two or three vehicles that
  // happen to be emitting, and a fourth coming online could take a hue that
  // was already on screen -- so two trucks would briefly be one colour, which
  // is the exact failure the assignment exists to prevent.
  const { fleet, loading: fleetLoading, error: fleetError } = useFleetRoster(trucks);

  // One assignment for the whole console, recomputed only when the SET of
  // trucks changes. Everything that draws a truck -- the deck.gl model, the 2D
  // dot, the fleet key, the selector, the fleet table, the deep-dive header --
  // reads the result through truckRgb/truckHex, so they cannot disagree.
  useMemo(() => assignFleetColors(fleet.map((t) => t.id)), [fleet]);

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
                approve={approveAndRefresh}
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
                fleetRoutes={fleetRoutes.routes}
                fleetRouteLoading={fleetRoutes.loading}
                showFleetRoutes={showFleetRoutes}
                setShowFleetRoutes={setShowFleetRoutes}
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
                fleet={fleet}
                fleetLoading={fleetLoading}
                fleetError={fleetError}
              />
            )}
          />
          {/* The deep-dive, reached by clicking a unit in the selector on
              /analytics. Declared AFTER the bare /analytics route so the two
              cannot race for the same path, and it takes `trucks` from the
              same socket the map does -- opening a truck's page must not open
              a second connection, which is the whole reason the hooks live up
              here. */}
          <Route
            path="/analytics/:truckId"
            element={<TruckAnalytics trucks={trucks} />}
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
