// The primary navigation rail (WEB-01).
//
// Vertical, not a top bar. The console's scarce axis is vertical -- the map,
// the incident queue and the alert feed all want height -- and a top bar
// spends 56 px of it on every page. A rail spends width, which the layout has
// to give up anyway for the incident panel.
//
// A NOTE ON STRINGS. verify.mjs asserts against document.body.innerText with
// case-sensitive regexes: /Trucks\s*(\d+)/, /(\d+)\s+packets/, /Corridors
// \s*(\d+)/, /Disruption Overlay\s*(\d+)/ and /(\d+)\s+awaiting approval/.
// Those live in ControlBar and IncidentPanel, which is why this file uses
// none of those words next to a number. The rail is always mounted, so a
// label here that collided would be matched on every route and the counts
// would come back wrong with no component visibly broken. Add nav items
// freely; just keep them clear of those five phrases.
import React from 'react';
import { NavLink } from 'react-router-dom';
import Logo3D from './Logo3D';
import ErrorBoundary from './ErrorBoundary';

/// Inline SVG rather than an icon package: three glyphs do not justify a
/// dependency, and the console already refuses network fetches for fonts.
const ICONS = {
  map: (
    <>
      <path d="M1 4.5 6 2.5v9L1 13.5z" />
      <path d="M6 2.5v9l5 2v-9z" />
      <path d="M11 4.5 15 3v9l-4 1.5z" />
    </>
  ),
  weather: (
    <>
      <path d="M4.2 9.2a2.7 2.7 0 0 1 .3-5.4 3.6 3.6 0 0 1 6.9-.6 2.9 2.9 0 0 1 .4 5.8z" />
      <path d="M5.6 11.4 4.7 14M8.4 11.4 7.5 14M11.2 11.4 10.3 14" />
    </>
  ),
  analytics: (
    <>
      <path d="M2 14V2" />
      <path d="M2 14h12" />
      <path d="M5 11.5V8M8.3 11.5V4.5M11.6 11.5V6.5" />
    </>
  ),
};

const ROUTES = [
  { to: '/', label: 'Live Map', hint: 'Command center', icon: 'map', end: true },
  { to: '/weather', label: 'Weather & Alerts', hint: 'Hazard forecast', icon: 'weather' },
  { to: '/analytics', label: 'Analytics', hint: 'Fleet & risk', icon: 'analytics' },
];

function Glyph({ name }) {
  return (
    <svg
      viewBox="0 0 16 16" width="16" height="16" aria-hidden
      fill="none" stroke="currentColor" strokeWidth="1.25"
      strokeLinecap="square" strokeLinejoin="miter"
      className="shrink-0"
    >
      {ICONS[name]}
    </svg>
  );
}

/**
 * @param connected  telemetry socket state, for the footer lamp
 * @param alertCount segments currently over the flag threshold
 */
export default function NavBar({
  connected, alertCount = 0,
  unitCount = 0, segmentCount = 0, corridorCount = 0, queueCount = 0,
}) {
  return (
    <nav
      aria-label="Primary"
      className="glass glass-sheen relative z-20 flex w-[212px] shrink-0 flex-col
                 border-y-0 border-l-0"
    >
      {/* ------------------------------------------------------------ mark */}
      <div className="flex items-center gap-3 border-b border-edge px-4 py-4">
        {/* An ornament, and boundaried as one: `fallback={null}` leaves an
            empty 44 px slot if the GL context is lost rather than putting an
            error card at the top of the navigation. */}
        <ErrorBoundary label="Logo" fallback={null}>
          <Logo3D size={44} />
        </ErrorBoundary>
        <div className="min-w-0">
          <div className="font-display text-[15px] leading-none tracking-crush
                          text-phosphor">
            D.R.I.S.H.T.I.
          </div>
          <div className="meta mt-1.5 truncate">NER Logistics</div>
        </div>
      </div>

      {/* ----------------------------------------------------------- routes */}
      <ul className="flex flex-1 flex-col gap-px py-2">
        {ROUTES.map((route) => (
          <li key={route.to}>
            <NavLink
              to={route.to}
              end={route.end}
              className={({ isActive }) => [
                'focus-ring flex items-center gap-3 px-4 py-2.5 transition-colors',
                isActive
                  ? 'glass-active text-phosphor'
                  : 'text-dim hover:bg-surface/50 hover:text-phosphor',
              ].join(' ')}
            >
              <Glyph name={route.icon} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12px] leading-tight">
                  {route.label}
                </span>
                <span className="meta block truncate normal-case tracking-normal">
                  {route.hint}
                </span>
              </span>

              {/* Only ever on the weather route, and only when something is
                  actually flagged. A badge showing 0 trains a dispatcher to
                  stop reading the badge. */}
              {route.to === '/weather' && alertCount > 0 && (
                <span
                  className="alert-glass px-1.5 py-0.5 font-mono text-[10px]
                             leading-none text-danger-text"
                  aria-label={`${alertCount} segments over threshold`}
                >
                  {alertCount}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      {/* ----------------------------------------------------------- status
          The four standing counts, carried on every route.

          These were CommandRail's, and the labels are shortened rather than
          copied: "Units / Segments / Routes / Queue", never "Trucks",
          "Corridors" or "awaiting approval". Same reason as the note at the
          top of this file -- verify.mjs takes the FIRST innerText match in
          document order, and this rail renders before ControlBar does, so a
          faithful label here would shadow the real readout and the script
          would assert against the navigation instead of the console. */}
      <div className="grid grid-cols-2 gap-px border-t border-edge bg-edge/60">
        <RailStat label="Units" value={unitCount} />
        <RailStat label="Segments" value={segmentCount}
          tone={segmentCount > 0 ? 'text-danger-text' : 'text-phosphor'} />
        <RailStat label="Routes" value={corridorCount} />
        <RailStat label="Queue" value={queueCount}
          tone={queueCount > 0 ? 'text-warn' : 'text-phosphor'} />
      </div>

      <div className="border-t border-edge px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 ${connected ? 'bg-ok' : 'bg-danger animate-pulse'}`}
          />
          <span className="meta">
            {connected ? 'Telemetry link up' : 'Telemetry link down'}
          </span>
        </div>
      </div>
    </nav>
  );
}

function RailStat({ label, value, tone = 'text-phosphor' }) {
  return (
    <div className="bg-panel/70 px-3 py-2.5">
      <div className="meta leading-none">{label}</div>
      <output className={`mt-1.5 block font-mono text-[14px] leading-none ${tone}`}>
        {value}
      </output>
    </div>
  );
}
