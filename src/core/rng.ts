/** murmur3 finalizer: a fast, well-distributed 32-bit integer hash. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash of (seed, x, z, salt). Nested so that (x, z) and (z, x) differ. */
export function hash3(seed: number, x: number, z: number, salt: number): number {
  return fmix32(fmix32(fmix32(fmix32(seed) ^ (x | 0)) ^ (z | 0)) ^ salt);
}

/** Hash of four integers, used for per-shot spread and similar keyed randomness. */
export function hash4(a: number, b: number, c: number, d: number): number {
  return fmix32(hash3(a, b, c, 0x5bd1e995) ^ (d | 0));
}

/** FNV-1a string hash, used to turn a text seed into a number. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Rand = () => number;

/** sfc32 PRNG returning floats in [0, 1). */
export function sfc32(seed: number): Rand {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  const next = () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** Independent random streams per chunk, so changing spawn logic never changes layout. */
export const Salt = {
  Layout: 1,
  Props: 2,
  Encounter: 3,
  EdgeX: 4,
  EdgeZ: 5,
  Names: 6,
  Noise: 7,
  Tint: 8,
  Spread: 9,
  Bot: 10,
  Pickups: 11,
  Loot: 12,
  Grenade: 13,
  Facades: 14,
  Breakables: 15,
  Landmark: 16,
} as const;

/** Integer in [lo, hi] inclusive. */
export const randInt = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const randRange = (r: Rand, lo: number, hi: number) => lo + r() * (hi - lo);
export const chance = (r: Rand, p: number) => r() < p;
export function pick<T>(r: Rand, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)];
}
export function weighted<T>(r: Rand, items: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let x = r() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x < 0) return v;
  }
  return items[items.length - 1][0];
}
