import { describe, expect, it } from 'vitest';
import { CHUNK } from '../../core/config';
import { fnv1a } from '../../core/rng';
import { BRUSH_STRIDE, NAV_CELL, NAV_RES, NavFlag, type ChunkData } from './ChunkData';
import { generateChunk } from './generateChunk';

function digest(d: ChunkData): number {
  let h = 0x811c9dc5;
  const mix = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i++) {
      h ^= arr[i] & 0xffff;
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(d.brushes);
  mix(d.navFlags);
  mix(d.navFloor);
  mix(new Int32Array(d.spawns.buffer.slice(0)));
  return h >>> 0;
}

describe('generateChunk', () => {
  it('is deterministic for the same (seed, cx, cz)', () => {
    for (const [cx, cz] of [
      [0, 0],
      [3, -2],
      [-7, 11],
    ]) {
      const a = generateChunk(1337, cx, cz);
      const b = generateChunk(1337, cx, cz);
      expect(digest(a)).toBe(digest(b));
      expect(a.brushes).toEqual(b.brushes);
    }
  });

  it('differs between chunks and seeds', () => {
    expect(digest(generateChunk(1337, 2, 3))).not.toBe(digest(generateChunk(1337, 3, 2)));
    expect(digest(generateChunk(1337, 2, 3))).not.toBe(digest(generateChunk(42, 2, 3)));
  });

  it('keeps every brush inside its own chunk', () => {
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const d = generateChunk(99, cx, cz);
        for (let i = 0; i < d.brushes.length; i += BRUSH_STRIDE) {
          expect(d.brushes[i]).toBeGreaterThanOrEqual(0);
          expect(d.brushes[i + 2]).toBeGreaterThanOrEqual(0);
          expect(d.brushes[i + 3]).toBeLessThanOrEqual(CHUNK * 100);
          expect(d.brushes[i + 5]).toBeLessThanOrEqual(CHUNK * 100);
        }
      }
    }
  });

  it('streets are walkable and connect across chunk seams', () => {
    const a = generateChunk(5, 0, 0);
    const b = generateChunk(5, 1, 0);
    // Road cells along the shared edge: a's last column and b's first column.
    let aOpen = 0;
    let bOpen = 0;
    for (let j = 10; j < NAV_RES - 10; j++) {
      if (a.navFlags[j * NAV_RES + NAV_RES - 1] & NavFlag.Walkable) aOpen++;
      if (b.navFlags[j * NAV_RES] & NavFlag.Walkable) bOpen++;
    }
    expect(aOpen).toBeGreaterThan(40);
    expect(bOpen).toBeGreaterThan(40);
  });

  it('places health packs deterministically, inside the chunk, spaced apart', () => {
    let total = 0;
    for (let k = 0; k < 40; k++) {
      const cx = (k % 8) - 4;
      const cz = Math.floor(k / 8) - 2;
      const a = generateChunk(31, cx, cz);
      expect(a.pickups).toEqual(generateChunk(31, cx, cz).pickups);
      for (let s = 0; s < a.pickups.length; s += 3) {
        expect(a.pickups[s]).toBeGreaterThanOrEqual(cx * CHUNK);
        expect(a.pickups[s]).toBeLessThan((cx + 1) * CHUNK);
        expect(a.pickups[s + 2]).toBeGreaterThanOrEqual(cz * CHUNK);
        expect(a.pickups[s + 2]).toBeLessThan((cz + 1) * CHUNK);
        for (let t = s + 3; t < a.pickups.length; t += 3) {
          expect(Math.hypot(a.pickups[s] - a.pickups[t], a.pickups[s + 2] - a.pickups[t + 2])).toBeGreaterThanOrEqual(11.9);
        }
      }
      expect(a.pickups.length / 3).toBeLessThanOrEqual(2);
      total += a.pickups.length / 3;
    }
    expect(total).toBeGreaterThan(15);
  });

  it('the spawn plaza always has a health pack near the drop-in point', () => {
    for (const seed of [1, 1337, 2024]) {
      const d = generateChunk(seed, 0, 0);
      expect(d.pickups.length).toBe(3);
      expect(Math.hypot(d.pickups[0] - 32, d.pickups[2] - 22)).toBeLessThan(15);
    }
  });

  it('every spawn slot and patrol point is on a reachable walkable cell (200 chunks)', () => {
    let totalSpawns = 0;
    let encounters = 0;
    for (let k = 0; k < 200; k++) {
      const cx = (k % 20) - 10;
      const cz = Math.floor(k / 20) - 5;
      const d = generateChunk(2024, cx, cz);
      const check = (arr: Float32Array) => {
        for (let s = 0; s < arr.length; s += 3) {
          const i = Math.floor((arr[s] - cx * CHUNK) / NAV_CELL);
          const j = Math.floor((arr[s + 2] - cz * CHUNK) / NAV_CELL);
          const f = d.navFlags[j * NAV_RES + i];
          expect(f & NavFlag.Walkable).toBeTruthy();
          expect(f & NavFlag.Reachable).toBeTruthy();
        }
      };
      check(d.spawns);
      check(d.patrol);
      check(d.pickups);
      totalSpawns += d.spawns.length / 3;
      if (d.hasEncounter) encounters++;
      // A good share of the lot should be reachable from the street.
      let lotWalk = 0;
      let lotReach = 0;
      for (let idx = 0; idx < NAV_RES * NAV_RES; idx++) {
        const f = d.navFlags[idx];
        if (f & NavFlag.Walkable && !(f & NavFlag.Street)) {
          lotWalk++;
          if (f & NavFlag.Reachable) lotReach++;
        }
      }
      expect(lotReach / Math.max(1, lotWalk)).toBeGreaterThan(0.6);
    }
    expect(totalSpawns / 200).toBeGreaterThan(8);
    expect(encounters).toBeGreaterThan(60);
  }, 60000);

  it('generates fast enough', () => {
    const t0 = performance.now();
    for (let k = 0; k < 30; k++) generateChunk(77, k, -k);
    const avg = (performance.now() - t0) / 30;
    expect(avg).toBeLessThan(40);
  });
});
