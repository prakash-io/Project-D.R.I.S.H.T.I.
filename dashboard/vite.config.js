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
          deck: ['deck.gl', '@deck.gl/react'],
          map: ['maplibre-gl', 'react-map-gl'],
        },
      },
    },
  },
});
