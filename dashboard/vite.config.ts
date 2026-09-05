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
      '/ws': {
        target: 'ws://localhost:4001',
        ws: true,
      },
    },
  },
});
