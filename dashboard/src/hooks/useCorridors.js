// The planned corridors overlay.
//
// Unlike the risk segments this is fetched once on mount rather than on
// toggle: the corridor set is fixed at ten rows, it never changes while the
// console is open, and the toggle badge has to show the count before anyone
// has switched the layer on.
import { useEffect, useState } from 'react';
import { getCorridors } from '../lib/api';

export function useCorridors() {
  const [corridors, setCorridors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await getCorridors();
        // A corridor whose planning failed is still stored as a definition
        // row with a null route, so it can be reseeded without losing its
        // name. Those rows have nothing to draw.
        const drawable = (body.corridors ?? [])
          .filter((c) => (c.geometry?.coordinates?.length ?? 0) >= 2);
        if (!cancelled) { setCorridors(drawable); setError(null); }
      } catch (e) {
        if (!cancelled) { setError(e.message); setCorridors([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { corridors, loading, error };
}
