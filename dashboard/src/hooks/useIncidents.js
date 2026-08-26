// The dispatcher review queue (WEB-05).
import { useCallback, useEffect, useState } from 'react';
import { getIncidents, approveIncident, rejectIncident } from '../lib/api';

const AWAITING = 'pending_dispatcher_approval';

export function useIncidents(socketIncident) {
  const [incidents, setIncidents] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const body = await getIncidents(AWAITING);
      setIncidents(body.incidents ?? []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // A socket event only says "something changed"; the list is re-fetched
  // rather than patched locally, so the panel can never disagree with the
  // database about what is still awaiting a decision.
  useEffect(() => {
    if (socketIncident) refresh();
  }, [socketIncident, refresh]);

  const approve = useCallback(async (id) => {
    setBusyId(id);
    try {
      const result = await approveIncident(id);
      // Removed immediately: the row is gone from this queue the moment the
      // backend confirms, so a second click cannot double-approve.
      setIncidents((list) => list.filter((i) => i.id !== id));
      setError(null);
      return result;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusyId(null);
    }
  }, []);

  const reject = useCallback(async (id) => {
    setBusyId(id);
    try {
      await rejectIncident(id);
      setIncidents((list) => list.filter((i) => i.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }, []);

  return { incidents, approve, reject, refresh, busyId, error };
}
