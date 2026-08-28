// Which colour is which truck, on the map itself (task 3).
//
// The 3D models and the 2D anchor dots are now one colour per vehicle, and a
// colour encoding with no key is decoration. This is the key. It reads its
// swatches from lib/truckColors -- the same function the deck.gl accessors
// call -- so it cannot drift from the map beside it; that shared call is the
// entire mechanism, and any legend that hard-coded a list would be wrong the
// first time the fleet changed.
//
// Live units only. The roster's idle trucks are not drawn on the map, so a
// legend entry for one would be a key to a symbol that is not there.
//
// Deliberately does NOT contain the word "Trucks" followed by a count.
// verify.mjs reads the fleet size out of `document.body.innerText` with
// /Trucks\s*(\d+)/ and takes the FIRST match on the page; this panel sits
// above the control bar in the DOM, so a heading of that shape here would
// silently answer the console's own end-to-end check.
import React from 'react';
import { truckHex } from '../lib/truckColors';

/// Past this the legend is taller than the map is useful. The fleet is small
/// by design (a demonstrator), and a console running a real fleet would want
/// filtering here rather than a longer list.
const MAX_ROWS = 8;

export default function FleetLegend({ trucks, selectedId, onSelect }) {
  if (!trucks || trucks.length === 0) return null;

  const rows = trucks.slice(0, MAX_ROWS);
  const hidden = trucks.length - rows.length;

  return (
    <div className="absolute right-4 top-4 w-[176px] border border-edge
                    bg-panel/95 backdrop-blur">
      <header className="border-b border-edge px-2.5 py-1.5">
        <h2 className="font-mono text-[10px] uppercase tracking-term text-muted">
          Fleet key
        </h2>
      </header>

      <ul>
        {rows.map((truck) => {
          const dr = truck.source === 'ekf';
          const selected = truck.truck_id === selectedId;
          return (
            <li key={truck.truck_id}>
              <button
                type="button"
                onClick={() => onSelect?.(truck)}
                aria-pressed={selected}
                title={truck.truck_id}
                className={`focus-ring flex w-full items-center gap-2 px-2.5 py-1
                            text-left transition-colors hover:bg-inset
                            ${selected ? 'bg-inset' : ''}`}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full border"
                  style={{
                    backgroundColor: truckHex(truck.truck_id),
                    // The ring repeats the map's own encoding: identity in the
                    // fill, fix source in the outline. A dispatcher comparing
                    // this key to a marker is comparing both channels.
                    borderColor: dr ? '#D29922' : '#0D1117',
                  }}
                />
                <span className="truncate font-mono text-[10px] text-dim">
                  {String(truck.truck_id).slice(0, 8)}
                </span>
                {/* Never colour alone. */}
                <span className={`ml-auto shrink-0 font-mono text-[9px] uppercase
                                  tracking-term ${dr ? 'text-warn' : 'text-live'}`}>
                  {dr ? 'DR' : 'FIX'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && (
        <p className="border-t border-edge px-2.5 py-1 font-mono text-[9px] text-muted">
          +{hidden} more
        </p>
      )}
    </div>
  );
}
