// BullMQ requires maxRetriesPerRequest: null on the connection it uses --
// with the ioredis default the blocking BRPOPLPUSH a worker sits on is
// aborted after 20 retries and the worker silently stops taking jobs.
import IORedis from 'ioredis';
import { config } from './config.js';

export function createRedis() {
  const connection = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  connection.on('error', (error) => console.error('[redis]', error.message));
  return connection;
}
