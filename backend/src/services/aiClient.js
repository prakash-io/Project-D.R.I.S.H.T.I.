// Client for the FastAPI hybrid engine (ML-06).
import { request } from 'undici';
import { config } from '../config.js';

export class AiServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AiServiceError';
    this.status = status;
  }
}

/**
 * Classify a driver's incident photo.
 *
 * The response carries `requires_human_review`, which is true for every
 * verified incident while the vision model has no "no incident" class and is
 * out of distribution on ground-level photographs. The caller must honour it:
 * see routes/incidents.js.
 */
export async function verifyIncident(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'image/jpeg' }), filename || 'photo.jpg');

  let response;
  try {
    response = await request(`${config.aiServiceUrl}/verify-incident`, {
      method: 'POST',
      body: form,
      headersTimeout: config.aiTimeoutMs,
      bodyTimeout: config.aiTimeoutMs,
    });
  } catch (error) {
    throw new AiServiceError(`AI service unreachable: ${error.message}`, 503);
  }

  const body = await response.body.json().catch(() => ({}));
  if (response.statusCode >= 400) {
    throw new AiServiceError(body.detail ?? `AI service returned ${response.statusCode}`,
      response.statusCode);
  }
  return body;
}

/** Landslide/flood probability for a coordinate (ML-04, workflow section 5). */
export async function predictHazard(lat, lng, overrides) {
  let response;
  try {
    response = await request(`${config.aiServiceUrl}/predict-hazard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ latitude: lat, longitude: lng, overrides }),
      headersTimeout: config.aiTimeoutMs,
      bodyTimeout: config.aiTimeoutMs,
    });
  } catch (error) {
    throw new AiServiceError(`AI service unreachable: ${error.message}`, 503);
  }
  const body = await response.body.json().catch(() => ({}));
  if (response.statusCode >= 400) {
    throw new AiServiceError(body.detail ?? `AI service returned ${response.statusCode}`,
      response.statusCode);
  }
  return body;
}
