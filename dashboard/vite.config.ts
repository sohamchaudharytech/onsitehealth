import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Epoch + watermark state live on the coordinator; everything else on central.
      '/api/epoch': 'http://localhost:4002',
      '/api/watermarks': 'http://localhost:4002',
      '/api/sites': 'http://localhost:4001',
      '/api': 'http://localhost:4001',
      // Logistics (independent service) — distinct prefix so the two APIs
      // coexist on the same dashboard origin.
      '/logistics-api': {
        target: 'http://localhost:4301',
        rewrite: (path) => path.replace(/^\/logistics-api/, '/api'),
      },
      '/logistics-ws': {
        target: 'ws://localhost:4301',
        ws: true,
        rewrite: (path) => path.replace(/^\/logistics-ws/, '/ws'),
      },
      '/ws': {
        target: 'ws://localhost:4001',
        ws: true,
      },
    },
  },
});
