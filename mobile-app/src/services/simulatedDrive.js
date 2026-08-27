// Simulated drive along a real corridor (prototype demonstration mode).
//
// WHY: the handset is not in the North East. Real GNSS puts it wherever it
// physically is -- during development, Bhubaneswar, ~1,400 km outside the
// road graph -- where no edge snaps, no route plans and no hazard resolves,
// so every downstream feature reads as broken when it is merely out of area.
//
// This substitutes a truck driving the corridor geometry that pgr_astar
// actually returned. It is a substitute for the SENSOR, not for the system:
// the fixes go through the same Tracker path, the same socket emit, the same
// WatermelonDB queue and the same backend ingest as a real one. Nothing
// downstream knows the difference, which is the point -- a demo that bypasses
// the pipeline proves nothing about the pipeline.
//
// NOT a substitute for a road test. `source` stays 'gps' because that is what
// the fix is standing in for, so anything reading telemetry cannot distinguish
// this from real driving. Ship it disabled.

const EARTH_R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Haversine, metres. The corridor spans ~1.5 degrees of latitude, which is
 *  far too much for a flat-earth approximation to stay honest over. */
export function haversine([lng1, lat1], [lng2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees, 0-360. This is what the HUD compass reads. */
export function bearing([lng1, lat1], [lng2, lat2]) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lng2 - lng1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point at `t` (0..1) along a segment, linear in lat/lng.
 *  Over a single graph edge -- tens of metres -- the great-circle and the
 *  straight line differ by far less than GNSS noise, so this is exact enough
 *  and avoids a slerp per tick. */
export function lerp([lng1, lat1], [lng2, lat2], t) {
  return [lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t];
}

/**
 * Precompute cumulative distance along the polyline.
 *
 * Done once up front rather than per tick: the corridors run to 8,656
 * vertices, and re-walking that every second to find the current segment
 * would be O(n) per fix for no reason.
 */
export function measure(coordinates) {
  const cum = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    cum.push(cum[i - 1] + haversine(coordinates[i - 1], coordinates[i]));
  }
  return cum;
}

export class SimulatedDrive {
  /**
   * @param {object}   opts
   * @param {number[][]} opts.coordinates  [[lng, lat], ...] from the corridor
   * @param {number}   opts.speedKmh       ground speed to simulate
   * @param {number}   opts.intervalMs     fix cadence; 1000 matches real GNSS
   * @param {boolean}  opts.loop           restart at the origin on arrival
   * @param {function} opts.onFix          receives a watchPosition-shaped fix
   */
  constructor({ coordinates, speedKmh = 60, intervalMs = 1000, loop = true, onFix }) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error('simulated drive needs a corridor of at least two points');
    }
    this.coordinates = coordinates;
    this.cum = measure(coordinates);
    this.totalM = this.cum[this.cum.length - 1];
    this.speedMps = (speedKmh * 1000) / 3600;
    this.intervalMs = intervalMs;
    this.loop = loop;
    this.onFix = onFix;

    this.travelled = 0;
    this.segment = 0;
    this.timer = null;
  }

  get progress() {
    return this.totalM > 0 ? this.travelled / this.totalM : 0;
  }

  start() {
    if (this.timer) return;
    // Emit immediately so the map has an origin to centre on rather than
    // sitting at the default view for a full tick.
    this.tick(0);
    this.timer = setInterval(() => this.tick(this.intervalMs), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Advance by one interval and emit the resulting fix. */
  tick(elapsedMs) {
    this.travelled += this.speedMps * (elapsedMs / 1000);

    if (this.travelled >= this.totalM) {
      if (!this.loop) {
        this.travelled = this.totalM;
        this.stop();
      } else {
        // Wrap rather than reset to 0, so a long interval does not lose the
        // overshoot and stutter at the origin.
        this.travelled %= this.totalM;
        this.segment = 0;
      }
    }

    // Walk forward from the last segment. Monotonic, so this is amortised
    // O(1) per tick across the whole drive rather than O(n) each time.
    while (this.segment < this.cum.length - 2
           && this.cum[this.segment + 1] < this.travelled) {
      this.segment += 1;
    }

    const a = this.coordinates[this.segment];
    const b = this.coordinates[Math.min(this.segment + 1, this.coordinates.length - 1)];
    const segLen = this.cum[this.segment + 1] - this.cum[this.segment];
    const t = segLen > 0 ? (this.travelled - this.cum[this.segment]) / segLen : 0;
    const [lng, lat] = lerp(a, b, Math.max(0, Math.min(1, t)));

    this.onFix?.({
      coords: {
        latitude: lat,
        longitude: lng,
        speed: this.speedMps,
        heading: bearing(a, b),
        // Corridors carry no elevation, and inventing one would put a
        // fabricated number on the HUD next to measured ones.
        altitude: null,
        accuracy: 5,
      },
      timestamp: Date.now(),
    });
  }
}
