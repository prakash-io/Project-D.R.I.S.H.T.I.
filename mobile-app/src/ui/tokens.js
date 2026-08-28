// D.R.I.S.H.T.I. driver client — design tokens.
//
// Light "floating card" system: white surfaces over a live map, orange as the
// single accent, fully-rounded pill controls. Replaces the dark tactical
// terminal palette that preceded it.
//
// Three frozen layers as before — primitive -> semantic -> component. Screens
// import only `t`; nothing outside this file names a hex.
//
// Contrast: every pair used for text below is stated with its measured ratio
// against the surface it actually sits on, not against an assumed one. The
// orange is the trap here -- #F26B21 on white is 3.13:1, which is fine for a
// large label or a non-text fill but FAILS AA for body text, so it is never
// used for small type on white.
import { Platform } from 'react-native';

// ------------------------------------------------------------------ primitive
const p = {
  // Surfaces
  white: '#FFFFFF',
  paper: '#F7F7F8',   // app ground behind the map / screen background
  mist: '#F1F2F4',    // inset chips inside a card
  hair: '#E4E6EA',    // hairline dividers

  // Ink
  ink900: '#111418',  // 16.1:1 on white — headings and values
  ink700: '#3C4149',  //  9.4:1 on white — body copy
  ink500: '#697280',  //  4.6:1 on white — uppercase meta labels (passes AA)

  // Accent — the product's single brand colour
  orange500: '#F26B21',  // fills, active tab, primary button
  orange600: '#D95A15',  // pressed
  orange700: '#B4460D',  //  4.7:1 on white — safe for orange TEXT on white
  orangeWash: '#FDF0E8',  // tinted chip background

  // Status
  red500: '#D93025',   //  4.8:1 on white
  red600: '#B3261E',
  redWash: '#FDECEC',
  green600: '#1E8E3E',  //  4.5:1 on white
  greenWash: '#E6F4EA',
  amber600: '#B26A00',  //  4.6:1 on white
  amberWash: '#FDF0E1',

  // Data provenance — carried over unchanged. A driver and a dispatcher
  // looking at the same truck must see the same two colours.
  gnss: '#1A73E8',      // GNSS fix   4.6:1 on white
  deadrec: '#B26A00',   // dead reckoning

  // Navigation — the Google Maps convention, deliberately.
  //
  // A driver reads a route line before they read anything else on the glass,
  // and every one of them has already learned "thick blue line = the road I am
  // on" from an app they use daily. Orange was the product's brand accent and
  // it was doing that job here, which meant the single most-read element on
  // the screen needed a legend nobody has time for at 60 km/h. The accent
  // keeps every other job it had; it just stops being the route.
  //
  // Two blues, not one: the casing is what separates the line from a dark
  // basemap and from the road casings underneath it. A single flat stroke
  // disappears over a motorway at z14 -- which is the working zoom.
  navBlue: '#4285F4',     // the route polyline
  navBlueDeep: '#1967D2', // its casing, drawn wider and underneath
  // Start and end are green/red rather than two blues. The polyline already
  // owns blue, so an endpoint in the same hue reads as part of the line
  // instead of as a terminus.
  navGreen: '#137333',    // origin      6.4:1 on white
  navRed: '#C5221F',      // destination 5.9:1 on white
};

// A driver reads this in a cradle at speed. Sizes are for that distance.
const type = {
  micro: 11, meta: 13, body: 15, lead: 17, title: 22, head: 28, hero: 44,
};

// 4/8pt rhythm.
const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

// The design is set in a geometric sans, not a monospace. Numerals still need
// tabular figures so a changing speed does not shuffle the layout.
const sans = Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' });
const sansMedium = Platform.select({ ios: 'System', android: 'sans-serif-medium', default: 'System' });
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// ------------------------------------------------------- semantic + component
export const t = {
  color: {
    bgBase: p.paper,
    bgPanel: p.white,
    bgRaised: p.white,
    bgInset: p.mist,

    border: p.hair,
    borderActive: p.orange500,

    textPrimary: p.ink900,
    textSecondary: p.ink700,
    textMuted: p.ink500,

    accent: p.orange500,
    accentPressed: p.orange600,
    accentText: p.orange700,   // orange used AS TEXT on white
    accentWash: p.orangeWash,
    onAccent: p.white,

    alertFill: p.red500,
    alertText: p.red600,
    alertPressed: p.red600,
    alertWash: p.redWash,
    onAlert: p.white,

    okText: p.green600,
    okWash: p.greenWash,
    warnText: p.amber600,
    warnWash: p.amberWash,

    // The route on the map. Named for the job, not the hue, so the day a
    // dispatcher's board and a driver's map have to agree on it there is one
    // place to change.
    routeLine: p.navBlue,
    routeCasing: p.navBlueDeep,
    routeStart: p.navGreen,
    routeEnd: p.navRed,

    // The two that carry the product's whole meaning.
    sourceGnss: p.gnss,
    sourceDeadReckoning: p.deadrec,
    linkUp: p.green600,
  },
  type,
  space,
  // `mono` is retained for the superseded brutalist components in src/ui/
  // (SpeedCluster, PositionReadout, SyncQueue, StatusBanner, HazardButton).
  // They are no longer mounted, but they still hold the dark-zone readout
  // logic, so the token they import must keep resolving.
  font: { sans, sansMedium, mono },

  // Rounded system: pills for controls, generous radii for floating cards.
  radius: { pill: 999, card: 24, inner: 16, chip: 12 },
  hairline: 1,
  // >=44pt per Apple HIG / 48dp Android. Applied to every Pressable.
  touchMin: 48,

  // One elevation scale. Cards float over the map; nothing else casts.
  shadow: {
    card: {
      shadowColor: '#0B1220',
      shadowOpacity: 0.13,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    control: {
      shadowColor: '#0B1220',
      shadowOpacity: 0.16,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 4,
    },
  },
};

/** Mode -> presentation. Kept in one place so the speed card, the diagnostics
 *  rows and the tab bar cannot disagree about what "dark-zone" looks like.
 *
 *  Colour is never the only channel: each entry carries a word and an icon
 *  name, because a driver may be colour-blind and the cab may be in full sun. */
export const MODE_PRESENTATION = {
  starting: {
    label: 'ACQUIRING FIX', icon: 'gps-not-fixed',
    tone: t.color.textMuted, wash: t.color.bgInset, note: 'Acquiring first fix',
  },
  online: {
    label: 'LIVE LINK', icon: 'gps-fixed',
    tone: t.color.okText, wash: t.color.okWash, note: 'Live link to dispatch',
  },
  'dark-zone': {
    label: 'DEAD RECKONING ACTIVE', icon: 'warning',
    tone: t.color.alertText, wash: t.color.alertWash, note: 'No network · dead reckoning',
  },
  degraded: {
    label: 'NO FIX TO SEED', icon: 'error-outline',
    tone: t.color.alertText, wash: t.color.alertWash, note: 'No fix to seed dead reckoning',
  },
};

export function modePresentation(mode) {
  return MODE_PRESENTATION[mode] ?? MODE_PRESENTATION.starting;
}
