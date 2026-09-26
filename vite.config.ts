import { defineConfig } from 'vitest/config';

declare const process: { env: Record<string, string | undefined> };

/**
 * Extra hostnames the dev server answers to (e.g. a tunnel for testing with friends), comma
 * separated: `ALLOWED_HOSTS=abc.free.pinggy.net npm run dev`. Keep tunnel names out of the repo.
 */
const allowedHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true, allowedHosts },
  worker: { format: 'es' },
  assetsInclude: ['**/*.glb'],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500, rolldownOptions: { input: { main: 'index.html', gen: 'gen.html', models: 'models.html', voices: 'voices.html' } } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
