// WatermelonDB migrations (MOB-02).
//
// Incrementing the schema version WITHOUT a matching migration makes
// WatermelonDB drop and recreate the database. On this app that would delete a
// driver's queued dark-zone track -- the one thing the local queue exists to
// protect -- so every version bump gets an explicit step here.
import { schemaMigrations, createTable } from '@nozbe/watermelondb/Schema/migrations';

export const migrations = schemaMigrations({
  migrations: [
    {
      // v2 -> v3: cached hazard forecasts (workflow section 5).
      //
      // Additive, like v2. `telemetry_points` and `hazard_reports` are
      // untouched, so a device upgrading mid-blackout keeps everything it was
      // holding.
      toVersion: 3,
      steps: [
        createTable({
          name: 'hazard_forecasts',
          columns: [
            // Stable identity for one predicted node, so a refresh replaces
            // rather than duplicates it.
            { name: 'node_key', type: 'string', isIndexed: true },
            { name: 'latitude', type: 'number' },
            { name: 'longitude', type: 'number' },
            { name: 'kind', type: 'string' },
            { name: 'probability', type: 'number' },
            { name: 'rainfall_24h_mm', type: 'number', isOptional: true },
            { name: 'rainfall_intensity_mmh', type: 'number', isOptional: true },
            { name: 'window_start_utc', type: 'string', isOptional: true },
            // When the phone last heard this from the model. A forecast is
            // perishable; the UI must be able to say how old it is.
            { name: 'fetched_at', type: 'number', isIndexed: true },
          ],
        }),
      ],
    },
    {
      // v1 -> v2: crowdsourced hazard reports (Workflow 4).
      // Purely additive. `telemetry_points` is untouched, so a device
      // upgrading mid-blackout keeps everything it was holding.
      toVersion: 2,
      steps: [
        createTable({
          name: 'hazard_reports',
          columns: [
            { name: 'client_uid', type: 'string', isIndexed: true },
            { name: 'latitude', type: 'number' },
            { name: 'longitude', type: 'number' },
            // Path under DocumentDirectoryPath. The image itself is never a
            // blob in SQLite: a few hundred KB per row would bloat the same
            // database the 10 Hz telemetry queue is writing to.
            { name: 'photo_path', type: 'string' },
            { name: 'mime_type', type: 'string' },
            { name: 'kind', type: 'string' },
            { name: 'captured_at', type: 'number', isIndexed: true },
            // Retry bookkeeping, so a permanently rejected report can be shown
            // to the driver instead of retried forever.
            { name: 'attempts', type: 'number' },
            { name: 'last_error', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
  ],
});
