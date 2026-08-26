import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

/**
 * One queued hazard report (Workflow 4).
 *
 * Written the instant the driver takes the photo, before any network is
 * attempted. A landslide is reported from exactly the places with no signal,
 * so treating the upload as the primary path would lose the reports that
 * matter most.
 */
export default class HazardReport extends Model {
  static table = 'hazard_reports';

  @field('client_uid') clientUid;
  @field('latitude') latitude;
  @field('longitude') longitude;
  @field('photo_path') photoPath;
  @field('mime_type') mimeType;
  @field('kind') kind;
  @field('attempts') attempts;
  @field('last_error') lastError;
  @date('captured_at') capturedAt;
}
