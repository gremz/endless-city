import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
