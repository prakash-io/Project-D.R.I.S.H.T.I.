// <TransponderPanel /> -- fleet roster and the telemetry HUD (Task 2).
//
// -------------------------------------------------------------------------
// ON NOT INVENTING TELEMETRY
// -------------------------------------------------------------------------
// The brief asks this HUD to show IMU pitch/roll, G-force, GPS speed, altitude
// and network status. Checked against what is actually on the wire
// (mobile-app/src/services/tracking.js emits, backend recordTelemetry stores):
//
//   GPS speed        yes, `speed` in m/s
//   heading          yes, but only on the dead-reckoning path
//   covariance       yes, on dead-reckoned fixes only
//   network status   derivable exactly -- `source: 'ekf'` MEANS the GNSS was
//                    lost, that is when the edge engine takes over
//   G-force          derivable approximately, from Δspeed/Δt
//   altitude         NO. The phone reads it and the code comments that the
//                    backend has no column, so it is never sent.
//   pitch / roll     NO. The IMU is consumed by the C++ EKF at 100 Hz on the
//                    handset and never leaves it.
//
// So three of the six are real, one is derived, and two are absent. Those two
// render as "NO STREAM" against a dimmed label. That is a deliberate choice:
// a plausible-looking 0.0° pitch on a dispatcher's screen is indistinguishable
// from a truck sitting level, and a dispatcher deciding whether a vehicle has
// rolled on a hillside would be reading a number nothing measured. Absent beats
// invented. Every field lights up on its own the moment the payload carries it
// -- commandStore reads all six keys already.
import React, { useMemo } from 'react';
import { useCommandStore, networkStatus, NETWORK } from '../store/commandStore';
import { shallow } from '../store/createStore';
import ActionDeck from './ActionDeck';
import SpeedCluster from './SpeedCluster';

const STATUS_STYLE = {
  [NETWORK.LIVE]: { chip: 'bg-signal/15 text-signal', dot: 'bg-signal' },
  [NETWORK.DARK]: { chip: 'bg-warn/15 text-warn', dot: 'bg-warn' },
  [NETWORK.STALE]: { chip: 'bg-inset text-muted', dot: 'bg-muted' },
  [NETWORK.OFFLINE]: { chip: 'bg-danger/15 text-danger-text', dot: 'bg-danger' },
};

function StatusChip({ status }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE[NETWORK.OFFLINE];
  return (
    <span className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 font-mono
                      text-[10px] uppercase tracking-term ${style.chip}`}>
      <span aria-hidden className={`h-1.5 w-1.5 ${style.dot}`} />
      {status}
    </span>
  );
}

/**
 * One HUD field.
 *
 * `origin` is not decoration. It tells the dispatcher whether they are reading
 * something a sensor reported, something this dashboard calculated, or nothing
 * at all -- and those three warrant different amounts of trust.
 */
function Readout({ label, value, unit, origin = 'wire', tone = 'text-phosphor' }) {
  const absent = value === null || value === undefined;
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <dt className="meta shrink-0">{label}</dt>
      <dd className="flex items-baseline gap-1.5 text-right">
        {absent ? (
          <span className="font-mono text-[10px] uppercase tracking-term text-muted/70">
            no stream
          </span>
        ) : (
          <>
            <span className={`font-mono text-[13px] tabular-nums ${tone}`}>{value}</span>
            {unit && <span className="font-mono text-[10px] text-muted">{unit}</span>}
            {origin === 'derived' && (
              <span
                className="font-mono text-[9px] uppercase tracking-term text-muted/80"
                title="Calculated by the dashboard from the speed series, not reported by the vehicle"
              >
                calc
              </span>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

function FleetRow({ truck, selected, onSelect, linkConnected }) {
  const status = networkStatus(truck, linkConnected);
  const label = truck.plate ?? truck.truck_id.slice(0, 8);

  return (
    <button
      type="button"
      onClick={() => onSelect(selected ? null : truck.truck_id)}
      aria-pressed={selected}
      // 44px minimum height: this is the primary control of the whole screen
      // and it is used under time pressure.
      className={`focus-ring flex min-h-[56px] w-full cursor-pointer items-center
                  justify-between gap-3 px-3 py-2.5 text-left transition-colors
                  ${selected ? 'bg-inset' : 'bg-surface hover:bg-inset/60'}`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className={`h-6 w-[3px] shrink-0 ${
            status === NETWORK.LIVE ? 'bg-signal'
              : status === NETWORK.DARK ? 'bg-warn' : 'bg-edge-active'}`}
        />
        <span className="min-w-0">
          <span className="block truncate font-mono text-[12px] text-phosphor">{label}</span>
          <span className="block truncate font-mono text-[10px] text-muted">
            {truck.driver_name ?? truck.truck_id.slice(0, 8)}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-mono text-[12px] tabular-nums text-dim">
          {truck.speed == null ? '—' : truck.speed.toFixed(1)}
          <span className="ml-1 text-[9px] text-muted">m/s</span>
        </span>
        <StatusChip status={status} />
      </span>
    </button>
  );
}

export default function TransponderPanel() {
  const trucks = useCommandStore((s) => s.trucks);
  const selectedTruckId = useCommandStore((s) => s.ui.selectedTruckId);
  const selectTruck = useCommandStore((s) => s.selectTruck);
  const linkConnected = useCommandStore((s) => s.link.connected);
  const darkZone = useCommandStore((s) => s.darkZone);

  const fleet = useMemo(
    // Sorted by plate so a truck does not change position in the list every
    // time a packet lands -- a roster that reorders under the cursor is
    // unusable during an incident.
    () => Object.values(trucks).sort((a, b) =>
      (a.plate ?? a.truck_id).localeCompare(b.plate ?? b.truck_id)),
    [trucks],
  );

  const selected = selectedTruckId ? trucks[selectedTruckId] : null;
  const counts = useMemo(() => {
    let live = 0; let dark = 0;
    for (const truck of fleet) {
      const status = networkStatus(truck, linkConnected);
      if (status === NETWORK.LIVE) live += 1;
      else if (status === NETWORK.DARK) dark += 1;
    }
    return { live, dark };
  }, [fleet, linkConnected]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-edge px-3 py-2.5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-[13px] font-black uppercase leading-none
                         tracking-crush text-phosphor">
            Transponder
          </h2>
          <span className="meta">{fleet.length} unit{fleet.length === 1 ? '' : 's'}</span>
        </div>
        <p className="mt-1.5 font-mono text-[10px] text-muted">
          <span className="text-signal">{counts.live} live</span>
          <span className="mx-1.5 text-edge-active">/</span>
          <span className={counts.dark > 0 ? 'text-warn' : ''}>{counts.dark} dark zone</span>
        </p>
      </header>

      {/* Roster. `min-h` matters: without it, opening the telemetry HUD (which
          is tall) collapses the list to a sliver, and the dispatcher loses the
          ability to switch trucks without first closing the panel they opened
          to compare against. Two rows is the floor. */}
      <div className="min-h-[7rem] flex-1 overflow-y-auto">
        {fleet.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <div aria-hidden className="font-mono text-[20px] text-edge-active">+</div>
              <p className="meta mt-2 leading-relaxed">
                {linkConnected ? 'Connected — awaiting telemetry' : 'No link to the backend'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-px bg-edge">
            {fleet.map((truck) => (
              <FleetRow
                key={truck.truck_id}
                truck={truck}
                selected={truck.truck_id === selectedTruckId}
                onSelect={selectTruck}
                linkConnected={linkConnected}
              />
            ))}
          </div>
        )}
      </div>

      {/* telemetry HUD */}
      {selected && (
        <section
          aria-label="Vehicle telemetry"
          // Capped and independently scrollable. The HUD plus the action deck
          // is taller than most viewports leave for it, and letting it size
          // freely pushes the Emergency Reroute button off the bottom of the
          // panel -- the one control that must never be unreachable.
          className="max-h-[62%] shrink-0 overflow-y-auto border-t border-edge-active bg-panel"
        >
          <TelemetryHud
            truck={selected}
            linkConnected={linkConnected}
            darkZone={darkZone[selected.truck_id]}
          />
          <ActionDeck truck={selected} />
        </section>
      )}
    </div>
  );
}

function TelemetryHud({ truck, linkConnected, darkZone }) {
  const status = networkStatus(truck, linkConnected);
  const route = useCommandStore((s) => s.routes[truck.truck_id], shallow);

  const ageS = (Date.now() - truck.receivedAt) / 1000;
  const gForce = truck.gForce;

  return (
    <>
      <div className={`flex items-center justify-between px-3 py-2 ${
        status === NETWORK.DARK ? 'bg-warn/10' : 'bg-signal/10'}`}>
        <span className="font-mono text-[11px] text-phosphor">
          {truck.plate ?? truck.truck_id.slice(0, 8)}
        </span>
        <StatusChip status={status} />
      </div>

      {/* The instrument first, the numbers under it. A dispatcher scanning a
          panel answers "is this truck behaving" from the gauge and only reads
          the table when the answer is no. */}
      <div className="border-b border-edge">
        <SpeedCluster
          speed={truck.speed}
          gForce={truck.gForce}
          dead={status === NETWORK.DARK}
        />
      </div>

      <dl className="divide-y divide-edge/60">
        <Readout
          label="GPS speed"
          value={truck.speed == null ? null : truck.speed.toFixed(1)}
          unit="m/s"
        />
        <Readout
          label="G-force"
          // Signed: braking and acceleration are different events and the sign
          // is the only thing that separates them.
          value={gForce == null ? null : `${gForce >= 0 ? '+' : ''}${gForce.toFixed(2)}`}
          unit="g"
          origin="derived"
          tone={gForce != null && Math.abs(gForce) > 0.35 ? 'text-danger-text' : 'text-phosphor'}
        />
        <Readout
          label="Heading"
          value={truck.heading_deg == null ? null : truck.heading_deg.toFixed(0).padStart(3, '0')}
          unit="°"
        />
        <Readout label="IMU pitch" value={truck.pitch_deg?.toFixed?.(1) ?? null} unit="°" />
        <Readout label="IMU roll" value={truck.roll_deg?.toFixed?.(1) ?? null} unit="°" />
        <Readout label="Altitude" value={truck.altitude_m?.toFixed?.(0) ?? null} unit="m" />
        <Readout
          label="Position ±"
          // One standard deviation of the EKF's own estimate. Only meaningful
          // while dead reckoning; a GNSS fix carries no covariance at all.
          value={truck.covariance_m2 ? Math.sqrt(truck.covariance_m2).toFixed(0) : null}
          unit="m"
          tone="text-warn"
        />
        <Readout
          label="Last fix"
          value={ageS < 1 ? '<1' : ageS.toFixed(0)}
          unit="s ago"
          tone={ageS > 8 ? 'text-warn' : 'text-phosphor'}
        />
        <Readout
          label="Map matched"
          value={truck.source === 'ekf' ? (truck.map_matched ? 'YES' : 'NO') : null}
          tone={truck.map_matched ? 'text-ok' : 'text-warn'}
        />
      </dl>

      {darkZone && (
        <p className="border-t border-edge px-3 py-2 font-mono text-[10px] leading-relaxed text-signal">
          Dark-zone path synced: {darkZone.points} fixes
          {darkZone.syncedAt
            ? ` · ${new Date(darkZone.syncedAt).toLocaleTimeString()}`
            : ''}
        </p>
      )}

      {route && (
        <p className="border-t border-edge px-3 py-2 font-mono text-[10px] leading-relaxed text-muted">
          Route via <span className="text-route">{route.provider}</span>
          {route.distance_m ? ` · ${(route.distance_m / 1000).toFixed(1)} km` : ''}
        </p>
      )}
    </>
  );
}
