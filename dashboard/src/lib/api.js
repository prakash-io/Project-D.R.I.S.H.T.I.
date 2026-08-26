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
