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
