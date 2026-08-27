// Backend client. One place that knows the base URL.
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

async function json(path, options) {
  const response = await fetch(`${API_URL}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new Error(body.error ?? body.detail ?? `HTTP ${response.status}`);
  }
  return body;
}

export const getHealth = () => json('/health');
export const getTrucks = () => json('/trucks');

export const getIncidents = (status) =>
  json(`/incidents${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const approveIncident = (id, approvedBy = 'dispatcher') =>
  json(`/incidents/${id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved_by: approvedBy }),
  });

export const rejectIncident = (id, approvedBy = 'dispatcher') =>
  json(`/incidents/${id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved_by: approvedBy }),
  });

export const getRiskSegments = (min = 0.85, limit = 2000) =>
  json(`/risk/segments?min=${min}&limit=${limit}`);

export const incidentPhotoUrl = (id) => `${API_URL}/incidents/${id}/photo`;

// The demonstration corridors, planned by pgr_astar over `routable_edges`.
//
// Geometry is opt-in on the API because the raw paths are 1k-9k points each
// and the picker only needs the endpoints. The dispatcher view does want the
// lines, so it asks for them -- simplified, since 40 m of Douglas-Peucker
// tolerance is well under a line width at the zooms this overlay is read at
// and cuts the payload by roughly an order of magnitude (4411 -> 309 points
// on Guwahati-Shillong).
export const getCorridors = () =>
  json('/routes/corridors?geometry=1&simplify_m=40');
