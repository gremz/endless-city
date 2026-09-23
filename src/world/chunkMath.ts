import { CHUNK } from '../core/config';

const BIAS = 1 << 15;

/** Numeric key for a chunk coordinate pair (valid for |c| < 32768, i.e. ±2000 km). */
export const chunkKey = (cx: number, cz: number) => (cx + BIAS) * 65536 + (cz + BIAS);

export function keyToCoords(key: number): [number, number] {
  const cx = Math.floor(key / 65536) - BIAS;
  const cz = (key % 65536) - BIAS;
  return [cx, cz];
}

export const worldToChunk = (v: number) => Math.floor(v / CHUNK);

/** Chebyshev distance between chunks. */
export const chunkDist = (ax: number, az: number, bx: number, bz: number) =>
  Math.max(Math.abs(ax - bx), Math.abs(az - bz));
