// <StatusBar /> -- the link readout, floating over the top of the map.
//
// This is the first thing a dispatcher checks and the thing they check again
// when something looks wrong, so it says exactly one thing clearly: is
// telemetry arriving right now. "Connected" is deliberately not enough -- a
// socket can be open while no packet has landed for a minute, and that is a
// real failure that reads as a quiet shift. So the packet counter and the
// seconds-since-last-packet are both here, and the indicator goes amber on
// silence even while the socket is up.
import React, { useEffect, useState } from 'react';
import { useCommandStore } from '../store/commandStore';
import { shallow } from '../store/createStore';

/// Eight missed packets at 1 Hz. Past coincidence.
const SILENT_AFTER_MS = 8000;

export default function StatusBar() {
  const link = useCommandStore(
    (s) => ({
      connected: s.link.connected,
      packets: s.link.packets,
      lastPacketAt: s.link.lastPacketAt,
      error: s.link.error,
    }),
    shallow,
  );
  const queueCount = useCommandStore((s) => s.queue.length);
  const hazardCount = useCommandStore((s) => s.hazards.length);

  // Drives the "Xs ago" readout. One second is the natural granularity for a
  // 1 Hz stream, and anything faster would tick a digit nobody can read.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const silentMs = link.lastPacketAt ? Date.now() - link.lastPacketAt : null;
  const silent = silentMs !== null && silentMs > SILENT_AFTER_MS;
  const state = !link.connected ? 'down' : silent ? 'silent' : 'live';

  const dot = {
    live: 'bg-ok pulse-dot',
    silent: 'bg-warn',
    down: 'bg-danger',
  }[state];

  const label = {
    live: 'Telemetry live',
    silent: 'Connected — no packets',
    down: 'Link down',
  }[state];

  return (
    <header
      className="glass pointer-events-auto absolute left-3 right-3 top-3 z-20
                 flex items-center justify-between gap-4 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="shrink-0 font-display text-[14px] font-black uppercase leading-none
                       tracking-crush text-phosphor">
          D.R.I.S.H.T.I.
        </h1>
        <span aria-hidden className="h-4 w-px shrink-0 bg-edge-active" />
        <span className="meta shrink-0">Level&ndash;1 Command</span>
      </div>

      <div className="flex shrink-0 items-center gap-4">
        {queueCount > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-term text-warn">
            {queueCount} awaiting review
          </span>
        )}
        {hazardCount > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-term text-danger-text">
            {hazardCount} road{hazardCount === 1 ? '' : 's'} blocked
          </span>
        )}

        {/* "packets", spelled out: verify.mjs greps the rendered innerText for
            /(\d+)\s+packets/ to prove the stream is flowing, and an
            abbreviation here silently breaks the regression gate. */}
        <span className="font-mono text-[10px] tabular-nums text-muted">
          {link.packets.toLocaleString()} packets
        </span>
        {silentMs !== null && (
          <span className={`font-mono text-[10px] tabular-nums ${silent ? 'text-warn' : 'text-muted'}`}>
            {(silentMs / 1000).toFixed(0)}s ago
          </span>
        )}

        {/* The status itself. aria-live so a link drop is announced rather
            than only appearing in the corner of a screen nobody is watching. */}
        <span
          aria-live="polite"
          className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-term"
        >
          <span aria-hidden className={`h-2 w-2 shrink-0 ${dot}`} />
          <span className={state === 'live' ? 'text-ok' : state === 'silent' ? 'text-warn' : 'text-danger-text'}>
            {label}
          </span>
        </span>
      </div>
    </header>
  );
}
