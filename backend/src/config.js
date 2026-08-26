// Resolved configuration. Reads .env if present, otherwise the same defaults
// .env.example documents, so a clean checkout runs without a config step.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

const int = (value, fallback) => (value === undefined ? fallback : Number.parseInt(value, 10));

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),
  socketPath: process.env.SOCKET_PATH ?? '/socket.io',

  // 5433/6380 on the host, not the defaults: another local stack binds
  // 5432/6379. Inside the containers the services still use standard ports.
  databaseUrl: process.env.DATABASE_URL
    ?? 'postgresql://drishti:drishti@localhost:5433/drishti',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',

  // '*' in development. A dispatcher console on another origin has to be able
  // to reach this, and the API carries no cookies or credentials.
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  syncQueueName: process.env.SYNC_QUEUE_NAME ?? 'burst-sync',
  syncQueueConcurrency: int(process.env.SYNC_QUEUE_CONCURRENCY, 4),

  aiServiceUrl: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
  aiTimeoutMs: int(process.env.AI_TIMEOUT_MS, 30000),

  // The cost routable_edges gives a blocked edge. Not Infinity: pgRouting
  // treats a negative cost as impassable and drops the edge from the graph
  // entirely, which loses the ability to route through it as a last resort.
  blockedEdgeCost: int(process.env.BLOCKED_EDGE_COST, 999999),

  // Where driver photos are kept. WEB-05 shows the dispatcher the photo next
  // to the model's verdict, and a reviewer cannot approve closing a highway
  // on the strength of a class name alone -- so the image has to survive the
  // request that carried it.
  uploadDir: process.env.UPLOAD_DIR ?? path.join(ROOT, 'data', 'incidents'),

  // How far from a road a report may be before it is rejected. Beyond this
  // it is bad GPS, and blocking the "nearest" edge would take out an
  // unrelated road.
  incidentSnapMaxM: int(process.env.INCIDENT_SNAP_MAX_M, 200),

  // Whether a verified incident may block an edge without a human. OFF, and
  // it must stay off while the vision model has no "no incident" class and is
  // out of distribution on ground-level photographs. See REVISION.md Q2.
  autoBlockOnAiVerdict: process.env.AUTO_BLOCK_ON_AI_VERDICT === '1',
};
