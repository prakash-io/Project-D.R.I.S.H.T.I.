// <SpeedCluster /> -- the speed and g-force instrument.
//
// The dashboard's counterpart to the driver client's own cluster
// (mobile-app/src/ui/SpeedCluster.jsx), so a dispatcher and a driver are
// reading the same instrument rather than two different presentations of the
// same number.
//
// Drawn as an SVG arc rather than a bar because the question a dispatcher asks
// is not "what is the speed" -- that is in the readout below it -- but "is this
// truck moving normally for this road", which is a proportion, and proportion
// is what an arc shows without being read.
//
// The g-force track underneath is bipolar on purpose: braking and acceleration
// are different events and a magnitude-only bar throws away the sign that
// separates them. Its value is DERIVED from the speed series (see
// commandStore.deriveGForce) and is labelled as such wherever it appears.
import React from 'react';

/// 30 m/s ~= 108 km/h. Above a truck's realistic ceiling on NER highways, so
/// the needle spends its life in the useful part of the arc rather than
/// hugging the bottom of a scale sized for a sports car.
const MAX_SPEED_MS = 30;

/// Hard braking. Beyond this the bar saturates and turns red -- past about
/// 0.4 g an unsecured load is moving.
const G_LIMIT = 0.6;

/// Arc geometry. A 240-degree sweep opening downward leaves room for the
/// numerals in the middle without crowding the ends.
const R = 44;
const CX = 56;
const CY = 52;
const START = 150;
const SWEEP = 240;

function polar(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + R * Math.cos(rad), CY + R * Math.sin(rad)];
}

function arcPath(fromDeg, toDeg) {
  const [x1, y1] = polar(fromDeg);
  const [x2, y2] = polar(toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`;
}

export default function SpeedCluster({ speed, gForce, dead }) {
  const hasSpeed = Number.isFinite(speed);
  const clamped = hasSpeed ? Math.max(0, Math.min(MAX_SPEED_MS, speed)) : 0;
  const fraction = clamped / MAX_SPEED_MS;
  const needle = START + SWEEP * fraction;

  const kmh = hasSpeed ? speed * 3.6 : null;
  const hasG = Number.isFinite(gForce);
  const gFraction = hasG ? Math.max(-1, Math.min(1, gForce / G_LIMIT)) : 0;
  const heavy = hasG && Math.abs(gForce) > 0.35;

  // Amber while dead reckoning: the whole cluster is then showing a value the
  // EKF estimated from a vibration model, not one a satellite measured, and
  // the instrument should not look equally confident in both cases.
  const accent = dead ? 'rgb(var(--status-deadrec))' : 'rgb(var(--status-gnss))';

  return (
    <div className="flex items-center gap-4 px-3 py-3">
      <svg
        viewBox="0 0 112 88"
        className="h-[88px] w-[112px] shrink-0"
        role="img"
        aria-label={hasSpeed
          ? `Speed ${kmh.toFixed(0)} kilometres per hour`
          : 'Speed unavailable'}
      >
        {/* unfilled track */}
        <path
          d={arcPath(START, START + SWEEP)}
          fill="none"
          stroke="rgb(var(--bg-inset))"
          strokeWidth="7"
          strokeLinecap="butt"
        />
        {/* filled portion */}
        {hasSpeed && fraction > 0 && (
          <path
            d={arcPath(START, needle)}
            fill="none"
            stroke={accent}
            strokeWidth="7"
            strokeLinecap="butt"
          />
        )}
        {/* Quarter ticks. Four marks are enough to read a proportion; a full
            ring of graduations at this size is texture, not information. */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const a = ((START + SWEEP * t) * Math.PI) / 180;
          const inner = R - 10;
          const outer = R - 5;
          return (
            <line
              key={t}
              x1={CX + inner * Math.cos(a)} y1={CY + inner * Math.sin(a)}
              x2={CX + outer * Math.cos(a)} y2={CY + outer * Math.sin(a)}
              stroke="rgb(var(--border-active))"
              strokeWidth="1"
            />
          );
        })}

        <text
          x={CX} y={CY - 2}
          textAnchor="middle"
          className="font-mono"
          fontSize="20"
          fontWeight="700"
          fill="rgb(var(--text-primary))"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {kmh === null ? '--' : kmh.toFixed(0)}
        </text>
        <text
          x={CX} y={CY + 12}
          textAnchor="middle"
          className="font-mono"
          fontSize="8"
          letterSpacing="1.4"
          fill="rgb(var(--text-muted))"
        >
          KM/H
        </text>
      </svg>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between">
          <span className="meta">G-force</span>
          <span className={`font-mono text-[12px] tabular-nums ${
            heavy ? 'text-danger-text' : 'text-phosphor'}`}>
            {hasG ? `${gForce >= 0 ? '+' : ''}${gForce.toFixed(2)}` : '—'}
            <span className="ml-1 text-[9px] text-muted">{hasG ? 'g calc' : ''}</span>
          </span>
        </div>

        {/* Bipolar track: centre is zero, left is braking, right is
            acceleration. */}
        <div className="relative mt-2 h-2 w-full bg-inset" aria-hidden>
          <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-edge-active" />
          {hasG && (
            <span
              className={`absolute top-0 h-full ${heavy ? 'bg-danger' : 'bg-signal'}`}
              style={{
                left: gFraction >= 0 ? '50%' : `${50 + gFraction * 50}%`,
                width: `${Math.abs(gFraction) * 50}%`,
              }}
            />
          )}
        </div>
        <div className="mt-1 flex justify-between">
          <span className="font-mono text-[9px] text-muted">brake</span>
          <span className="font-mono text-[9px] text-muted">accel</span>
        </div>

        <p className="mt-2 font-mono text-[10px] text-muted">
          {hasSpeed ? `${speed.toFixed(1)} m/s` : 'no speed on the wire'}
        </p>
      </div>
    </div>
  );
}
