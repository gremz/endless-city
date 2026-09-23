import { describe, expect, it } from 'vitest';
import { fmix32, fnv1a, hash3, randInt, sfc32 } from './rng';

describe('rng', () => {
  it('fmix32 is a stable 32-bit hash', () => {
    expect(fmix32(0)).toBe(0);
    expect(fmix32(1)).toBe(fmix32(1));
    expect(fmix32(1)).not.toBe(fmix32(2));
    expect(fmix32(123456) >>> 0).toBe(fmix32(123456));
  });

  it('hash3 is order sensitive and handles negative coordinates', () => {
    expect(hash3(1337, 1, 2, 1)).not.toBe(hash3(1337, 2, 1, 1));
    expect(hash3(1337, -1, -2, 1)).toBe(hash3(1337, -1, -2, 1));
    expect(hash3(1337, -1, 0, 1)).not.toBe(hash3(1337, 1, 0, 1));
    expect(hash3(1337, 3, 4, 1)).not.toBe(hash3(1337, 3, 4, 2));
  });

  it('sfc32 is deterministic and in [0,1)', () => {
    const a = sfc32(42);
    const b = sfc32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('sfc32 is roughly uniform', () => {
    const r = sfc32(7);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100000; i++) buckets[Math.floor(r() * 10)]++;
    for (const b of buckets) expect(Math.abs(b - 10000)).toBeLessThan(500);
  });

  it('randInt is inclusive', () => {
    const r = sfc32(3);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(randInt(r, 1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('fnv1a hashes strings', () => {
    expect(fnv1a('dust2')).toBe(fnv1a('dust2'));
    expect(fnv1a('dust2')).not.toBe(fnv1a('inferno'));
  });
});
