// WatermelonDB schema (MOB-02).
//
// One table, and it is deliberately a queue rather than a history: every row
// here is a point the backend has not seen yet. Rows are deleted after a
// successful Burst Sync, so the table's size is the size of the backlog.
// Keeping a permanent local history would grow without bound on a phone that
// spends its life in valleys.
import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 1,
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
  ],
});
