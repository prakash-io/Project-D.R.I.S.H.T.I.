// Burst Sync (MOB-03, workflow section 3).
//
// On reconnect the entire offline backlog goes to the backend in one POST,
// which answers 202 Accepted and hands it to BullMQ. Rows are deleted only
// after the server has acknowledged them.
import { Q } from '@nozbe/watermelondb';

/// Chunked because a multi-hour blackout at 10 Hz is tens of thousands of
/// rows, and the endpoint caps a batch at 50,000. Smaller chunks also mean a
/// failure loses one chunk's progress, not the whole drive.
const CHUNK = 2000;

export async function pendingCount(database) {
  return database.get('telemetry_points').query().fetchCount();
}

/**
 * Drain the local queue to the backend.
 *
 * Safe to call repeatedly and safe to interrupt. Every point carries a
 * client-generated uuid with a UNIQUE index server-side, so a chunk that is
 * sent twice -- because the response was lost, or the app was killed between
 * the POST and the delete -- writes nothing the second time. That is what
 * makes deleting only after acknowledgement correct rather than lossy.
 */
export async function drain(database, { apiUrl, truckId, onProgress }) {
  const collection = database.get('telemetry_points');
  let sent = 0;
  let failed = 0;

  for (;;) {
    const batch = await collection.query(
      Q.sortBy('captured_at', Q.asc),
      Q.take(CHUNK),
    ).fetch();
    if (batch.length === 0) break;

    const points = batch.map((row) => row.toSyncPayload());
    let response;
    try {
      response = await fetch(`${apiUrl}/sync/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ truck_id: truckId, points }),
      });
    } catch (error) {
      // The network went away again mid-drain, which in NER is the normal
      // case. Keep the rows; the next reconnect resumes from here.
      return { sent, failed: batch.length, incomplete: true, error: error.message };
    }

    if (response.status !== 202) {
      const body = await response.text().catch(() => '');
      // 4xx means the payload is wrong and retrying will not fix it, but the
      // rows are still kept: losing a driver's dark-zone track to a schema
      // disagreement is worse than a queue that needs attention.
      failed += batch.length;
      return { sent, failed, incomplete: true, error: `HTTP ${response.status}: ${body}` };
    }

    await database.write(async () => {
      await Promise.all(batch.map((row) => row.destroyPermanently()));
    });

    sent += batch.length;
    if (onProgress) onProgress({ sent });
  }

  return { sent, failed, incomplete: false };
}
