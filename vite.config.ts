import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500, rolldownOptions: { input: { main: 'index.html', gen: 'gen.html' } } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
