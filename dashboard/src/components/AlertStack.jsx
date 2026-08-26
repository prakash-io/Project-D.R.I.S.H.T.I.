// <AlertStack /> -- hazard and command banners over the map.
//
// A driver reporting a landslide has to interrupt whatever the dispatcher is
// doing; a burst sync finishing does not. So `sticky` alerts (a road actually
// closing) stay until dismissed, and everything else clears itself after a few
// seconds. Both are announced through one aria-live region rather than
// role="alert", because stealing focus from a dispatcher mid-action is a worse
// outcome than a slightly delayed announcement.
import React, { useEffect } from 'react';
import { useCommandStore } from '../store/commandStore';

/// Long enough to read two lines of monospace without rushing, short enough
/// that a run of routine events does not build a wall over the map.
const DISMISS_MS = 6000;

const TONE = {
  critical: 'border-l-danger bg-danger/12 text-danger-text',
  warn: 'border-l-warn bg-warn/12 text-warn',
  info: 'border-l-signal bg-signal/12 text-signal',
};

function Alert({ alert, onDismiss }) {
  useEffect(() => {
    if (alert.sticky) return undefined;
    const timer = setTimeout(() => onDismiss(alert.id), DISMISS_MS);
    return () => clearTimeout(timer);
  }, [alert.id, alert.sticky, onDismiss]);

  return (
    <div
      className={`glass pointer-events-auto flex items-start gap-3 border-l-2 px-3 py-2.5
                  ${TONE[alert.tone] ?? TONE.info}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[11px] font-bold uppercase tracking-term">
          {alert.title}
        </p>
        {alert.body && (
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-dim">{alert.body}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(alert.id)}
        aria-label={`Dismiss: ${alert.title}`}
        // Padded well beyond the glyph: the visual mark is 10px, the hit area
        // is not.
        className="focus-ring -m-1 cursor-pointer p-1 font-mono text-[11px] leading-none
                   text-muted transition-colors hover:text-phosphor"
      >
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}

export default function AlertStack() {
  const alerts = useCommandStore((s) => s.alerts);
  const dismissAlert = useCommandStore((s) => s.dismissAlert);

  return (
    <div
      aria-live="polite"
      aria-label="Command alerts"
      // Below the StatusBar, not over it: the link indicator is the one thing
      // on this screen that must never be occluded, and a stack of banners
      // landing on top of it hides exactly the readout a dispatcher checks
      // when something looks wrong.
      //
      // pointer-events-none on the container so the map stays draggable
      // through the gaps; each banner re-enables them for itself.
      // Left-aligned rather than centred: the sidebar occupies the right edge,
      // and a centred stack runs underneath it as soon as the viewport is
      // narrow enough that half the width reaches past the panel.
      className="pointer-events-none absolute left-3 top-[4.25rem] z-30
                 flex w-[min(420px,calc(100vw-380px-1.5rem))] flex-col gap-2"
    >
      {alerts.map((alert) => (
        <Alert key={alert.id} alert={alert} onDismiss={dismissAlert} />
      ))}
    </div>
  );
}
