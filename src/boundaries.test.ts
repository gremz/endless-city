import { describe, expect, it } from 'vitest';

/**
 * The simulation must stay headless (testable in Node, network-ready): these folders may not
 * import three.js or touch the DOM, and generation/simulation code may not use Math.random.
 */
const SOURCES = import.meta.glob<string>(['./{core,physics,player,weapons,ai,world,sim}/**/*.ts', '!./**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const ALLOWED = new Set(['core/settings.ts', 'player/CameraController.ts', 'world/WorkerChunkSource.ts', 'world/gen.worker.ts', 'physics/testUtil.ts']);
const NO_RANDOM = ['world/gen', 'sim', 'weapons', 'physics', 'player'];

describe('architecture boundaries', () => {
  it('finds the sources', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(30);
  });

  it('headless folders never import three.js or touch the DOM', () => {
    for (const [path, src] of Object.entries(SOURCES)) {
      const rel = path.replace(/^\.\//, '');
      if (ALLOWED.has(rel)) continue;
      expect(/from ['"]three['"]|from ['"]three\//.test(src), `${rel} imports three`).toBe(false);
      expect(/\b(window|document)\./.test(src), `${rel} touches the DOM`).toBe(false);
    }
  });

  it('generation and simulation never use Math.random', () => {
    for (const [path, src] of Object.entries(SOURCES)) {
      const rel = path.replace(/^\.\//, '');
      if (!NO_RANDOM.some((d) => rel.startsWith(d))) continue;
      expect(/Math\.random\(/.test(src), `${rel} uses Math.random`).toBe(false);
    }
  });
});
