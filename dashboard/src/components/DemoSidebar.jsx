// Demonstration route picker (WEB-02).
//
// Six preset NER journeys. Clicking one POSTs to /routes/plan, which runs
// pgr_astar over `routable_edges` and returns the geometry the map then
// draws -- the route is planned on the spot, not replayed from the corridors
// table, so the button demonstrates the engine rather than a fixture.
//
// Deliberately avoids the literal word "Corridors" followed by a count, and
// the strings "Trucks", "packets", "Disruption Overlay" and "awaiting
// approval". verify.mjs matches those against document.body.innerText and
// takes the FIRST match in document order -- this panel sits upstream of the
// control bar, so any of them here would shadow the real readout.
import React from 'react';

/// 95164 -> "95.2 km". Sub-kilometre never occurs on these routes, but a
/// route that failed to plan should not print "0.0 km" as though it had.
function km(metres) {
  return Number.isFinite(metres) ? `${(metres / 1000).toFixed(1)} km` : '—';
}

function RouteButton({ corridor, active, pending, disabled, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(corridor)}
      disabled={disabled}
      aria-pressed={active}
      className={`focus-ring group relative block w-full px-3 py-2.5 text-left
                  transition-colors disabled:cursor-wait
                  ${active ? 'bg-inset' : 'bg-panel hover:bg-surface'}`}
    >
      {/* Selection marker in the gutter rather than a border swap: a border
          would shift the text by a pixel as it toggles. */}
      <span
        aria-hidden
        className={`absolute left-0 top-0 h-full w-[2px]
                    ${active ? 'bg-phosphor' : 'bg-transparent'}`}
      />

      <div className="flex items-baseline justify-between gap-2">
        <span className={`truncate font-mono text-[11px]
                          ${active ? 'text-phosphor' : 'text-dim group-hover:text-phosphor'}`}>
          {corridor.origin_name} → {corridor.destination_name}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <span className="meta">{km(corridor.distance_m)}</span>
        <span aria-hidden className="text-[10px] text-edge-active">·</span>
        <span className="meta">
          {pending ? 'planning…' : `${corridor.edge_count ?? 0} edges`}
        </span>
      </div>
    </button>
  );
}

export default function DemoSidebar({
  corridors, loading, route, pendingId, error, onSelect, onClear,
}) {
  const busy = pendingId !== null;

  return (
    <aside
      aria-label="Demonstration routes"
      className="crt flex w-[212px] shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="border-b border-edge px-3 py-2.5">
        <h2 className="font-display text-[11px] font-black uppercase
                       tracking-crush text-phosphor">
          Demo Routes
        </h2>
        <p className="meta mt-1 leading-none">pgr_astar · live plan</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="meta px-3 py-3">loading…</p>
        ) : corridors.length === 0 ? (
          <p className="meta px-3 py-3">none seeded</p>
        ) : (
          <div className="hairgrid">
            {corridors.map((c) => (
              <RouteButton
                key={c.id}
                corridor={c}
                active={route?.id === c.id}
                pending={pendingId === c.id}
                // Only the in-flight button is disabled, not the whole list:
                // the sequence guard in useDemoRoute already makes a second
                // click safe, and locking the panel for 810 ms on the long
                // routes reads as a frozen console.
                disabled={pendingId === c.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>

      {error ? (
        <div className="border-t border-edge bg-danger/15 px-3 py-2">
          <p className="meta text-danger-text">plan failed</p>
          <p className="mt-1 font-mono text-[10px] leading-tight text-dim">{error}</p>
        </div>
      ) : null}

      {/* The result of the plan that is currently drawn. Distance comes from
          the planner's own ST_Length sum, not from the corridors table, so
          it describes the line actually on the map. */}
      {route ? (
        <div className="border-t border-edge px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="meta">Planned</span>
            <button
              type="button"
              onClick={onClear}
              className="focus-ring font-mono text-[10px] uppercase tracking-term
                         text-muted transition-colors hover:text-phosphor"
            >
              clear
            </button>
          </div>
          <output className="mt-1.5 block font-mono text-[15px] leading-none text-phosphor">
            {km(route.distance_m)}
          </output>
          <p className="meta mt-1.5 leading-none">{route.edge_count} edges routed</p>
        </div>
      ) : (
        <div className="border-t border-edge px-3 py-2.5">
          <p className="meta leading-tight">
            {busy ? 'routing…' : 'select a route'}
          </p>
        </div>
      )}
    </aside>
  );
}
