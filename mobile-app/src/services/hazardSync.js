// Hazard report queue and drain (Workflow 4, MOB-02/MOB-03).
//
// Deliberately NOT folded into burstSync.js. Telemetry drains as one JSON
// array to /sync/telemetry; a hazard report is a multipart upload with a photo
// to /incidents/report, one request per report. Sharing a loop would mean one
// of them pretending to be the other.
//
// What IS shared is the contract: write locally first, upload second, delete
// only on acknowledgement.
import { Q } from '@nozbe/watermelondb';
import RNFS from 'react-native-fs';

/// Past this many failed attempts a report stops being retried automatically.
/// It is NOT deleted -- the photo is evidence of a blocked road and the driver
/// is shown that it is stuck, rather than it disappearing silently.
const MAX_ATTEMPTS = 8;

export async function pendingHazardCount(database) {
  return database.get('hazard_reports').query().fetchCount();
}

/**
 * Copy the picked photo into app storage and queue the report.
 *
 * The picker hands back a cache path that Android is free to delete. Copying
 * into DocumentDirectoryPath is what makes the report survive a dark zone that
 * outlasts the cache.
 */
export async function queueHazard(database, { uri, mimeType, latitude, longitude, kind }) {
  const clientUid = uuid();
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const photoPath = `${RNFS.DocumentDirectoryPath}/hazards/${clientUid}.${extension}`;

  await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/hazards`);
  await RNFS.copyFile(uri.replace(/^file:\/\//, ''), photoPath);

  await database.write(async () => {
    await database.get('hazard_reports').create((row) => {
      row.clientUid = clientUid;
      row.latitude = latitude;
      row.longitude = longitude;
      row.photoPath = photoPath;
      row.mimeType = mimeType;
      row.kind = kind ?? 'obstruction';
      row.attempts = 0;
      row.capturedAt = Date.now();
    });
  });

  return clientUid;
}

/**
 * Push queued reports to the backend, oldest first.
 *
 * `client_uid` travels with every upload and the backend holds a UNIQUE index
 * on it, so replaying a report whose response was lost is a no-op server-side
 * rather than a second landslide on the same stretch of road.
 */
export async function drainHazards(database, { apiUrl, truckId, onProgress }) {
  const collection = database.get('hazard_reports');
  const queued = await collection.query(Q.sortBy('captured_at', Q.asc)).fetch();

  let sent = 0;
  let stuck = 0;

  for (const report of queued) {
    if (report.attempts >= MAX_ATTEMPTS) { stuck += 1; continue; }

    // The photo is the report. If the file is gone there is nothing to send
    // and retrying forever helps nobody, so the row goes with it.
    if (!(await RNFS.exists(report.photoPath))) {
      await database.write(async () => { await report.destroyPermanently(); });
      continue;
    }

    const form = new FormData();
    form.append('file', {
      uri: `file://${report.photoPath}`,
      type: report.mimeType,
      name: `${report.clientUid}.jpg`,
    });
    form.append('lat', String(report.latitude));
    form.append('lng', String(report.longitude));
    form.append('client_uid', report.clientUid);
    // The driver's own classification. It was stored by queueHazard and then
    // never sent, so every report reached the backend as an anonymous photo
    // and came back as the generic 'obstruction' fallback -- the driver's
    // account of what they were looking at was collected and then dropped on
    // the floor one function later.
    if (report.kind) form.append('kind', report.kind);
    if (truckId) form.append('truck_id', truckId);

    let response;
    try {
      response = await fetch(`${apiUrl}/incidents/report`, { method: 'POST', body: form });
    } catch (error) {
      // Still in the dark zone. Keep the row exactly as it is; the next
      // reconnect resumes from here.
      await bumpAttempt(database, report, error.message);
      return { sent, stuck, incomplete: true, error: error.message };
    }

    // 200 duplicate, 201 created, 202 stored-unclassified. All three mean the
    // backend owns the report now.
    if (response.status === 200 || response.status === 201 || response.status === 202) {
      // Read the path BEFORE destroying the record: fields on a destroyed
      // WatermelonDB model are no longer safe to touch, and the photo would
      // be orphaned on disk for the life of the install.
      const photoPath = report.photoPath;
      await database.write(async () => { await report.destroyPermanently(); });
      await RNFS.unlink(photoPath).catch(() => {});
      sent += 1;
      onProgress?.({ sent });
      continue;
    }

    // 4xx: the payload is wrong and retrying will not fix it, but a 422 is
    // "no road near that point", which a later, better GPS fix cannot repair
    // either. Count the attempt and move on rather than blocking the queue.
    const body = await response.text().catch(() => '');
    await bumpAttempt(database, report, `HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  return { sent, stuck, incomplete: false };
}

async function bumpAttempt(database, report, message) {
  await database.write(async () => {
    await report.update((row) => {
      row.attempts = (row.attempts ?? 0) + 1;
      row.lastError = message;
    });
  });
}

/// Matches the telemetry queue's generator: uniqueness only has to hold across
/// one device, and the server's UNIQUE index is what makes a replay idempotent.
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}
