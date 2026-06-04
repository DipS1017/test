import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Go API runs on :8090. We proxy /api → :8090 so the browser only ever
// talks to the Vite dev origin (no CORS dance for the REST calls). The two
// genuinely cross-origin hops — WHIP publish to MediaMTX (:28889) and HLS
// playback from MinIO (:9000) — are made directly and rely on those servers'
// own CORS headers (both already send permissive ones in dev).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8090',
        changeOrigin: true,
      },
    },
  },
});
