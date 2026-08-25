import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

export default class TelemetryPoint extends Model {
  static table = 'telemetry_points';

  @field('client_uid') clientUid;
  @field('latitude') latitude;
  @field('longitude') longitude;
  @field('speed_mps') speedMps;
  @field('heading_deg') headingDeg;
  @field('source') source;
  @field('covariance_m2') covarianceM2;
  @field('map_matched') mapMatched;
  @field('matched_edge_id') matchedEdgeId;
  @date('captured_at') capturedAt;

  /// The exact shape POST /sync/telemetry expects.
  toSyncPayload() {
    return {
      client_uid: this.clientUid,
      lat: this.latitude,
      lng: this.longitude,
      speed: this.speedMps,
      heading_deg: this.headingDeg,
      source: this.source,
      covariance_m2: this.covarianceM2,
      map_matched: this.mapMatched,
      timestamp: new Date(this.capturedAt).toISOString(),
    };
  }
}
