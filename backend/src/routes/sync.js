// Burst Sync ingest endpoint (API-02, workflow section 3).
import { Router } from 'express';
import { burstSyncQueue } from '../queues/burstSync.js';
import { BURST_SYNC_JOB } from '../queues/burstSyncWorker.js';

export const syncRouter = Router();

/**
 * POST /sync/telemetry   { truck_id, points: [...] }
 *
 * Answers 202 Accepted and enqueues. The whole point is not to hold the event
 * loop while a few thousand dark-zone points are written -- every other
 * truck's live telemetry is flowing through the same process.
 */
syncRouter.post('/telemetry', async (req, res, next) => {
  try {
    const { truck_id: truckId, points } = req.body ?? {};
    if (!truckId) return res.status(400).json({ error: 'truck_id is required' });
    if (!Array.isArray(points)) return res.status(400).json({ error: 'points must be an array' });
    if (points.length === 0) return res.status(400).json({ error: 'points is empty' });
    if (points.length > 50_000) {
      return res.status(413).json({ error: `batch of ${points.length} exceeds 50000 points` });
    }

    const job = await burstSyncQueue().add(BURST_SYNC_JOB, { truck_id: truckId, points });

    res.status(202).json({
      accepted: true,
      job_id: job.id,
      truck_id: truckId,
      points: points.length,
      note: 'queued; poll GET /sync/jobs/:id for the result',
    });
  } catch (error) { next(error); }
});

/** GET /sync/jobs/:id -- what happened to a batch. */
syncRouter.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await burstSyncQueue().getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'no such job' });
    res.json({
      job_id: job.id,
      state: await job.getState(),
      progress: job.progress,
      result: job.returnvalue ?? null,
      failed_reason: job.failedReason ?? null,
    });
  } catch (error) { next(error); }
});
