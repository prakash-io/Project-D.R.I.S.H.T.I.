// Incident review (WEB-05).
//
// This panel is the safety valve the whole incident pipeline is built around.
// The vision model has no "no incident" class and was trained on satellite and
// aerial imagery while drivers send ground-level photos, so its verdict is
// evidence, not authority. Nothing here closes a road until a person clicks.
import React, { useState } from 'react';
import { incidentPhotoUrl } from '../lib/api';

const KIND_LABEL = {
  landslide: 'Landslide',
  flood: 'Flood',
  obstruction: 'Obstruction',
};

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
    <aside className="w-[380px] shrink-0 border-l border-edge bg-panel flex flex-col h-full">
      <header className="px-4 py-3 border-b border-edge">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">
          INCIDENT REVIEW
        </h2>
        <p className="text-xs text-muted mt-1">
          {incidents.length === 0
            ? 'No reports awaiting a decision.'
            : `${incidents.length} awaiting approval — no road is blocked until you approve.`}
        </p>
      </header>

      {error && (
        <div className="mx-4 mt-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {lastResult && (
        <div className={`mx-4 mt-3 rounded px-3 py-2 text-xs border ${
          lastResult.ok
            ? 'border-ok/40 bg-ok/10 text-ok'
            : 'border-danger/40 bg-danger/10 text-danger'}`}>
          {lastResult.text}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {incidents.map((incident) => (
          <article key={incident.id}
                   className="rounded-lg border border-edge bg-surface overflow-hidden">
            {incident.has_photo ? (
              <img
                src={incidentPhotoUrl(incident.id)}
                alt="Driver's report"
                className="w-full h-40 object-cover bg-black"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-40 grid place-items-center bg-black/40 text-xs text-muted">
                no photo stored
              </div>
            )}

            <div className="p-3 space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-slate-100">
                  {KIND_LABEL[incident.kind] ?? incident.kind}
                </span>
                <span className="text-xs font-mono text-muted">
                  {Number(incident.lat).toFixed(4)}, {Number(incident.lng).toFixed(4)}
                </span>
              </div>

              <dl className="text-xs space-y-1">
                <div className="flex justify-between">
                  <dt className="text-muted">AI class</dt>
                  <dd className="font-mono text-slate-300">{incident.ai_class ?? '—'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Confidence</dt>
                  <dd className="font-mono text-slate-300">
                    {incident.confidence == null
                      ? '—'
                      : `${(Number(incident.confidence) * 100).toFixed(1)}%`}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Blocks edge</dt>
                  <dd className="font-mono text-slate-300">{incident.blocked_edge ?? '—'}</dd>
                </div>
              </dl>

              {/* Stated on every card, not buried in documentation: the person
                  clicking Approve is the reason this step exists. */}
              <p className="text-[11px] leading-snug text-warn/90 border-l-2 border-warn/50 pl-2">
                Model verdict only. It cannot recognise “nothing wrong here”.
                Check the photo before closing the road.
              </p>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={busyId === incident.id}
                  onClick={() => onApprove(incident)}
                  className="flex-1 rounded bg-danger/90 hover:bg-danger disabled:opacity-40
                             px-3 py-2 text-xs font-semibold text-white transition"
                >
                  {busyId === incident.id ? 'Approving…' : 'Approve Reroute'}
                </button>
                <button
                  type="button"
                  disabled={busyId === incident.id}
                  onClick={() => reject(incident.id)}
                  className="rounded border border-edge hover:bg-surface disabled:opacity-40
                             px-3 py-2 text-xs text-muted transition"
                >
                  Reject
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}
