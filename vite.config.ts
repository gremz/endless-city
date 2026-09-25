import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true, allowedHosts: ['zpjjc-73-22-104-151.free.pinggy.net'] },
  worker: { format: 'es' },
  assetsInclude: ['**/*.glb'],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500, rolldownOptions: { input: { main: 'index.html', gen: 'gen.html', models: 'models.html' } } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
