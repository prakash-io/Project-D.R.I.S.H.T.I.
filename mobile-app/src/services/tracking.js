// The mode switch: online GNSS vs dark-zone dead reckoning (MOB-01, MOB-06).
//
// This is workflow sections 1 and 2 in one file, because the interesting part
// is the TRANSITION, not either steady state.
import Geolocation from 'react-native-geolocation-service';
import { accelerometer, gyroscope, setUpdateIntervalForType, SensorTypes }
  from 'react-native-sensors';
import * as edge from './edgeEngine';
import * as foreground from './foregroundService';
import { SimulatedDrive } from './simulatedDrive';

const IMU_HZ = 100;
const MAP_MATCH_EVERY_N_FIXES = 50;   // 5 s at the model's 10 Hz output

export class Tracker {
  constructor({ database, socket, graphPath, modelPath, onFix, onQueued, simulate }) {
    this.database = database;
    this.socket = socket;
    this.graphPath = graphPath;
    this.modelPath = modelPath;
    this.onFix = onFix;
    this.onQueued = onQueued;
    // Prototype demonstration mode. When set, the GNSS receiver is replaced by
    // a truck driving a real pgr_astar corridor; everything downstream of the
    // fix is untouched. See simulatedDrive.js for why this exists.
    this.simulate = simulate ?? null;
    this.drive = null;

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

    // Fire and forget, and deliberately NOT awaited: the first GNSS fix must
    // not wait on a notification being drawn. `start` also repaints when the
    // service is already up, so arriving here from the dark zone reuses the
    // running service rather than cycling it -- see stopOnline/stopOffline,
    // neither of which tears it down.
    foreground.start('GNSS · streaming to command center');

    // ONE handler, two possible sources. The simulated drive emits a
    // watchPosition-shaped position deliberately, so this path cannot drift
    // between demo and real hardware -- there is only one path.
    const onPosition = (position) => {
        const { latitude, longitude, speed, heading, altitude } = position.coords;
        this.lastFix = {
          latitude, longitude,
          speed: speed ?? 0,
          heading: heading ?? 0,
          // Read but not synced: the backend's telemetry payload has no
          // altitude column, so this is a display value only. NER routes climb
          // and drop hard enough that a driver reads it as terrain context.
          altitude: Number.isFinite(altitude) ? altitude : null,
          timestamp: position.timestamp,
        };
        this.fixCount += 1;
        // Only a live socket carries the fix away. socket.io buffers emits
        // while disconnected and drops the buffer on reconnect, so emitting
        // into a dead socket looked like streaming while silently discarding
        // every point. Anything the link cannot take RIGHT NOW is queued
        // instead -- same durability guarantee the dark zone already had.
        if (this.socket?.connected) {
          this.socket.emit('truck_location_update', {
            truck_id: this.truckId,
            lat: latitude,
            lng: longitude,
            speed: speed ?? null,
            source: 'gps',
            timestamp: new Date(position.timestamp).toISOString(),
          });
        } else {
          this.persist(this.lastFix, 'gps').catch((error) =>
            console.warn('[queue]', error.message));
        }
        this.onFix?.({ ...this.lastFix, source: 'gps' });
    };

    if (this.simulate?.coordinates?.length >= 2) {
      this.drive = new SimulatedDrive({
        coordinates: this.simulate.coordinates,
        speedKmh: this.simulate.speedKmh ?? 60,
        intervalMs: 1000,
        loop: this.simulate.loop ?? true,
        onFix: onPosition,
      });
      this.drive.start();
      return;
    }

    this.watchId = Geolocation.watchPosition(
      onPosition,
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

    // The one transition that most needs the service: no network, screen
    // probably off, 100 Hz IMU into the EKF. The wake lock the service holds
    // is what keeps that sampling regular.
    foreground.start('DARK ZONE · dead reckoning');

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

  /**
   * Any fix the link could not take becomes a queued row.
   *
   * Takes both shapes: the engine's snake_case dead-reckoned fix and the
   * GNSS fix built above. `source` decides the covariance rule, so it is a
   * parameter rather than a constant.
   */
  async persist(fix, source = 'ekf') {
    await this.database.write(async () => {
      await this.database.get('telemetry_points').create((row) => {
        row.clientUid = uuid();
        row.latitude = fix.latitude;
        row.longitude = fix.longitude;
        row.speedMps = fix.speed_mps ?? fix.speedMps ?? fix.speed ?? null;
        row.headingDeg = fix.heading_deg ?? fix.headingDeg ?? fix.heading ?? null;
        row.source = source;
        // Never null on an 'ekf' row: the server's CHECK constraint rejects
        // it, and the whole batch would come back as rejected points. A 'gps'
        // row has no covariance to report and must leave it null.
        row.covarianceM2 = source === 'ekf'
          ? (fix.covariance_m2 ?? fix.covarianceM2 ?? 0)
          : null;
        row.mapMatched = Boolean(fix.map_matched ?? fix.mapMatched);
        row.matchedEdgeId = fix.matched_edge_id ?? null;
        // The engine reports seconds; a GNSS position reports milliseconds.
        row.capturedAt = fix.timestamp_s != null
          ? Math.round(fix.timestamp_s * 1000)
          : (fix.timestamp ?? Date.now());
      });
    });
    // Let the UI count what is actually held, rather than assuming zero.
    this.onQueued?.();
  }

  /**
   * Swap the simulated corridor without tearing down the tracker.
   *
   * A full re-init would recreate the database handle, the socket and the
   * foreground service to change a demo route -- and cycling the service is
   * exactly the window in which Android is entitled to freeze the process.
   * Only the drive is replaced.
   */
  setCorridor(coordinates, speedKmh) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
    this.simulate = {
      ...(this.simulate ?? {}),
      coordinates,
      speedKmh: speedKmh ?? this.simulate?.speedKmh ?? 60,
    };
    if (this.mode !== 'online') return true;
    // Restart through startOnline so there is one construction path for the
    // drive rather than two that can drift apart.
    this.stopOnline();
    this.mode = 'idle';
    this.startOnline();
    return true;
  }

  stopOnline() {
    if (this.drive) {
      this.drive.stop();
      this.drive = null;
    }
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
    // Only here. stopOnline() and stopOffline() are also the mode-switch
    // path, and dropping the service on a switch would hand the OS a window
    // to freeze the process precisely as the truck enters a dark zone.
    await foreground.stop();
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
