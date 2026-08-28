// Weather & Alerts — the pre-emptive half of the platform (workflow §5).
//
// The distinction this page has to hold onto: everything here is a FORECAST
// over a planned corridor, produced before any truck is in trouble. The
// incident queue on the command center is the opposite -- a driver's photo of
// something that has already happened. Mixing the two into one feed would let
// a modelled probability and an eyewitness report carry the same weight, and
// only one of them can close a road.
import React from 'react';
import AlertFeed from '../components/AlertFeed';

function Stat({ label, value, tone = 'text-phosphor' }) {
  return (
    <div className="border border-edge bg-panel/60 px-4 py-3">
      <div className={`font-mono text-[20px] leading-none ${tone}`}>{value}</div>
      <div className="meta mt-1.5">{label}</div>
    </div>
  );
}

export default function WeatherAlerts({
  alerts, loading, error, degraded, checkedAt, refresh,
  corridors, threshold,
}) {
  const worst = alerts.length > 0 ? alerts[0].probability : null;
  // Distinct corridors carrying at least one flagged point — a more useful
  // number than the raw alert count, which double-counts a single storm
  // sampled at four points along the same road.
  const affected = new Set(alerts.map((a) => a.corridor)).size;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-edge px-5 py-4">
        <h1 className="font-display text-[18px] tracking-crush text-phosphor">
          WEATHER &amp; ALERTS
        </h1>
        <p className="meta mt-1.5 normal-case tracking-normal">
          Hourly precipitation from Open-Meteo, scored against terrain by the
          hazard model along every planned corridor.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 px-5 py-4 lg:grid-cols-4">
        <Stat label="Corridors scanned" value={corridors.length} />
        <Stat label="Corridors affected" value={affected}
          tone={affected > 0 ? 'text-danger-text' : 'text-phosphor'} />
        <Stat label="Segments flagged" value={alerts.length}
          tone={alerts.length > 0 ? 'text-danger-text' : 'text-phosphor'} />
        <Stat
          label="Highest probability"
          value={worst === null ? '—' : `${(worst * 100).toFixed(1)}%`}
          tone={worst === null ? 'text-phosphor' : 'text-danger-text'}
        />
      </div>

      <AlertFeed
        alerts={alerts}
        loading={loading}
        error={error}
        degraded={degraded}
        checkedAt={checkedAt}
        threshold={threshold}
        onRefresh={refresh}
      />
    </div>
  );
}
