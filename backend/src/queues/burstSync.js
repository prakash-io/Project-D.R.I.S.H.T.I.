// The Burst Sync queue (API-02).
//
// When a truck leaves a dark zone it POSTs its entire WatermelonDB backlog at
// once -- potentially thousands of dead-reckoned points. Writing those inline
// would block the Express event loop for as long as the batch takes, starving
// the live telemetry of every other truck. So the endpoint validates the
// envelope, enqueues, and answers 202 Accepted; the worker does the writing.
import { Queue } from 'bullmq';
import { createRedis } from '../redis.js';
import { config } from '../config.js';

let queue = null;

export function burstSyncQueue() {
  if (!queue) {
    queue = new Queue(config.syncQueueName, {
      connection: createRedis(),
      defaultJobOptions: {
        // Retries are safe: telemetry carries a client-generated uuid with a
        // UNIQUE index, so replaying a whole batch re-inserts nothing.
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return queue;
}

export async function closeQueue() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
