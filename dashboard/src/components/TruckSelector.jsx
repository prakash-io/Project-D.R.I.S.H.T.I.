// Find a truck, then open its deep-dive (task 1).
//
// A search field AND a grid of boxes, not one or the other. They answer two
// different questions: the grid answers "what is out there", which is what a
// dispatcher arriving at the page is asking, and the field answers "where is
// AS01-DEMO-2", which is what they ask when a driver is on the radio. A grid
// alone stops working somewhere past twenty vehicles; a field alone requires
// you to already know the answer.
//
// Each box carries the truck's own colour, from lib/truckColors -- the same
// function the deck.gl model and the 2D dot call. That is what makes this a
// legend as well as a control: a dispatcher who has just seen a violet truck
// on the map can find the violet box without reading a single plate.
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { truckHex, truckRgba } from '../lib/truckColors';

export default function TruckSelector({ fleet, loading, error }) {
  const navigate = useNavigate();
  const [queryText, setQueryText] = useState('');

  const rows = useMemo(() => {
    const needle = queryText.trim().toLowerCase();
    if (!needle) return fleet;
    // Matched against the id as well as the plate and driver, because the id
    // is what the URL carries and what a colleague pastes into chat.
    return fleet.filter((t) => (
      String(t.plate ?? '').toLowerCase().includes(needle)
      || String(t.driver_name ?? '').toLowerCase().includes(needle)
      || String(t.id ?? '').toLowerCase().includes(needle)
    ));
  }, [fleet, queryText]);

  const liveCount = fleet.filter((t) => t.live).length;

  return (
    <section className="border border-edge bg-panel/60">
      <header className="border-b border-edge px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-[13px] tracking-crush text-phosphor">
            TRUCK ID
          </h2>
          <span className="meta shrink-0">
            {liveCount}/{fleet.length} live
          </span>
        </div>
        <p className="meta mt-1 normal-case tracking-normal">
          Search or pick a unit to open its route, driver and forecast.
        </p>
      </header>

      <div className="p-4">
        <label className="sr-only" htmlFor="truck-search">Search truck ID</label>
        <input
          id="truck-search"
          type="search"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder="Plate, driver or ID…"
          autoComplete="off"
          className="focus-ring w-full border border-edge bg-inset px-3 py-2
                     font-mono text-[11px] text-phosphor placeholder:text-muted"
        />

        {error && (
          <p className="meta mt-3 text-danger-text">Fleet list unavailable — {error}</p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
          {rows.map((truck) => (
            <TruckBox
              key={truck.id}
              truck={truck}
              onOpen={() => navigate(`/analytics/${truck.id}`)}
            />
          ))}
        </div>

        {rows.length === 0 && (
          <p className="meta mt-3">
            {loading
              ? 'Loading fleet…'
              : (queryText ? 'No unit matches that' : 'No units registered')}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * One clickable unit.
 *
 * A real <button>, not a div with an onClick: this grid is the primary
 * navigation into the deep-dive, and it has to be reachable by keyboard and
 * announced as a control. The colour is carried on a left bar and a tinted
 * ground rather than as the text colour -- an arbitrary generated hue is
 * guaranteed 4.5:1 as a FILL on this substrate, but not as 11px type.
 */
function TruckBox({ truck, onOpen }) {
  const hex = truckHex(truck.id);
  const dr = truck.source === 'ekf';

  return (
    <button
      type="button"
      onClick={onOpen}
      title={truck.id}
      className="focus-ring group relative flex flex-col items-start gap-1
                 border border-edge bg-inset/60 px-2.5 py-2 text-left
                 transition-colors hover:border-edge-active hover:bg-inset"
      style={{ backgroundImage: `linear-gradient(90deg, ${truckRgba(truck.id, 0.14)}, transparent 60%)` }}
      aria-label={`Open analytics for ${truck.plate ?? truck.id}`}
    >
      {/* The swatch. Same colour the map draws this truck in. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: hex }}
      />

      <span className="flex w-full items-center gap-1.5 pl-1.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: hex }}
        />
        <span className="truncate font-mono text-[11px] text-phosphor">
          {truck.plate ?? String(truck.id).slice(0, 8)}
        </span>
      </span>

      <span className="flex w-full items-center gap-1.5 pl-1.5">
        {/* Live state and fix source, in words as well as colour. The whole
            console refuses to encode this one in hue alone. */}
        <span className={`meta truncate ${truck.live ? (dr ? 'text-warn' : 'text-live') : ''}`}>
          {truck.live ? (dr ? 'DEAD REC' : 'GNSS') : 'IDLE'}
        </span>
      </span>
    </button>
  );
}
