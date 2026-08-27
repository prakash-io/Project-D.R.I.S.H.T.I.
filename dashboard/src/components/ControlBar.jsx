// Layer toggles and connection state (WEB-01, WEB-04).
//
// Frozen strings: the toggle labels "Trucks" and "Disruption Overlay", and
// the "<n> packets" readout. verify.mjs matches all three against
// document.body.innerText with case-sensitive regexes, and Chrome's
// innerText applies text-transform -- so these three cannot be uppercased in
// CSS, only framed. Structural voice is carried by the brackets and the
// surrounding .meta text instead.
import React from 'react';

// Section 6: ASCII framing replaces the conventional pill/switch. The bracket
// pair is what signals state, so the control reads as a terminal field.
function Toggle({ label, checked, onChange, tone, badge }) {
  // Explicit class pairs, never interpolated. The previous implementation
  // built `border-${accent}/50` at runtime; Tailwind's scanner only sees
  // literal strings, so those classes were never generated and the "on"
  // state rendered unstyled.
  const on = {
    danger: 'border-danger bg-danger/10 text-phosphor',
    live: 'border-live bg-live/10 text-phosphor',
    // Corridors are infrastructure, not status, so the "on" state is carried
    // by the hairline going active rather than by a colour. Same reason the
    // deck.gl layer is phosphor grey: a fourth accent would out-shout the
    // three that actually encode something.
    route: 'border-edge-active bg-surface text-phosphor',
  }[tone];
  const dot = {
    danger: 'bg-danger', live: 'bg-live', route: 'bg-muted',
  }[tone];

  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={`focus-ring group flex items-center gap-2 border px-3 py-1.5
                  font-mono text-[11px] tracking-term transition-colors
        ${checked ? on : 'border-edge bg-surface text-muted hover:border-edge-active hover:text-dim'}`}
    >
      <span aria-hidden className={`text-[11px] ${checked ? 'text-current' : 'text-muted/50'}`}>[</span>
      <span aria-hidden className={`h-1.5 w-1.5 ${checked ? dot : 'bg-edge-active'}`} />
      {label}{' '}
      {badge !== undefined && (
        <output className="font-mono text-[11px] text-current">{badge}</output>
      )}
      <span aria-hidden className={`text-[11px] ${checked ? 'text-current' : 'text-muted/50'}`}>]</span>
    </button>
  );
}

export default function ControlBar({
  connected, packets, truckCount,
  showTrucks, setShowTrucks,
  showRisk, setShowRisk,
  riskCount, riskLoading, threshold,
  showCorridors, setShowCorridors, corridorCount, corridorLoading,
}) {
  return (
    <header className="crt relative z-10 flex items-stretch border-b border-edge bg-panel">
      {/* Section 3.1: the wordmark is the one piece of macro typography in
          the chrome -- heavy, crushed tracking, welded into a block. */}
      <div className="flex flex-col justify-center border-r border-edge px-4 py-2">
        <h1 className="font-display text-[19px] font-black leading-none
                       tracking-crush text-phosphor">
          D.R.I.S.H.T.I.
        </h1>
        <span className="meta mt-1 leading-none">Command Center</span>
      </div>

      <div className="flex items-center gap-2 px-4">
        <span className="meta hidden lg:inline">Layers</span>
        <Toggle label="Trucks" checked={showTrucks} onChange={setShowTrucks}
                tone="live" badge={truckCount} />
        <Toggle
          label="Disruption Overlay"
          checked={showRisk}
          onChange={setShowRisk}
          tone="danger"
          badge={riskLoading ? '…' : riskCount}
        />
        <Toggle
          label="Corridors"
          checked={showCorridors}
          onChange={setShowCorridors}
          tone="route"
          badge={corridorLoading ? '…' : corridorCount}
        />
        {showRisk && (
          <span className="meta hidden xl:inline">
            &gt;&gt;&gt; risk &gt; {(threshold * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* telemetry readout */}
      <div className="ml-auto flex items-stretch">
        <div className="flex flex-col justify-center border-l border-edge px-4 py-2 text-right">
          <span className="meta leading-none">Ingest</span>
          <span className="mt-1 font-mono text-[11px] leading-none text-dim">
            {packets} packets
          </span>
        </div>

        <div className="flex items-center gap-2 border-l border-edge px-4 py-2">
          <span aria-hidden
                className={`h-2 w-2 ${connected ? 'bg-ok animate-pulse' : 'bg-danger'}`} />
          <span className={`font-mono text-[11px] uppercase tracking-term
                            ${connected ? 'text-ok' : 'text-danger-text'}`}>
            {connected ? 'Telemetry Live' : 'Disconnected'}
          </span>
        </div>
      </div>
    </header>
  );
}
