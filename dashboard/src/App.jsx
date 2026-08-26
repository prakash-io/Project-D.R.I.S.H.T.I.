// D.R.I.S.H.T.I. Level-1 Command Dashboard (Deliverable 1).
//
// -------------------------------------------------------------------------
// LAYOUT
// -------------------------------------------------------------------------
// The map is not a panel in a grid -- it is the substrate, full-bleed behind
// everything, and every control floats over it:
//
//     +-----------------------------------------------------------+
//     | StatusBar .............................. (floating, top)   |
//     |                                                            |
//     |                                        +-----------------+ |
//     |            CommandMap                  |  Floating       | |
//     |            (absolute inset-0)          |  sidebar        | |
//     |                                        |  - Transponder  | |
//     |                                        |  - Review       | |
//     |                                        |  - Layers       | |
//     |        [basemap switch]                +-----------------+ |
//     +-----------------------------------------------------------+
//
// The previous layout docked the panels beside the map, which cost the map
// roughly a third of its width permanently. For a dispatcher the map IS the
// job -- a truck's position relative to a landslide is spatial information
// that a list cannot carry -- so the panels float and can be collapsed away
// entirely, and the map keeps every pixel underneath them.
//
// The cost of floating is legibility: a panel now sits over live terrain
// instead of a known background. That is what the `.glass` material in
// index.css pays for -- a heavy backdrop blur destroys the detail underneath
// thoroughly enough that the surface can stay genuinely translucent and still
// hold body text above 4.5:1. See tokens.css for the measurement.
//
// -------------------------------------------------------------------------
// STATE
// -------------------------------------------------------------------------
// Two hooks, mounted exactly once, here:
//
//   useCommandSocket()    the single Socket.IO connection + the frame loop
//   useDispatcherFeeds()  the REST snapshots that make a reload correct
//
// Nothing below this component opens a connection or fetches. Every panel
// reads commandStore with a selector, which is what lets the fleet roster
// re-render on a packet without the incident queue re-rendering with it.
import React, { useState } from 'react';

import CommandMap from './components/CommandMap';
import StatusBar from './components/StatusBar';
import AlertStack from './components/AlertStack';
import TransponderPanel from './components/TransponderPanel';
import IncidentPanel from './components/IncidentPanel';
import DisruptionOverlay from './components/DisruptionOverlay';

import { useCommandSocket } from './hooks/useCommandSocket';
import { useDispatcherFeeds } from './hooks/useDispatcherFeeds';
import { useCommandStore } from './store/commandStore';

const TABS = [
  { id: 'fleet', label: 'Transponder' },
  { id: 'review', label: 'Review' },
  { id: 'layers', label: 'Layers' },
];

export default function App() {
  useCommandSocket();
  useDispatcherFeeds();

  const [tab, setTab] = useState('fleet');
  const [open, setOpen] = useState(true);
  const queueCount = useCommandStore((s) => s.queue.length);

  return (
    // `grain` lays one global noise field over every compartment, so the
    // floating panels and the map read as one physical surface rather than as
    // chrome pasted onto a screenshot.
    <div className="grain relative h-full overflow-hidden bg-base">
      {/* Keyboard users land here first: the map is a canvas with no tab
          stops, so without this the first Tab press walks the entire sidebar
          before reaching anything actionable. */}
      <a
        href="#command-sidebar"
        className="focus-ring sr-only left-3 top-3 z-50 bg-panel px-3 py-2 font-mono
                   text-[11px] text-phosphor focus:not-sr-only focus:absolute"
      >
        Skip to command panels
      </a>

      <CommandMap />
      <StatusBar />
      <AlertStack />

      {/* ---------------------------------------------------------- sidebar
          Fixed width on desktop, full-width sheet under 640px. Bounded by
          max-height so a long incident queue scrolls inside the panel instead
          of growing past the viewport and hiding its own Approve buttons. */}
      <aside
        id="command-sidebar"
        aria-label="Command panels"
        className={`absolute bottom-3 right-3 top-[4.25rem] z-20 flex w-[min(360px,calc(100vw-1.5rem))]
                    flex-col transition-transform duration-200
                    motion-reduce:transition-none
                    ${open ? 'translate-x-0' : 'translate-x-[calc(100%+0.75rem)]'}`}
      >
        <div className="glass glass-clip crt relative flex min-h-0 flex-1 flex-col">
          {/* tabs */}
          <div role="tablist" aria-label="Command panels" className="flex shrink-0 gap-px bg-edge">
            {TABS.map((entry) => {
              const active = tab === entry.id;
              return (
                <button
                  key={entry.id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  aria-controls={`panel-${entry.id}`}
                  id={`tab-${entry.id}`}
                  onClick={() => setTab(entry.id)}
                  className={`focus-ring relative flex-1 cursor-pointer px-2 font-mono
                              text-[11px] uppercase tracking-term transition-colors
                              min-h-[var(--ctl-min-h)] ${
                    active
                      ? 'bg-inset text-phosphor'
                      : 'bg-panel/60 text-muted hover:bg-inset/60 hover:text-dim'}`}
                >
                  {entry.label}
                  {entry.id === 'review' && queueCount > 0 && (
                    <span
                      // The count is inside the tab's own label text, so a
                      // screen reader announces "Review, 3 awaiting" as one
                      // string rather than reading a floating number.
                      className="ml-1.5 bg-danger px-1 py-px text-[9px] font-bold text-phosphor"
                    >
                      {queueCount}
                    </span>
                  )}
                  {active && (
                    <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-signal" />
                  )}
                </button>
              );
            })}
          </div>

          {/* panels. Kept mounted rather than swapped, so switching tabs does
              not discard a half-typed driver warning or reset the roster
              scroll position mid-incident. */}
          <div className="min-h-0 flex-1">
            <Panel id="fleet" active={tab === 'fleet'}><TransponderPanel /></Panel>
            <Panel id="review" active={tab === 'review'}><IncidentPanel /></Panel>
            <Panel id="layers" active={tab === 'layers'}><DisruptionOverlay /></Panel>
          </div>
        </div>
      </aside>

      {/* Collapse handle. Sits outside the sliding panel so it stays reachable
          when the panel is off-screen. */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="command-sidebar"
        className={`focus-ring glass glass-ctl absolute top-1/2 z-30 -translate-y-1/2
                    w-9 px-0 py-5 font-mono text-[14px] text-muted transition-all
                    duration-200 hover:text-phosphor motion-reduce:transition-none
                    ${open ? 'right-[calc(min(360px,100vw-1.5rem)+0.75rem)]' : 'right-3'}`}
      >
        <span aria-hidden>{open ? '›' : '‹'}</span>
        <span className="sr-only">{open ? 'Collapse command panels' : 'Expand command panels'}</span>
      </button>
    </div>
  );
}

/**
 * A tab panel that stays mounted while hidden.
 *
 * `hidden` rather than unmounting: it removes the subtree from the
 * accessibility tree and the tab order exactly like unmounting would, while
 * keeping component state alive. A dispatcher who tabs to Layers to switch on
 * the risk overlay and comes back must find their warning message still typed.
 */
function Panel({ id, active, children }) {
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      className={active ? 'h-full' : ''}
    >
      {children}
    </div>
  );
}
