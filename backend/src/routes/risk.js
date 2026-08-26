// Hazard overlay for the dashboard (WEB-04).
//
// `road_edges.risk_score` exists in the schema but nothing has ever written
// to it. These endpoints fill that gap: one scores segments through the
// FastAPI model, the other serves what has been scored as GeoJSON.
//
// Scoring is on demand and bounded rather than a sweep of all 486,784 edges.
// A dispatcher looks at a corridor, not at the whole region, and 486k model
// calls would take hours to produce a number that is stale by the time it
// lands.
import { Router } from 'express';
import { query } from '../db.js';
import { predictHazard, AiServiceError } from '../services/aiClient.js';
import { config } from '../config.js';

export const riskRouter = Router();

/// Matches the default /risk/segments uses and the AI service's own flag.
const DEFAULT_RISK_THRESHOLD = 0.85;

/**
 * GET /risk/segments?min=0.85&bbox=w,s,e,n
 *
 * Scored segments as GeoJSON, ready for a deck.gl PathLayer. Defaults to the
 * RISK_FLAG_THRESHOLD the AI service and WEB-04 already agree on.
 */
riskRouter.get('/segments', async (req, res, next) => {
  try {
    const min = Number.parseFloat(req.query.min ?? '0.85');
    const limit = Math.min(Number.parseInt(req.query.limit ?? '2000', 10), 10000);
    const bbox = parseBbox(req.query.bbox);

    const { rows } = await query(
      `SELECT id, name, highway, risk_score, risk_updated,
              ST_AsGeoJSON(geom) AS geojson
       FROM road_edges
       WHERE risk_score >= $1
         AND ($2::float8 IS NULL OR geom && ST_MakeEnvelope($2,$3,$4,$5,4326))
       ORDER BY risk_score DESC
       LIMIT $6`,
      [min, bbox?.[0] ?? null, bbox?.[1] ?? null, bbox?.[2] ?? null, bbox?.[3] ?? null, limit],
    );

    res.json({
      type: 'FeatureCollection',
      threshold: min,
      features: rows.map((row) => ({
        type: 'Feature',
        geometry: JSON.parse(row.geojson),
        properties: {
          id: Number(row.id),
          name: row.name,
          highway: row.highway,
          risk_score: Number(row.risk_score),
          risk_updated: row.risk_updated,
        },
      })),
    });
  } catch (error) { next(error); }
});

/**
 * POST /risk/refresh  { bbox?, highway?, limit? }
 *
 * Scores segment midpoints through the model and writes risk_score back.
 *
 * Samples the MIDPOINT of each edge rather than every vertex: the hazard
 * model's inputs (elevation, slope, distance to river) vary over hundreds of
 * metres, and the median edge here is 333 m long, so one sample per edge is
 * already at the resolution the features carry.
 */
/**
 * POST /risk/route  { coordinates: [[lng, lat], ...], sample_km?, max_points? }
 *
 * Hazard forecast along one truck's route (workflow section 5), for the
 * driver client's route-warning overlay.
 *
 * The phone does NOT run this model. The eight features it needs come from
 * GeoTIFF terrain sheets and KDTree indices that are hundreds of megabytes,
 * and CLAUDE.md decision 2 makes re-deriving them client-side a correctness
 * risk rather than an optimisation: the training parquet is already
 * RobustScaler output, so a second scaling desyncs serving from training
 * silently. Open-Meteo is likewise queried here, not on the device, because
 * decision 11 requires the rainfall window to be located via `hourly.time`
 * rather than sliced from index 0.
 *
 * Sampled along the polyline rather than per vertex: the model's inputs vary
 * over hundreds of metres, so a vertex-dense geometry would spend dozens of
 * model calls to redraw the same number.
 */
riskRouter.post('/route', async (req, res, next) => {
  try {
    const coordinates = req.body?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 1) {
      return res.status(400).json({ error: 'coordinates must be a non-empty [[lng, lat], ...]' });
    }

    const sampleKm = Math.max(1, Number(req.body?.sample_km ?? 10));
    const maxPoints = Math.min(Number.parseInt(req.body?.max_points ?? '12', 10), 40);
    const points = samplePolyline(coordinates, sampleKm, maxPoints);

    const hazards = [];
    let degraded = null;
    // The model reports the threshold it was flagged against; fall back to the
    // 0.85 that /risk/segments and WEB-04 already agree on. NOT
    // config.riskFlagThreshold -- that key does not exist, and `x >= undefined`
    // is always false, which would have made this condition silently dead.
    let threshold = DEFAULT_RISK_THRESHOLD;

    for (const [lng, lat] of points) {
      try {
        const p = await predictHazard(lat, lng);
        if (Number.isFinite(p.risk_threshold)) threshold = p.risk_threshold;
        // Only the flagged ones travel: an overlay of SAFE_TERRAIN nodes is
        // noise on a screen a driver glances at.
        if (p.high_risk || p.hazard_probability >= threshold) {
          hazards.push({
            lat, lng,
            kind: p.predicted_class,
            probability: p.hazard_probability,
            rainfall_24h_mm: p.features?.rainfall_24h_mm ?? null,
            rainfall_intensity_mmh: p.features?.rainfall_intensity_mmh ?? null,
            weather_source: p.provenance?.weather_source ?? null,
            window_start_utc: p.provenance?.rainfall_window_start_utc ?? null,
          });
        }
      } catch (error) {
        if (error instanceof AiServiceError) {
          // Return what was scored rather than nothing. A partial forecast is
          // still a warning; an empty one reads as "no hazards ahead".
          degraded = error.message;
          break;
        }
        throw error;
      }
    }

    res.json({
      hazards,
      sampled: points.length,
      threshold,
      degraded,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/// Walk the polyline and emit a point every `stepKm`, always including the
/// first and last vertex so the origin and destination are covered.
function samplePolyline(coordinates, stepKm, maxPoints) {
  const out = [coordinates[0]];
  let carried = 0;

  for (let i = 1; i < coordinates.length; i += 1) {
    carried += haversineKm(coordinates[i - 1], coordinates[i]);
    if (carried >= stepKm) {
      out.push(coordinates[i]);
      carried = 0;
    }
  }

  const last = coordinates[coordinates.length - 1];
  if (out[out.length - 1] !== last) out.push(last);

  if (out.length <= maxPoints) return out;
  // Thin evenly rather than truncating: dropping the tail would leave the far
  // half of the route unwarned.
  const stride = out.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => out[Math.floor(i * stride)]);
}

function haversineKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

riskRouter.post('/refresh', async (req, res, next) => {
  try {
    const limit = Math.min(Number.parseInt(req.body?.limit ?? '300', 10), 2000);
    const bbox = parseBbox(req.body?.bbox);
    // Trunk and primary by default: those are the corridors a truck is on,
    // and scoring residential streets burns model calls on roads no convoy
    // will ever use.
    const classes = req.body?.highway ?? ['trunk', 'primary', 'secondary'];

    const { rows } = await query(
      `SELECT id,
              ST_Y(ST_LineInterpolatePoint(geom, 0.5)) AS lat,
              ST_X(ST_LineInterpolatePoint(geom, 0.5)) AS lng
       FROM road_edges
       WHERE highway = ANY($1)
         AND ($2::float8 IS NULL OR geom && ST_MakeEnvelope($2,$3,$4,$5,4326))
       ORDER BY length_m DESC
       LIMIT $6`,
      [classes, bbox?.[0] ?? null, bbox?.[1] ?? null, bbox?.[2] ?? null, bbox?.[3] ?? null, limit],
    );

    let scored = 0;
    let failed = 0;
    let unreachable = null;

    for (const row of rows) {
      try {
        const prediction = await predictHazard(Number(row.lat), Number(row.lng));
        await query(
          `UPDATE road_edges SET risk_score = $2, risk_updated = now() WHERE id = $1`,
          [row.id, prediction.hazard_probability],
        );
        scored += 1;
      } catch (error) {
        failed += 1;
        if (error instanceof AiServiceError) {
          // The service being down is one fact, not N. Record it once and
          // stop, rather than grinding through hundreds of identical timeouts.
          unreachable = error.message;
          break;
        }
      }
    }

    res.json({
      scored,
      failed,
      considered: rows.length,
      threshold: config.blockedEdgeCost ? undefined : undefined,
      ai_error: unreachable,
      note: unreachable
        ? 'stopped early: the AI service became unreachable'
        : 'risk_score written to road_edges',
    });
  } catch (error) { next(error); }
});

function parseBbox(value) {
  if (!value) return null;
  const parts = String(value).split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;   // west, south, east, north
}
