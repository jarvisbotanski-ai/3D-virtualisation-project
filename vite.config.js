import { defineConfig } from 'vite';

// Local only: always bind to 127.0.0.1 (never 0.0.0.0 / --host).
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { usePolling: true, interval: 300 } },
  preview: { host: '127.0.0.1', port: 4173 },
  assetsInclude: ['**/*.glb'],
  // reference/ holds the old mockup + render harness; keep them out of dep scanning and the build.
  optimizeDeps: { entries: ['index.html'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
