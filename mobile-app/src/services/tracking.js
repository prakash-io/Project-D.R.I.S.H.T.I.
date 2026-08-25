// The mode switch: online GNSS vs dark-zone dead reckoning (MOB-01, MOB-06).
//
// This is workflow sections 1 and 2 in one file, because the interesting part
// is the TRANSITION, not either steady state.
import Geolocation from 'react-native-geolocation-service';
import { accelerometer, gyroscope, setUpdateIntervalForType, SensorTypes }
  from 'react-native-sensors';
import * as edge from './edgeEngine';

const IMU_HZ = 100;
const MAP_MATCH_EVERY_N_FIXES = 50;   // 5 s at the model's 10 Hz output

export class Tracker {
  constructor({ database, socket, graphPath, modelPath, onFix }) {
    this.database = database;
    this.socket = socket;
    this.graphPath = graphPath;
    this.modelPath = modelPath;
    this.onFix = onFix;

    this.mode = 'idle';
    this.lastFix = null;
    this.watchId = null;
    this.sensors = [];
    this.unsubscribeEdge = null;
    this.fixCount = 0;
  }

  /** Online: 1 Hz GNSS straight to the backend over Socket.IO. */
  startOnline() {
    if (this.mode === 'online') return;
    this.stopOffline();
    this.mode = 'online';

    this.watchId = Geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, speed, heading } = position.coords;
        this.lastFix = {
          latitude, longitude,
          speed: speed ?? 0,
          heading: heading ?? 0,
          timestamp: position.timestamp,
        };
        this.fixCount += 1;
        this.socket?.emit('truck_location_update', {
          truck_id: this.truckId,
          lat: latitude,
          lng: longitude,
          speed: speed ?? null,
          source: 'gps',
          timestamp: new Date(position.timestamp).toISOString(),
        });
        this.onFix?.({ ...this.lastFix, source: 'gps' });
      },
      (error) => console.warn('[gnss]', error.message),
      {
        accuracy: { android: 'high', ios: 'best' },
        distanceFilter: 0,
        interval: 1000,
        fastestInterval: 1000,
        // The truck keeps moving when the screen is off and the phone is in a
        // cradle; without this the OS suspends updates and the track gaps.
        showsBackgroundLocationIndicator: true,
      },
    );
  }

  /**
   * Dark zone: 100 Hz IMU into the C++ engine, rows into WatermelonDB.
   *
   * Seeded from `lastFix`, which is by definition the moment signal was lost.
   * Without one there is no origin for the local plane and dead reckoning
   * cannot start at all -- so this refuses rather than guessing.
   */
  async startOffline() {
    if (this.mode === 'offline') return false;
    if (!this.lastFix) {
      console.warn('[edge] no GNSS fix yet -- cannot seed dead reckoning');
      return false;
    }
    this.stopOnline();
    this.mode = 'offline';

    const started = await edge.start({
      graphPath: this.graphPath,
      modelPath: this.modelPath,
      lastFix: this.lastFix,
    });
    if (!started) {
      this.mode = 'degraded';
      return false;
    }

    this.unsubscribeEdge = edge.subscribe(async (fix) => {
      this.fixCount += 1;
      if (this.fixCount % MAP_MATCH_EVERY_N_FIXES === 0) {
        // Fire and forget: the native side folds the correction in before the
        // next fix is emitted, and awaiting here would stall the sensor path.
        edge.mapMatch?.(60.0);
      }
      await this.persist(fix);
      this.onFix?.({ ...fix, source: 'ekf' });
    });

    setUpdateIntervalForType(SensorTypes.accelerometer, 1000 / IMU_HZ);
    setUpdateIntervalForType(SensorTypes.gyroscope, 1000 / IMU_HZ);

    // Accelerometer and gyroscope arrive as separate streams with their own
    // timestamps. The engine needs both channels in one sample, so the latest
    // gyro reading is paired with each accelerometer reading -- at 100 Hz they
    // are at most 10 ms apart, which is well inside the 100 ms the decimated
    // sample represents.
    let latestGyro = { x: 0, y: 0, z: 0 };
    this.sensors.push(gyroscope.subscribe(({ x, y, z }) => { latestGyro = { x, y, z }; }));
    this.sensors.push(accelerometer.subscribe(({ x, y, z, timestamp }) => {
      edge.pushImu?.(x, y, z, latestGyro.z, latestGyro.x, latestGyro.y, timestamp / 1000);
    }));

    return true;
  }

  /** Every dead-reckoned fix becomes a queued row. */
  async persist(fix) {
    await this.database.write(async () => {
      await this.database.get('telemetry_points').create((row) => {
        row.clientUid = uuid();
        row.latitude = fix.latitude;
        row.longitude = fix.longitude;
        row.speedMps = fix.speed_mps ?? fix.speedMps ?? null;
        row.headingDeg = fix.heading_deg ?? fix.headingDeg ?? null;
        row.source = 'ekf';
        // Never null on an 'ekf' row: the server's CHECK constraint rejects
        // it, and the whole batch would come back as rejected points.
        row.covarianceM2 = fix.covariance_m2 ?? fix.covarianceM2 ?? 0;
        row.mapMatched = Boolean(fix.map_matched ?? fix.mapMatched);
        row.matchedEdgeId = fix.matched_edge_id ?? null;
        row.capturedAt = Math.round((fix.timestamp_s ?? Date.now() / 1000) * 1000);
      });
    });
  }

  stopOnline() {
    if (this.watchId !== null) {
      Geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  async stopOffline() {
    this.sensors.forEach((s) => s.unsubscribe());
    this.sensors = [];
    if (this.unsubscribeEdge) {
      this.unsubscribeEdge();
      this.unsubscribeEdge = null;
    }
    await edge.stop();
  }

  async stop() {
    this.stopOnline();
    await this.stopOffline();
    this.mode = 'idle';
  }
}

/// RFC 4122 v4, from Math.random. Adequate here: it only has to be unique
/// across one device's queue, and it is the server's UNIQUE index that makes
/// a replayed batch idempotent, not any cryptographic property.
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}
