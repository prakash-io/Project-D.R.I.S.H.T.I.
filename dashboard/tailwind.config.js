/** @type {import('tailwindcss').Config} */

// Every colour resolves to a CSS variable from src/styles/tokens.css. The
// channel form keeps Tailwind's opacity modifiers working (`bg-panel/90`)
// while leaving tokens.css the single source of truth -- no hex is repeated
// here, so the palette cannot drift between the config and the stylesheet.
const token = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // semantic surface / structure
        base:    token('--bg-base'),
        panel:   token('--bg-panel'),
        surface: token('--bg-raised'),
        inset:   token('--bg-inset'),
        edge:    token('--border-hairline'),
        'edge-active': token('--border-active'),

        // readouts
        phosphor: token('--text-primary'),
        dim:      token('--text-secondary'),
        muted:    token('--text-muted'),

        // status. `danger` is the hazard accent; `warn`/`live` keep the
        // names the components already used but now point at the tokens
        // that match the deck.gl layer colours exactly.
        // Three roles, three tokens -- see tokens.css for the measurements.
        danger:      token('--accent-alert'),       // fills, borders, meters
        'danger-text': token('--accent-alert-text'),// alert words on dark
        hot:         token('--accent-alert-hot'),
        approve:     token('--btn-approve-bg'),     // white text clears AA
        'approve-hot': token('--btn-approve-bg-hot'),
        focus:       token('--focus-ring'),
        ok:     token('--status-live'),
        warn:   token('--status-deadrec'),
        live:   token('--status-gnss'),
        // `signal` is the same channel as `live`, named for the role rather
        // than the fix type: it is the accent for anything currently
        // transmitting, whether that is a truck marker or the link readout.
        signal: token('--status-gnss'),
        route:  token('--status-route'),
      },
      fontFamily: {
        // Section 3.2: monospace carries all telemetry, metadata and IDs.
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono',
               'IBM Plex Mono', 'Menlo', 'monospace'],
        // Section 3.1: neo-grotesque at heavy weight for structural headers.
        // System stacks only -- a command center that exists to survive
        // dark zones should not block first paint on fonts.googleapis.com.
        display: ['Archivo Black', 'Helvetica Neue', 'Helvetica',
                  'Inter', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        // Section 3.1: negative tracking welds macro glyphs into a block.
        crush: '-0.045em',
        // Section 3.2: mechanical spacing for terminal metadata.
        term:  '0.14em',
      },
      borderRadius: {
        // Section 5: absolute rejection of border-radius. Overriding the
        // scale means `rounded`, `rounded-lg` etc. are all 0 -- the rule
        // cannot be broken by reflex.
        none: '0', sm: '0', DEFAULT: '0', md: '0',
        lg: '0', xl: '0', '2xl': '0', '3xl': '0', full: '0',
      },
    },
  },
  plugins: [],
};
