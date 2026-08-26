// The Disruption Overlay's data (WEB-04).
import { useCallback, useEffect, useState } from 'react';
import { getRiskSegments } from '../lib/api';

export function useRiskSegments({ enabled, threshold = 0.85 }) {
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await getRiskSegments(threshold);
      setFeatures(body.features ?? []);
      setError(null);
    } catch (e) {
      setError(e.message);
      setFeatures([]);
    } finally {
      setLoading(false);
    }
  }, [threshold]);

  // Fetched only when the overlay is switched on. The scored set can be
  // thousands of segments, and a dispatcher who never opens the overlay
  // should not pay for it on every page load.
  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  return { features, loading, error, reload: load };
}
