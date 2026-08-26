// Layer toggles and connection state (WEB-01, WEB-04).
import React from 'react';

function Toggle({ label, checked, onChange, accent = 'live', badge }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition
        ${checked
          ? `border-${accent}/50 bg-${accent}/10 text-slate-100`
          : 'border-edge bg-surface text-muted hover:text-slate-300'}`}
    >
      <span className={`h-2 w-2 rounded-full ${checked ? `bg-${accent}` : 'bg-edge'}`} />
      {label}
      {badge !== undefined && (
        <span className="font-mono text-[10px] text-muted">{badge}</span>
      )}
    </button>
  );
}

export default function ControlBar({
  connected, packets, truckCount,
  showTrucks, setShowTrucks,
  showRisk, setShowRisk,
  riskCount, riskLoading, threshold,
}) {
  return (
    <header className="flex items-center gap-4 border-b border-edge bg-panel px-4 py-2.5">
      <div className="flex items-baseline gap-2">
        <h1 className="text-sm font-bold tracking-[0.2em] text-slate-100">D.R.I.S.H.T.I.</h1>
        <span className="text-[10px] uppercase tracking-widest text-muted">
          Command Center
        </span>
      </div>

      <div className="flex items-center gap-2 ml-2">
        <Toggle label="Trucks" checked={showTrucks} onChange={setShowTrucks}
                accent="live" badge={truckCount} />
        <Toggle
          label="Disruption Overlay"
          checked={showRisk}
          onChange={setShowRisk}
          accent="danger"
          badge={riskLoading ? '…' : riskCount}
        />
        {showRisk && (
          <span className="text-[11px] text-muted">
            segments at risk &gt; {(threshold * 100).toFixed(0)}%
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-4 text-xs">
        <span className="font-mono text-muted">{packets} packets</span>
        <span className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${
            connected ? 'bg-ok animate-pulse' : 'bg-danger'}`} />
          <span className={connected ? 'text-ok' : 'text-danger'}>
            {connected ? 'TELEMETRY LIVE' : 'DISCONNECTED'}
          </span>
        </span>
      </div>
    </header>
  );
}
