// Basemap tile proxy (WEB-02).
//
// WHY THIS EXISTS: Bhuvan serves its WMTS tiles with NO
// `Access-Control-Allow-Origin` header. MapLibre uploads raster tiles into a
// WebGL texture, which is a CORS-tainted operation, so the browser refuses
// them and every tile fails as `TypeError: Failed to fetch` -- an empty map
// with no HTTP error to explain it. Verified against the live endpoint: the
// tile returns 200 image/png with only `x-content-type-options` beside it.
//
// The mobile client talks to Bhuvan directly and is unaffected: MapLibre
// Native is not a browser and does not enforce CORS. This proxy is a
// browser-only requirement, which is why the dashboard needs it and the
// handset does not.
//
// Being a same-origin hop, it is also the right place to cache. Dispatchers
// pan the same corridor repeatedly and the upstream is a public national
// service we should not hammer.
import { Router } from 'express';

const BHUVAN = 'https://bhuvan-vec1.nrsc.gov.in/bhuvan/gwc/service/wmts/';

// A 1x1 fully transparent PNG. Bhuvan answers 400 -- not an empty image --
// for tiles its cache is missing, which MapLibre reports as a broken source.
// Handing back a transparent tile instead lets the style's background layer
// show through the hole, so a gap in the national cache reads as terrain we
// have no imagery for rather than as a failed map.
const EMPTY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// Bounded in-memory cache. Tiles are immutable for our purposes and small
// (~3-45 KB), so a few hundred of them is a couple of tens of MB and covers
// the corridors a dispatcher actually watches. Deliberately not on disk: this
// is a warm-start convenience, not a durable artefact, and a stale national
// basemap on disk is a support problem nobody would think to look for.
const MAX_ENTRIES = 512;
const cache = new Map();

function remember(key, value) {
  // Map preserves insertion order, so the first key is the oldest: plain FIFO
  // eviction. An LRU would need a touch-on-read reorder for a hit rate that
  // is already dominated by whether the dispatcher is panning or sitting.
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

export const tilesRouter = Router();

/**
 * GET /tiles/bhuvan/:z/:x/:y.png
 *
 * :z/:x/:y are validated as integers in range before they are interpolated
 * into the upstream URL. They arrive from the network and are concatenated
 * into a request this server then makes, so an unchecked value here is an
 * SSRF hole, not just a 404.
 */
tilesRouter.get('/bhuvan/:z/:x/:y.png', async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  const limit = 2 ** z;
  const valid = [z, x, y].every(Number.isInteger)
    && z >= 0 && z <= 21
    && x >= 0 && x < limit
    && y >= 0 && y < limit;
  if (!valid) return res.status(400).json({ error: 'bad tile coordinate' });

  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    res.setHeader('X-Tile-Cache', 'HIT');
    return sendTile(res, hit);
  }

  const url = `${BHUVAN}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0`
    + '&LAYER=india3&STYLE=default&TILEMATRIXSET=EPSG:900913'
    + `&TILEMATRIX=EPSG:900913:${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/png`;

  try {
    // Bounded: a hung national endpoint must not pin a dispatcher's tile
    // request open until the browser gives up on it.
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'drishti-dispatcher/1.0' },
    });

    if (!upstream.ok) {
      // Cached as a hole so a missing tile is asked for once, not on every
      // pan across it.
      remember(key, EMPTY_PNG);
      res.setHeader('X-Tile-Cache', 'MISS-EMPTY');
      return sendTile(res, EMPTY_PNG);
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    remember(key, body);
    res.setHeader('X-Tile-Cache', 'MISS');
    return sendTile(res, body);
  } catch (error) {
    // A timeout or a DNS failure is transient, so unlike a 400 it is NOT
    // cached -- caching it would keep the map blank until the process
    // restarts, long after the network came back.
    console.warn(`[tiles] ${key} upstream failed: ${error.message}`);
    res.setHeader('X-Tile-Cache', 'ERROR');
    return sendTile(res, EMPTY_PNG, 0);
  }
});

function sendTile(res, buffer, maxAge = 604800) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', maxAge > 0
    ? `public, max-age=${maxAge}, immutable`
    : 'no-store');
  return res.end(buffer);
}
