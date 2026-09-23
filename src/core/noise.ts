import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { fmix32, Salt, sfc32 } from './rng';

/**
 * World-seeded noise fields. Seeded only from the world seed (never the chunk), so values are
 * continuous across chunk borders.
 */
export class WorldNoise {
  private district: NoiseFunction2D;
  private density: NoiseFunction2D;
  private terrace: NoiseFunction2D;

  constructor(seed: number) {
    this.district = createNoise2D(sfc32(fmix32(seed ^ (Salt.Noise * 0x1000193))));
    this.density = createNoise2D(sfc32(fmix32(seed ^ (Salt.Noise * 0x2000193 + 1))));
    this.terrace = createNoise2D(sfc32(fmix32(seed ^ (Salt.Noise * 0x3000193 + 2))));
  }

  /** -1..1, low frequency: which kind of district a chunk belongs to. */
  districtAt(cx: number, cz: number): number {
    return this.district(cx * 0.13 + 0.5, cz * 0.13 + 0.5);
  }

  /** 0..1 building density. */
  densityAt(cx: number, cz: number): number {
    return this.density(cx * 0.21 + 3.1, cz * 0.21 - 1.7) * 0.5 + 0.5;
  }

  /** -1..1 for lot height terracing. */
  terraceAt(cx: number, cz: number): number {
    return this.terrace(cx * 0.35 - 7.3, cz * 0.35 + 2.9);
  }
}

const cache = new Map<number, WorldNoise>();

export function worldNoise(seed: number): WorldNoise {
  let n = cache.get(seed);
  if (!n) {
    n = new WorldNoise(seed);
    if (cache.size > 8) cache.clear();
    cache.set(seed, n);
  }
  return n;
}
