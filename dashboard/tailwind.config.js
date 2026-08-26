/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // A control room is looked at for hours in a dim room. The surfaces
        // are near-black with low-chroma separation so the only saturated
        // things on screen are the ones that mean something: a truck, a
        // blocked road, a red corridor.
        panel: '#0d1117',
        surface: '#161b22',
        edge: '#30363d',
        muted: '#8b949e',
        danger: '#f85149',
        warn: '#d29922',
        ok: '#3fb950',
        live: '#58a6ff',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
