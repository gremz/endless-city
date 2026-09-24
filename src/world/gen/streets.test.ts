import { describe, expect, it } from 'vitest';
import { sfc32 } from '../../core/rng';
import { Contents } from '../../physics/brush';
import { BrushWriter } from './BrushWriter';
import { BRUSH_STRIDE, Material, wordContents, wordMaterial } from './ChunkData';
import { bakeMeshes } from './meshBake';
import { car } from './streets';

const CAR_MATERIALS = [Material.CarPaint, Material.CarGlass, Material.CarWheel, Material.CarTrim];

function buildCar(seed: number, alongX: boolean, lane: number, at: number, y: number): Int32Array {
  const w = new BrushWriter();
  car(w, sfc32(seed), alongX, lane, at, y);
  return w.finish();
}

describe('car', () => {
  it('stays inside its 4.3 x 1.8 x 1.5 m footprint in both orientations', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const alongX of [true, false]) {
        const lane = 10;
        const at = 20;
        const y = 0.5;
        const b = buildCar(seed, alongX, lane, at, y);
        const [sx0, sx1, sz0, sz1] = alongX ? [at, at + 4.3, lane, lane + 1.8] : [lane, lane + 1.8, at, at + 4.3];
        expect(b.length / BRUSH_STRIDE).toBeGreaterThan(20);
        for (let o = 0; o < b.length; o += BRUSH_STRIDE) {
          expect(b[o]).toBeGreaterThanOrEqual(Math.round(sx0 * 100));
          expect(b[o + 3]).toBeLessThanOrEqual(Math.round(sx1 * 100));
          expect(b[o + 2]).toBeGreaterThanOrEqual(Math.round(sz0 * 100));
          expect(b[o + 5]).toBeLessThanOrEqual(Math.round(sz1 * 100));
          expect(b[o + 1]).toBeGreaterThanOrEqual(Math.round(y * 100));
          expect(b[o + 4]).toBeLessThanOrEqual(Math.round((y + 1.5) * 100));
          expect(b[o + 3]).toBeGreaterThan(b[o]);
          expect(b[o + 4]).toBeGreaterThan(b[o + 1]);
          expect(b[o + 5]).toBeGreaterThan(b[o + 2]);
        }
      }
    }
  });

  it('uses every car material, with a solid tire, body and glass', () => {
    const b = buildCar(7, true, 0, 0, 0);
    const solid = new Set<number>();
    const all = new Set<number>();
    for (let o = 0; o < b.length; o += BRUSH_STRIDE) {
      const m = wordMaterial(b[o + 6]);
      all.add(m);
      if (wordContents(b[o + 6]) & Contents.SOLID_PLAYER) solid.add(m);
    }
    for (const m of CAR_MATERIALS) expect(all.has(m)).toBe(true);
    for (const m of [Material.CarPaint, Material.CarGlass, Material.CarTrim]) expect(solid.has(m)).toBe(true);
  });

  it('consumes exactly one value from the chunk rng', () => {
    const r = sfc32(1234);
    car(new BrushWriter(), r, false, 0, 0);
    const ref = sfc32(1234);
    ref();
    expect(r()).toBe(ref());
  });

  it('bakes a mesh per car material', () => {
    const meshes = bakeMeshes(buildCar(3, false, 5, 5, 0));
    const mats = meshes.map((m) => m.material).sort((a, b) => a - b);
    expect(mats).toEqual([...CAR_MATERIALS].sort((a, b) => a - b));
  });
});
