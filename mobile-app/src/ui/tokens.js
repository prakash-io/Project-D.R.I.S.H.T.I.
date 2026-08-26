// D.R.I.S.H.T.I. driver client — design tokens.
//
// The same Tactical Telemetry system as the dispatcher command center, ported
// to React Native. There are no CSS variables here, so the three layers are
// three frozen objects: primitive -> semantic -> component. Screens import
// only `t` (semantic/component); nothing outside this file names a hex.
//
// The colour values are not re-picked for mobile. They were measured against
// WCAG on the dashboard and carried over unchanged so a dispatcher and a
// driver looking at the same incident see the same red.
import { Platform } from 'react-native';

// ------------------------------------------------------------------ primitive
const p = {
  ink000: '#0A0A0A', ink050: '#0F0F0F', ink100: '#161616', ink200: '#1E1E1E',
  rule100: '#2A2A2A', rule200: '#3D3D3D',

  phos100: '#EAEAEA',  // 15.93:1 on panel
  phos200: '#A8A8A8',  //  8.06:1
  phos300: '#8A8A8A',  //  5.24:1 -- #7A7A7A measured 4.22 and failed AA at
                       //  the sizes metadata is actually rendered at.

  hazard100: '#E61919',  // fills, borders            (non-text, needs 3:1)
  hazard300: '#F85149',  // hazard words on dark       5.40:1
  hazard400: '#D20D0D',  // under #EAEAEA text         4.59:1
  hazard500: '#B80A0A',  // pressed                    5.31:1

  terminal: '#4AF626',   // 13.24:1 -- link/online only
  gnss: '#58A6FF',       //  7.59:1 -- matches the dashboard's GNSS markers
  deadrec: '#D29922',    //  7.59:1 -- matches the dashboard's DR markers
};

// A driver reads this at a glance, in a cradle, on a mountain road. Every
// size below is chosen for that distance, not for a phone held at desk range.
const type = {
  micro: 10, meta: 12, body: 14, lead: 18, title: 24, head: 32, hero: 88,
};

// 4/8pt rhythm.
const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// ------------------------------------------------------- semantic + component
export const t = {
  color: {
    bgBase: p.ink000,
    bgPanel: p.ink050,
    bgRaised: p.ink100,
    bgInset: p.ink200,

    border: p.rule100,
    borderActive: p.rule200,

    textPrimary: p.phos100,
    textSecondary: p.phos200,
    textMuted: p.phos300,

    alertFill: p.hazard100,
    alertText: p.hazard300,
    alertPressed: p.hazard500,
    onAlert: p.phos100,

    // The two that carry the product's whole meaning.
    sourceGnss: p.gnss,
    sourceDeadReckoning: p.deadrec,
    linkUp: p.terminal,
  },
  type,
  space,
  font: { mono },
  // Section 5 of the brutalist system: 90-degree corners, one hairline width.
  radius: 0,
  hairline: 1,
  // >=44pt per Apple HIG / 48dp Android. Applied to every Pressable.
  touchMin: 48,
};

/** Mode -> presentation. Kept in one place so the banner, the position chip
 *  and the speed cluster cannot disagree about what "dark-zone" looks like.
 *
 *  Colour is never the only channel: each entry carries a word and a glyph,
 *  because a driver may be colour-blind and the cab may be in full sun. */
export const MODE_PRESENTATION = {
  starting:    { label: 'STARTING',  glyph: '···', tone: t.color.textMuted,             note: 'Acquiring first fix' },
  online:      { label: 'ONLINE',    glyph: '///', tone: t.color.linkUp,                note: 'Live link to dispatch' },
  'dark-zone': { label: 'DARK ZONE', glyph: '>>>', tone: t.color.sourceDeadReckoning,   note: 'No network · dead reckoning' },
  degraded:    { label: 'DEGRADED',  glyph: '!!!', tone: t.color.alertText,             note: 'No fix to seed dead reckoning' },
};

export function modePresentation(mode) {
  return MODE_PRESENTATION[mode] ?? MODE_PRESENTATION.starting;
}
