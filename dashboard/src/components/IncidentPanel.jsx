// Incident review (WEB-05).
//
// This panel is the safety valve the whole incident pipeline is built around.
// The vision model has no "no incident" class and was trained on satellite and
// aerial imagery while drivers send ground-level photos, so its verdict is
// evidence, not authority. Nothing here closes a road until a person clicks.
//
// Frozen strings: "<n> awaiting approval", the Approve button's leading text,
// and the "Edge <n> blocked" result line. verify.mjs asserts on all three --
// and it requires the button's trimmed textContent to START with "Approve
// Reroute", so no ASCII decoration may precede that label inside the button.
import React, { useState } from 'react';
import { incidentPhotoUrl } from '../lib/api';

const KIND_LABEL = {
  landslide: 'Landslide',
  flood: 'Flood',
  obstruction: 'Obstruction',
};

// Section 6: a segmented bar, not a smooth progress fill. Confidence is
// quantised into cells so it reads as an instrument, and so a 99% verdict
// cannot be mistaken for a full meter at a glance.
function ConfidenceMeter({ value }) {
  if (value == null) return <span className="font-mono text-[11px] text-muted">—</span>;
  const cells = 10;
  const lit = Math.round(Number(value) * cells);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="flex gap-[2px]">
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} className={`h-2.5 w-1 ${i < lit ? 'bg-danger' : 'bg-inset'}`} />
        ))}
      </span>
      <span className="font-mono text-[11px] text-phosphor">
        {(Number(value) * 100).toFixed(1)}%
      </span>
    </span>
  );
}

function Row({ term, children }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <dt className="meta">{term}</dt>
      <dd className="font-mono text-[11px] text-dim">{children}</dd>
    </div>
  );
}

export default function IncidentPanel({ incidents, approve, reject, busyId, error }) {
  const [lastResult, setLastResult] = useState(null);

  const onApprove = async (incident) => {
    try {
      const result = await approve(incident.id);
      setLastResult({
        ok: true,
        text: `Edge ${result.incident.blocked_edge} blocked · `
          + `${result.reroutes.length} truck(s) rerouted`,
      });
    } catch (e) {
      setLastResult({ ok: false, text: e.message });
    }
  };

  return (
    <aside className="crt relative flex h-full w-[380px] shrink-0 flex-col
                      border-l border-edge bg-panel">
      <header className="border-b border-edge px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-[15px] font-black uppercase
                         leading-none tracking-crush text-phosphor">
            Incident Review
          </h2>
          <span className="meta">WEB&ndash;05</span>
        </div>
        <p className="mt-2 font-mono text-[11px] leading-snug text-muted">
          {incidents.length === 0
            ? 'No reports awaiting a decision.'
            : `${incidents.length} awaiting approval — no road is blocked until you approve.`}
        </p>
      </header>

      {error && (
        <div className="mx-4 mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2
                        font-mono text-[11px] text-danger-text" role="alert">
          {error}
        </div>
      )}
      {lastResult && (
        <div className={`mx-4 mt-3 border-l-2 px-3 py-2 font-mono text-[11px] ${
          lastResult.ok
            ? 'border-ok bg-ok/10 text-ok'
            : 'border-danger bg-danger/10 text-danger-text'}`}
          role="status" aria-live="polite">
          {lastResult.text}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {incidents.length === 0 && (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <div aria-hidden className="font-mono text-[22px] text-edge-active">+</div>
              <p className="meta mt-3 leading-relaxed">
                Queue empty
                <br />
                Standing by
              </p>
            </div>
          </div>
        )}

        <div className="space-y-px bg-edge">
          {incidents.map((incident) => (
            <article key={incident.id} className="bg-surface">
              {/* photo: the evidence the dispatcher is actually judging */}
              <div className="relative border-b border-edge">
                {incident.has_photo ? (
                  <img
                    src={incidentPhotoUrl(incident.id)}
                    alt="Driver's report"
                    className="h-40 w-full bg-black object-cover contrast-125 saturate-[0.85]"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid h-40 w-full place-items-center bg-black/40">
                    <span className="meta">no photo stored</span>
                  </div>
                )}
                {/* Section 7: scanlines over the still, so driver evidence
                    reads as a capture off a device rather than a stock photo. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(0deg, transparent 0 2px, rgb(0 0 0 / 0.22) 2px 3px)',
                  }}
                />
                <div className="absolute left-0 top-0 bg-panel/90 px-2 py-1">
                  <span className="font-mono text-[10px] uppercase tracking-term text-phosphor">
                    {KIND_LABEL[incident.kind] ?? incident.kind}
                  </span>
                </div>
                <div className="absolute bottom-0 right-0 bg-panel/90 px-2 py-1">
                  <span className="font-mono text-[10px] text-muted">
                    {Number(incident.lat).toFixed(4)}, {Number(incident.lng).toFixed(4)}
                  </span>
                </div>
              </div>

              <dl className="divide-y divide-edge/60">
                <Row term="AI class">{incident.ai_class ?? '—'}</Row>
                <Row term="Confidence"><ConfidenceMeter value={incident.confidence} /></Row>
                <Row term="Blocks edge">{incident.blocked_edge ?? '—'}</Row>
              </dl>

              {/* Stated on every card, not buried in documentation: the person
                  clicking Approve is the reason this step exists. */}
              <div className="mx-3 mt-3 border-l-2 border-warn bg-warn/5 px-3 py-2">
                <p className="font-mono text-[10px] leading-relaxed text-warn">
                  Model verdict only. It cannot recognise “nothing wrong here”.
                  Check the photo before closing the road.
                </p>
              </div>

              <div className="flex gap-px bg-edge p-3">
                <button
                  type="button"
                  disabled={busyId === incident.id}
                  onClick={() => onApprove(incident)}
                  className="focus-ring flex-1 bg-approve px-3 py-2.5 font-mono
                             text-[11px] font-bold uppercase tracking-term text-phosphor
                             transition-colors hover:bg-approve-hot disabled:opacity-40"
                >
                  {busyId === incident.id ? 'Approving…' : 'Approve Reroute'}
                </button>
                <button
                  type="button"
                  disabled={busyId === incident.id}
                  onClick={() => reject(incident.id)}
                  className="focus-ring border border-edge-active bg-surface px-3 py-2.5
                             font-mono text-[11px] uppercase tracking-term text-muted
                             transition-colors hover:border-muted hover:text-dim
                             disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </aside>
  );
}
