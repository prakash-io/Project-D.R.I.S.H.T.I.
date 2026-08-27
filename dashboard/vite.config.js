import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    // deck.gl and maplibre are both large; splitting them keeps the app chunk
    // small enough that a dispatcher on a thin connection sees the shell
    // before the map engine finishes downloading.
    rollupOptions: {
      output: {
        manualChunks: {
          deck: ['deck.gl', '@deck.gl/react', '@deck.gl/mesh-layers'],
          map: ['maplibre-gl', 'react-map-gl'],
          // Three.js is chunked separately so the "no three.js on the map"
          // rule is MECHANICALLY checkable rather than a convention someone
          // has to remember. scripts/check_three_isolation.mjs asserts that
          // the three renderer's symbols appear in this chunk and in neither
          // of the two above; if a future edit imports three from a map
          // module, rollup folds it into the map chunk and that check fails.
          //
          // It also happens to be the right split on its own terms: the
          // navigation mark and the analytics chart are the only consumers,
          // and a dispatcher who never opens Analytics still pays for the
          // navigation mark, which is small.
          three: ['three', '@react-three/fiber'],
        },
      },
    },
  },
});
