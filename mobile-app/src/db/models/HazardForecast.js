import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

/**
 * One predicted hazard node on the active route (workflow section 5).
 *
 * Cached locally because the warning matters most exactly where it cannot be
 * fetched. A truck that loses signal entering a valley must keep the flood
 * and landslide nodes it was told about while it still had a link.
 */
export default class HazardForecast extends Model {
  static table = 'hazard_forecasts';

  @field('node_key') nodeKey;
  @field('latitude') latitude;
  @field('longitude') longitude;
  @field('kind') kind;
  @field('probability') probability;
  @field('rainfall_24h_mm') rainfall24hMm;
  @field('rainfall_intensity_mmh') rainfallIntensityMmh;
  @field('window_start_utc') windowStartUtc;
  @date('fetched_at') fetchedAt;
}
