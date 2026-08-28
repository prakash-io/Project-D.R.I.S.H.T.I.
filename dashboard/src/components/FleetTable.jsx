// The fleet as a table — the left column of /analytics.
//
// The selector on the right answers "which truck do I want"; this answers
// "what is the fleet doing", which is a different question and wants a
// different shape. A grid of boxes cannot show driver, speed and last-seen
// side by side without becoming a table badly, so it is a table.
//
// It is also the accessible view of the colour encoding. The map and the
// selector both carry identity in a swatch; here the swatch sits in a row that
// also names the plate, the driver and the state in words, so nothing on this
// page depends on being able to tell two hues apart.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { truckHex } from '../lib/truckColors';

export default function FleetTable({ fleet, loading, error }) {
  const navigate = useNavigate();

  return (
    <section className="border border-edge bg-panel/60">
      <header className="border-b border-edge px-4 py-3">
        <h2 className="font-display text-[13px] tracking-crush text-phosphor">
          FLEET DETAIL
        </h2>
        <p className="meta mt-1 normal-case tracking-normal">
          Every registered unit. Click a row for its route, driver and forecast.
        </p>
      </header>

      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-panel">
            <tr className="border-b border-edge text-left">
              <th className="meta px-3 py-2 font-normal">Unit</th>
              <th className="meta px-3 py-2 font-normal">Driver</th>
              <th className="meta px-3 py-2 font-normal">State</th>
              <th className="meta px-3 py-2 text-right font-normal">Speed</th>
              <th className="meta px-3 py-2 text-right font-normal">Last fix</th>
            </tr>
          </thead>
          <tbody>
            {fleet.map((truck) => {
              const dr = truck.source === 'ekf';
              return (
                <tr
                  key={truck.id}
                  onClick={() => navigate(`/analytics/${truck.id}`)}
                  className="cursor-pointer border-b border-edge/50 transition-colors
                             hover:bg-inset"
                >
                  <td className="px-3 py-1.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: truckHex(truck.id) }}
                      />
                      <span className="truncate font-mono text-[11px] text-phosphor">
                        {truck.plate ?? String(truck.id).slice(0, 8)}
                      </span>
                    </span>
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-[11px] text-dim">
                    {truck.driver_name ?? '—'}
                  </td>
                  <td className="px-3 py-1.5">
                    {/* State in words. The colour beside it is identity, not
                        status, so status must never be read from a hue here. */}
                    <span className={`font-mono text-[10px] uppercase tracking-term
                                      ${truck.live ? (dr ? 'text-warn' : 'text-live') : 'text-muted'}`}>
                      {truck.live ? (dr ? 'Dead reckoning' : 'GNSS fix') : 'Idle'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[11px]
                                 tabular-nums text-dim">
                    {Number.isFinite(truck.speed) ? `${truck.speed.toFixed(1)} m/s` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[11px] text-muted">
                    {ago(truck.captured_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {fleet.length === 0 && (
          <p className="meta p-4">
            {loading ? 'Loading fleet…' : (error ?? 'No units registered')}
          </p>
        )}
      </div>
    </section>
  );
}

/// Relative, because "4 minutes ago" is the question a dispatcher is asking
/// and an ISO timestamp makes them do the subtraction. Falls back to nothing
/// rather than to "now" when there is no timestamp -- a truck that has never
/// reported must not read as one that just did.
function ago(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
