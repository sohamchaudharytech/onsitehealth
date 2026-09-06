import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Everything (API + WebSocket) is served by the logistics service.
      '/api': 'http://localhost:4301',
      '/ws': {
        target: 'ws://localhost:4301',
        ws: true,
      },
    },
  },
});
