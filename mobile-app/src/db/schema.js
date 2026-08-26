// WatermelonDB schema (MOB-02).
//
// One table, and it is deliberately a queue rather than a history: every row
// here is a point the backend has not seen yet. Rows are deleted after a
// successful Burst Sync, so the table's size is the size of the backlog.
// Keeping a permanent local history would grow without bound on a phone that
// spends its life in valleys.
import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 3,
  tables: [
    tableSchema({
      name: 'telemetry_points',
      columns: [
        { name: 'client_uid', type: 'string', isIndexed: true },
        { name: 'latitude', type: 'number' },
        { name: 'longitude', type: 'number' },
        { name: 'speed_mps', type: 'number', isOptional: true },
        { name: 'heading_deg', type: 'number', isOptional: true },
        // 'gps' online, 'ekf' dead-reckoned. The backend's CHECK constraint
        // allows only these two.
        { name: 'source', type: 'string' },
        // Required whenever source is 'ekf': the server rejects the row
        // without it, and the dashboard draws its uncertainty halo from it.
        { name: 'covariance_m2', type: 'number', isOptional: true },
        { name: 'map_matched', type: 'boolean' },
        { name: 'matched_edge_id', type: 'number', isOptional: true },
        // Device clock at capture, milliseconds. Deliberately distinct from
        // when the row reaches the server -- burst-synced points arrive
        // minutes to hours late, so ordering a track by arrival scrambles it.
        { name: 'captured_at', type: 'number', isIndexed: true },
      ],
    }),

    // Crowdsourced hazard reports (Workflow 4). Same offline-first contract as
    // telemetry: the row is written before the network is attempted, and it is
    // deleted only once the backend has acknowledged it.
    tableSchema({
      name: 'hazard_reports',
      columns: [
        // Sent as client_uid on the multipart upload. The backend's UNIQUE
        // index on it is what makes replaying a queued report safe -- without
        // it, a lost response during a burst sync creates a second incident
        // and can block a road twice.
        { name: 'client_uid', type: 'string', isIndexed: true },
        { name: 'latitude', type: 'number' },
        { name: 'longitude', type: 'number' },
        // Path under DocumentDirectoryPath, never a blob.
        { name: 'photo_path', type: 'string' },
        { name: 'mime_type', type: 'string' },
        { name: 'kind', type: 'string' },
        { name: 'captured_at', type: 'number', isIndexed: true },
        { name: 'attempts', type: 'number' },
        { name: 'last_error', type: 'string', isOptional: true },
      ],
    }),

    // Predicted weather/terrain hazards along the active route (section 5).
    // Cached so the warnings survive the dark zone that made them matter.
    tableSchema({
      name: 'hazard_forecasts',
      columns: [
        { name: 'node_key', type: 'string', isIndexed: true },
        { name: 'latitude', type: 'number' },
        { name: 'longitude', type: 'number' },
        { name: 'kind', type: 'string' },
        { name: 'probability', type: 'number' },
        { name: 'rainfall_24h_mm', type: 'number', isOptional: true },
        { name: 'rainfall_intensity_mmh', type: 'number', isOptional: true },
        { name: 'window_start_utc', type: 'string', isOptional: true },
        { name: 'fetched_at', type: 'number', isIndexed: true },
      ],
    }),
  ],
});
