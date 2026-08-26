// <ActionDeck /> -- emergency command and control (Task 4).
//
// Two actions, and they are not peers:
//
//   Warn Driver       reversible, low consequence. One press.
//   Emergency Reroute closes a road for the ENTIRE fleet and pushes a new
//                     route to every truck already on it. Two presses.
//
// The arm/confirm on the second is not ceremony. Approving an incident sets
// its status to 'verified', which is what makes routable_edges cost that edge
// 999999 -- so this button is the moment a road physically closes for every
// pgr_astar call that follows. An accidental click has to be recoverable by
// someone noticing, and the only reliable way to make a click deliberate is to
// require a second one against a changed label. It is inline rather than a
// modal dialog because a modal that steals focus mid-incident is its own
// hazard; the armed state is announced through aria-live instead.
//
// Every result reports whether the command was actually DELIVERED. See
// lib/commands.js -- the backend has no dispatcher->driver relay today, and a
// button that reports success into a void is the worst thing this panel could
// do.
import React, { useState } from 'react';
import { useCommandStore } from '../store/commandStore';
import { warnDriver, emergencyReroute } from '../lib/commands';

/// Kept short on purpose: this is read aloud by the phone's TTS while the
/// driver is moving, and Bhashini translates it before it is spoken.
const PRESETS = [
  'Reduce speed. Hazard reported ahead.',
  'Stop at the next safe point and hold.',
  'Landslide ahead. Rerouting now.',
];

const LANGUAGES = [
  { code: 'as', label: 'Assamese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'en', label: 'English' },
];

export default function ActionDeck({ truck }) {
  const hazards = useCommandStore((s) => s.hazards);
  const queue = useCommandStore((s) => s.queue);

  const [message, setMessage] = useState(PRESETS[0]);
  // Defaults to the language recorded against the truck. That column exists so
  // the driver hears their own language; overriding it silently would defeat
  // the point, so it is pre-selected and still changeable.
  const [language, setLanguage] = useState(truck.alert_lang ?? 'en');
  const [busy, setBusy] = useState(null);
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState(null);

  // The hazard this reroute is about. A report still awaiting review is
  // preferred over an already-verified one, because approving it is the path
  // that actually reaches the driver (see lib/commands.js).
  const target = queue[0] ?? hazards[0] ?? null;

  const onWarn = async () => {
    setBusy('warn');
    setResult(null);
    const outcome = await warnDriver({
      truckId: truck.truck_id,
      text: message,
      language,
    });
    setResult({
      ok: outcome.delivered,
      text: outcome.delivered
        ? `Alert delivered to ${truck.plate ?? truck.truck_id.slice(0, 8)}`
        : outcome.reason,
    });
    setBusy(null);
  };

  const onReroute = async () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    setBusy('reroute');
    setResult(null);

    const outcome = await emergencyReroute({ truck, hazard: target });
    setResult({
      ok: outcome.ok,
      text: outcome.ok
        ? (outcome.mechanism === 'approve'
          ? 'Road closed and affected trucks rerouted'
          : outcome.plan?.note ?? 'Reroute pushed')
        : (outcome.reason ?? 'Reroute failed'),
    });
    setBusy(null);
  };

  return (
    <div className="border-t border-edge bg-surface">
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="meta">Action deck</h3>
        {target && (
          <span className="font-mono text-[10px] text-danger-text">
            target: {String(target.kind ?? 'hazard').toUpperCase()}
          </span>
        )}
      </div>

      {/* ---- warn driver ---- */}
      <div className="space-y-2 px-3 pb-3">
        <label className="block">
          <span className="meta">Message</span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={2}
            className="focus-ring mt-1 w-full resize-none border border-edge bg-inset px-2 py-1.5
                       font-mono text-[11px] leading-snug text-phosphor
                       placeholder:text-muted"
            placeholder="Spoken to the driver in the selected language"
          />
        </label>

        <div className="flex flex-wrap gap-px bg-edge">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setMessage(preset)}
              className="focus-ring min-h-[40px] flex-1 cursor-pointer bg-surface px-2 py-2
                         text-left font-mono text-[10px] leading-tight text-muted
                         transition-colors hover:bg-inset hover:text-dim"
            >
              {preset.split('.')[0]}
            </button>
          ))}
        </div>

        <label className="flex items-center justify-between gap-2">
          <span className="meta">Spoken in</span>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            className="focus-ring min-h-[var(--ctl-min-h)] cursor-pointer border border-edge
                       bg-inset px-3 font-mono text-[12px] text-phosphor"
          >
            {LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>{entry.label}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={onWarn}
          disabled={busy !== null || message.trim().length === 0}
          className="focus-ring glass-ctl w-full border border-signal/50 bg-signal/10
                     px-4 font-mono text-[12px] font-bold uppercase tracking-term
                     text-signal hover:bg-signal/20 hover:border-signal
                     disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'warn' ? 'Sending…' : 'Warn Driver'}
        </button>

        {/* ---- emergency reroute ---- */}
        <button
          type="button"
          onClick={onReroute}
          onBlur={() => setArmed(false)}
          disabled={busy !== null}
          aria-describedby="reroute-consequence"
          className={`focus-ring glass-ctl w-full px-4 font-mono text-[12px]
                      font-bold uppercase tracking-term
                      disabled:cursor-not-allowed disabled:opacity-40 ${
            armed
              ? 'hazard-stripe border border-danger text-phosphor'
              : 'bg-approve text-phosphor hover:bg-approve-hot'}`}
        >
          {busy === 'reroute'
            ? 'Rerouting…'
            : armed ? 'Confirm — close road' : 'Emergency Reroute'}
        </button>

        <p id="reroute-consequence" className="font-mono text-[10px] leading-relaxed text-muted">
          {armed
            ? 'This closes the road for every truck and pushes new routes. Click again to commit, or click away to cancel.'
            : target
              ? `Blocks edge ${target.blocked_edge ?? '—'} and reroutes all affected trips.`
              : 'No active hazard to route around.'}
        </p>

        {/* aria-live, not role="alert": this must be announced without
            stealing focus from the button the dispatcher is still on. */}
        <div aria-live="polite" className="min-h-0">
          {result && (
            <p className={`border-l-2 px-2 py-1.5 font-mono text-[10px] leading-relaxed ${
              result.ok
                ? 'border-ok bg-ok/10 text-ok'
                : 'border-danger bg-danger/10 text-danger-text'}`}>
              {result.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
