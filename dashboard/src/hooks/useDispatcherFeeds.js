// The REST half of the dispatcher's picture.
//
// Sockets carry what is happening; these endpoints carry what is already true
// when the screen opens. Without them a dispatcher who reloads mid-shift sees
// an empty map until the next packet, and every road closed before the reload
// silently disappears.
//
// Mount once, next to useCommandSocket.
import { useCallback, useEffect } from 'react';
import { getIncidents, getRiskSegments, getTrucks } from '../lib/api';
import { useCommandStore } from '../store/commandStore';

const AWAITING = 'pending_dispatcher_approval';

export function useDispatcherFeeds() {
  const incidentEpoch = useCommandStore((s) => s.incidentEpoch);
  const showRisk = useCommandStore((s) => s.ui.showRisk);
  const threshold = useCommandStore((s) => s.risk.threshold);

  // --- incidents ----------------------------------------------------------
  const refreshIncidents = useCallback(async () => {
    const store = useCommandStore.getState();
    // Both lists in parallel: they are independent queries and serialising
    // them doubles the time the queue sits empty after a reload.
    const [pending, verified] = await Promise.allSettled([
      getIncidents(AWAITING),
      getIncidents('verified'),
    ]);

    if (pending.status === 'fulfilled') store.setQueue(pending.value.incidents ?? []);
    if (verified.status === 'fulfilled') store.setHazards(verified.value.incidents ?? []);

    if (pending.status === 'rejected' && verified.status === 'rejected') {
      store.pushAlert({
        tone: 'warn',
        title: 'Incident feed unavailable',
        body: pending.reason?.message ?? 'The backend did not answer.',
      });
    }
  }, []);

  // Runs on mount and again on every incident event. See `incidentEpoch` in
  // the store for why the trigger is a counter and not the queue itself.
  useEffect(() => { refreshIncidents(); }, [refreshIncidents, incidentEpoch]);

  // --- first paint of the fleet -------------------------------------------
  // GET /trucks is the last known position of every truck. Seeding from it
  // means a dispatcher opening the screen sees the fleet immediately rather
  // than watching trucks appear one at a time as each reports in -- and a
  // truck parked overnight, which will not emit at all, appears at all.
  useEffect(() => {
    let alive = true;
    getTrucks()
      .then((body) => {
        if (!alive) return;
        const store = useCommandStore.getState();
        for (const truck of body.trucks ?? []) {
          if (!Number.isFinite(Number(truck.lat)) || !Number.isFinite(Number(truck.lng))) continue;
          // live:false -- this is a stored last-known position, not a packet
          // off the wire. See ingestTelemetry: counting these would make the
          // status bar claim telemetry on a dead link.
          store.ingestTelemetry({
            truck_id: truck.id,
            lat: Number(truck.lat),
            lng: Number(truck.lng),
            speed: truck.speed_mps == null ? null : Number(truck.speed_mps),
            source: truck.source,
            timestamp: truck.captured_at,
          }, { live: false });
          // Identity does not arrive on the telemetry socket at all -- the
          // packet carries a UUID and nothing else. Plate, driver and alert
          // language come only from here, so they are merged onto the record
          // rather than being re-fetched per truck later.
          useCommandStore.setState((s) => ({
            trucks: {
              ...s.trucks,
              [truck.id]: {
                ...s.trucks[truck.id],
                plate: truck.plate ?? null,
                driver_name: truck.driver_name ?? null,
                alert_lang: truck.alert_lang ?? 'en',
              },
            },
          }));
        }
      })
      .catch((error) => {
        if (!alive) return;
        useCommandStore.getState().pushAlert({
          tone: 'warn',
          title: 'Fleet roster unavailable',
          body: error.message,
        });
      });
    return () => { alive = false; };
  }, []);

  // --- predictive risk ----------------------------------------------------
  // Fetched only when the Disruption Overlay is switched on. The scored set
  // can be thousands of segments, and a dispatcher who never opens the overlay
  // should not pay for it on every page load.
  useEffect(() => {
    if (!showRisk) return undefined;
    let alive = true;
    const store = useCommandStore.getState();
    store.setRisk({ loading: true, error: null });

    getRiskSegments(threshold)
      .then((body) => {
        if (!alive) return;
        useCommandStore.getState().setRisk({
          features: body.features ?? [],
          loading: false,
          error: null,
          fetchedAt: Date.now(),
        });
      })
      .catch((error) => {
        if (!alive) return;
        useCommandStore.getState().setRisk({
          features: [], loading: false, error: error.message,
        });
      });
    return () => { alive = false; };
  }, [showRisk, threshold]);

  return { refreshIncidents };
}
