// Pre-emptive hazard alerts (workflow section 5, WEB-04).
//
// Every card here is one sampled point on one planned corridor that the
// XGBoost model scored above the flag threshold, with the Open-Meteo rainfall
// that fed it. This is the "dispatcher acts before a truck is stuck" half of
// the platform -- the other half, the driver's own report, arrives through
// IncidentPanel and is a different kind of evidence entirely.
//
// Read the numbers knowing what they are. CLAUDE.md is explicit that the
// hazard labels are SYNTHETIC and the model is a demonstrator, so the card
// footer names its provenance rather than presenting a probability as
// forecasting skill. A console that hides that distinction teaches a
// dispatcher to trust it exactly as much as a real forecast.
import React from 'react';

/// India Meteorological Department 24-hour rainfall bands. Used rather than
/// invented cutoffs so the words on the card mean what they mean in the
/// bulletins a dispatcher already reads.
function rainfallBand(mm24h) {
  if (!Number.isFinite(mm24h) || mm24h < 0.1) return null;
  if (mm24h >= 204.5) return 'Extremely Heavy Rainfall';
  if (mm24h >= 115.6) return 'Very Heavy Rainfall';
  if (mm24h >= 64.5) return 'Heavy Rainfall';
  if (mm24h >= 15.6) return 'Moderate Rainfall';
  return 'Light Rainfall';
}

const THREAT = {
  FLOOD_RISK: 'Flood Risk',
  LANDSLIDE_RISK: 'Landslide Risk',
};

/// Unknown classes are humanised rather than dropped. If the model is
/// retrained with a fourth class, an unlabelled card is a far better failure
/// than a silently missing alert.
function threatName(kind) {
  if (!kind) return 'Hazard';
  return THREAT[kind]
    ?? kind.replace(/_/g, ' ').toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * "Heavy Rainfall: Flood Risk on Guwahati → Shillong"
 *
 * The rainfall clause is dropped when there is no rain to report, rather than
 * written as "No Rainfall". These features are eight-dimensional -- elevation,
 * slope and distance to river carry a dry-weather landslide perfectly well --
 * and prefixing such an alert with a rainfall phrase would misattribute it.
 */
function headline(alert) {
  const band = rainfallBand(alert.rainfall24h);
  const threat = `${threatName(alert.kind)} on ${alert.corridor}`;
  return band ? `${band}: ${threat}` : threat;
}

function AlertCard({ alert, critical }) {
  const pct = (alert.probability * 100).toFixed(1);

  return (
    <article
      className={`alert-glass ${critical ? 'alert-critical' : ''} p-4`}
      aria-label={headline(alert)}
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="font-display text-[15px] leading-tight tracking-crush
                       text-danger-text">
          {headline(alert)}
        </h3>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[20px] leading-none text-danger-text">
            {pct}%
          </div>
          <div className="meta mt-1">probability</div>
        </div>
      </div>

      {/* A meter, not a second number. The percentage above is the value; this
          is the comparison, and a dispatcher scanning ten cards ranks them by
          bar length far faster than by reading ten decimals. */}
      <div className="mt-3 h-1 w-full bg-inset" role="presentation">
        <div
          className="h-full bg-danger"
          style={{ width: `${Math.min(100, alert.probability * 100)}%` }}
        />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        <Row label="Rainfall 24 h" value={
          Number.isFinite(alert.rainfall24h) ? `${alert.rainfall24h.toFixed(1)} mm` : '—'
        } />
        <Row label="Intensity" value={
          Number.isFinite(alert.rainfallIntensity)
            ? `${alert.rainfallIntensity.toFixed(1)} mm/h` : '—'
        } />
        <Row label="Location" value={`${alert.lat.toFixed(3)}, ${alert.lng.toFixed(3)}`} />
        <Row label="Class" value={alert.kind ?? '—'} />
      </dl>

      <p className="meta mt-3 border-t border-danger/30 pt-2 normal-case tracking-normal">
        {alert.weatherSource ?? 'forecast'}
        {alert.windowStart ? ` · window from ${alert.windowStart}` : ''}
        {' · demonstrator model, synthetic hazard labels'}
      </p>
    </article>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="meta">{label}</dt>
      <dd className="font-mono text-[11px] text-phosphor">{value}</dd>
    </div>
  );
}

/**
 * @param alerts     from useHazardAlerts, already sorted worst-first
 * @param threshold  the flag level, shown so the empty state can state it
 */
export default function AlertFeed({
  alerts, loading, error, degraded, checkedAt, threshold, onRefresh,
}) {
  return (
    <section aria-label="Hazard alerts" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-edge
                         px-5 py-3">
        <div>
          <h2 className="font-display text-[13px] tracking-crush text-phosphor">
            PRE-EMPTIVE ALERTS
          </h2>
          <p className="meta mt-1 normal-case tracking-normal">
            Corridor segments scoring over {(threshold * 100).toFixed(0)}%
            {checkedAt ? ` · checked ${checkedAt.toLocaleTimeString()}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="focus-ring border border-edge px-3 py-1.5 font-mono text-[11px]
                     text-dim transition-colors hover:border-edge-active
                     hover:text-phosphor disabled:opacity-40"
        >
          {loading ? 'Scoring…' : 'Re-score'}
        </button>
      </header>

      {/* A partial sweep is reported, never silently shown as a full one.
          `degraded` means the AI service failed part-way and the list below
          is short for a reason that has nothing to do with the weather. */}
      {degraded && (
        <p role="status" className="border-b border-warn/40 bg-warn/10 px-5 py-2
                                    font-mono text-[11px] text-warn">
          Partial sweep — {degraded}
        </p>
      )}
      {error && !degraded && (
        <p role="status" className="border-b border-danger/40 bg-danger/10 px-5 py-2
                                    font-mono text-[11px] text-danger-text">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {alerts.length === 0 ? (
          <div className="border border-edge bg-panel/60 p-8 text-center">
            <p className="font-mono text-[12px] text-phosphor">
              {loading ? 'Scoring corridors…' : 'No segment over threshold'}
            </p>
            <p className="meta mt-2 normal-case tracking-normal">
              {loading
                ? 'One request per corridor, run in sequence.'
                : `Nothing on the planned network is currently scoring above `
                  + `${(threshold * 100).toFixed(0)}%.`}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {alerts.map((alert, i) => (
              // Only the worst one pulses. See index.css: a pulse on every
              // card is wallpaper, on exactly one it is a pointer.
              <AlertCard key={alert.key} alert={alert} critical={i === 0} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
