// Burst Sync worker (API-02). Run as its own process: `npm run worker`.
//
// Drains a truck's offline backlog into `telemetry`, then tells the dashboard
// so it can paint the path the truck took through the dark zone.
import { Worker } from 'bullmq';
import { createRedis } from '../redis.js';
import { config } from '../config.js';
import { recordTelemetry } from '../sockets/telemetry.js';
import { pool } from '../db.js';

export const BURST_SYNC_JOB = 'drain-backlog';

/**
 * Process one batch.
 *
 * Points are written one at a time on purpose. A batch is a mix of good and
 * bad fixes -- a phone that lost its clock, a coordinate that overflowed --
 * and a single multi-row INSERT would reject the whole backlog because of one
 * of them. The job reports what it wrote and what it could not.
 */
export async function processBurstSync(job) {
  const { truck_id: truckId, points = [] } = job.data ?? {};
  const results = { truck_id: truckId, received: points.length, written: 0,
                    duplicates: 0, rejected: [] };

  for (const [index, point] of points.entries()) {
    try {
      const saved = await recordTelemetry({ ...point, truck_id: point.truck_id ?? truckId });
      // `written` counts rows persisted, NOT marker moves: a burst-synced
      // point is usually older than the live fix that arrived on reconnect,
      // so it is written without moving the truck. A point that was already
      // present is a replay, which is the idempotency working.
      if (saved.inserted) results.written += 1;
      else results.duplicates += 1;
    } catch (error) {
      results.rejected.push({ index, reason: error.message });
    }
    if (index % 200 === 0) await job.updateProgress(Math.round((index / points.length) * 100));
  }

  return results;
}

export function startBurstSyncWorker(onCompleted) {
  const worker = new Worker(config.syncQueueName, processBurstSync, {
    connection: createRedis(),
    concurrency: config.syncQueueConcurrency,
  });

  worker.on('completed', (job, result) => {
    console.log(`[burst-sync] ${job.id}: wrote ${result.written}/${result.received}` +
      (result.duplicates ? `, ${result.duplicates} already present` : '') +
      (result.rejected.length ? `, ${result.rejected.length} rejected` : ''));
    if (onCompleted) onCompleted(result);
  });
  worker.on('failed', (job, error) => {
    console.error(`[burst-sync] ${job?.id} failed:`, error.message);
  });

  return worker;
}

// Only start when run directly, so importing this for tests does not spawn a
// worker that competes for jobs.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`[burst-sync] worker up on "${config.syncQueueName}", ` +
    `concurrency ${config.syncQueueConcurrency}`);
  const worker = startBurstSyncWorker();
  const shutdown = async () => {
    await worker.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
