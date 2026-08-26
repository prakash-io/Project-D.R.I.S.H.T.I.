// Left command rail — the standing frame of the command center (WEB-01).
//
// Presentation only. It derives every glyph from state the hooks already
// publish; it opens no socket, fetches nothing, and owns no state of its own.
//
// Deliberately avoids the literal strings "Trucks", "packets", "Disruption
// Overlay" and "awaiting approval". verify.mjs matches those against
// document.body.innerText and takes the FIRST match in document order -- a
// second occurrence up here would shadow the real readout in the bar below.
import React from 'react';

function RailStat({ label, value, tone = 'text-phosphor' }) {
  return (
    <div className="px-2 py-2.5 text-center">
      <div className="meta leading-none">{label}</div>
      <output className={`mt-1 block font-mono text-[13px] leading-none ${tone}`}>
        {value}
      </output>
    </div>
  );
}

export default function CommandRail({ connected, unitCount, segmentCount, queueCount }) {
  return (
    <nav
      aria-label="System status"
      className="crt relative flex w-16 shrink-0 flex-col justify-between
                 border-r border-edge bg-panel"
    >
      {/* registration block */}
      <div className="border-b border-edge px-2 py-3 text-center">
        <div className="font-display text-[15px] font-black leading-none
                        tracking-crush text-phosphor">
          D
        </div>
        <div className="meta mt-1 leading-none">R&trade;</div>
      </div>

      {/* vertical wordmark — section 3.1 macro type, rotated to hold the rail */}
      <div className="flex flex-1 items-center justify-center overflow-hidden">
        <span
          style={{ writingMode: 'vertical-rl' }}
          className="select-none font-display text-[13px] font-black uppercase
                     tracking-[0.42em] text-muted/70"
        >
          Drishti&nbsp;/&nbsp;NER&nbsp;Logistics
        </span>
      </div>

      {/* live status stack */}
      <div className="hairgrid border-t border-edge">
        <div className="bg-panel px-2 py-2.5 text-center">
          <div className="meta leading-none">Link</div>
          <div className="mt-1.5 flex items-center justify-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 ${connected ? 'bg-ok' : 'bg-danger animate-pulse'}`}
            />
            <span className={`font-mono text-[10px] leading-none
                              ${connected ? 'text-ok' : 'text-danger-text'}`}>
              {connected ? 'UP' : 'DWN'}
            </span>
          </div>
        </div>

        <div className="bg-panel"><RailStat label="Units" value={unitCount} tone="text-live" /></div>
        <div className="bg-panel">
          <RailStat label="Seg" value={segmentCount}
                    tone={segmentCount > 0 ? 'text-danger-text' : 'text-muted'} />
        </div>
        <div className="bg-panel">
          <RailStat label="Rev" value={queueCount}
                    tone={queueCount > 0 ? 'text-warn' : 'text-muted'} />
        </div>
      </div>

      <div className="border-t border-edge px-2 py-2 text-center">
        <span className="meta">R2.6</span>
      </div>
    </nav>
  );
}
