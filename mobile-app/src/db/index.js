// WatermelonDB setup (MOB-02).
import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { schema } from './schema';
import { migrations } from './migrations';
import TelemetryPoint from './models/TelemetryPoint';
import HazardReport from './models/HazardReport';
import HazardForecast from './models/HazardForecast';

export function createDatabase() {
  const adapter = new SQLiteAdapter({
    schema,
    // Without this, a version bump silently wipes the queue.
    migrations,
    // JSI where available: the offline queue is written at 10 Hz through a
    // whole blackout, and the async bridge adds latency to every one of those
    // writes on the same thread that is reading the sensors.
    jsi: true,
    dbName: 'drishti',
    onSetUpError: (error) => {
      // Fatal in practice: with no local queue, a dark-zone track is lost the
      // moment it is produced.
      console.error('[db] WatermelonDB failed to open -- the offline queue is ' +
        'unavailable and dark-zone points will NOT be retained:', error);
    },
  });

  return new Database({ adapter, modelClasses: [TelemetryPoint, HazardReport, HazardForecast] });
}
