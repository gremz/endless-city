import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { fmix32, hash3, sfc32 } from '../../core/rng';

/**
 * The city's big layout, above single chunks: a river, elevated highways, parks and plazas.
 * Everything here is a pure function of the seed and chunk coordinates, so any chunk can ask
 * about itself and its neighbors and every machine gets the same answer (seams line up).
 */

/** Salts for this layer (kept apart from the per-chunk salts in rng.ts). */
const PLAN_SALT = 0x51a7e;
/** Highway lines run along chunk seams every this many chunks. */
export const HIGHWAY_PERIOD = 12;
/** Side indices: 0 = -Z, 1 = +Z, 2 = -X, 3 = +X. */
export type Side = 0 | 1 | 2 | 3;
export const SIDE_DX = [0, 0, -1, 1] as const;
export const SIDE_DZ = [-1, 1, 0, 0] as const;

interface RiverShape {
  /** River flows along X (it occupies rows of constant-ish cz), else along Z. */
  alongX: boolean;
  /** Centerline row offset and meander. */
  base: number;
  amp: number;
  noise: NoiseFunction2D;
}

const shapes = new Map<number, RiverShape>();

function riverShape(seed: number): RiverShape {
  let s = shapes.get(seed);
  if (!s) {
    const r = sfc32(fmix32(seed ^ PLAN_SALT));
    const alongX = r() < 0.5;
    // Keep the river at least 3 chunks off spawn everywhere: |base| - amp >= 3.
    const base = (5 + Math.floor(r() * 4)) * (r() < 0.5 ? -1 : 1);
    s = { alongX, base, amp: 2, noise: createNoise2D(sfc32(fmix32(seed ^ (PLAN_SALT * 3)))) };
    if (shapes.size > 8) shapes.clear();
    shapes.set(seed, s);
  }
  return s;
}

/** The river's row at position `a` along its axis. */
function riverRow(s: RiverShape, a: number): number {
  return Math.round(s.base + s.amp * s.noise(a * 0.09, 0.37));
}

/**
 * Whether chunk (cx, cz) is river. Column a holds every row between its own centerline row and
 * the next column's, so the chain of river chunks is always connected edge to edge.
 */
export function isRiver(seed: number, cx: number, cz: number): boolean {
  const s = riverShape(seed);
  const a = s.alongX ? cx : cz;
  const b = s.alongX ? cz : cx;
  const r0 = riverRow(s, a);
  const r1 = riverRow(s, a + 1);
  return b >= Math.min(r0, r1) && b <= Math.max(r0, r1);
}

/** Whether the seam at x = sx * 64 (between chunk columns sx - 1 and sx) is a highway line. */
export function isHighwaySeam(seed: number, sx: number): boolean {
  const off = 2 + (fmix32(seed ^ (PLAN_SALT * 5)) % (HIGHWAY_PERIOD - 3));
  return (((sx - off) % HIGHWAY_PERIOD) + HIGHWAY_PERIOD) % HIGHWAY_PERIOD === 0;
}

export type Feature = 'park' | 'plaza';

/**
 * Park or plaza: one candidate chunk per 3x3 cell (jittered), and only some cells get one.
 * Never on the river, the spawn chunk, or next to the spawn.
 */
export function featureAt(seed: number, cx: number, cz: number): Feature | null {
  if (Math.max(Math.abs(cx), Math.abs(cz)) <= 1 || isRiver(seed, cx, cz)) return null;
  const mx = Math.floor(cx / 3);
  const mz = Math.floor(cz / 3);
  const h = hash3(seed ^ PLAN_SALT, mx, mz, 17);
  if (cx !== mx * 3 + (h % 3) || cz !== mz * 3 + ((h >>> 4) % 3)) return null;
  const roll = ((h >>> 8) & 0xff) / 256;
  return roll < 0.33 ? 'park' : roll < 0.55 ? 'plaza' : null;
}

/** Everything the chunk generator needs to know about the big layout around one chunk. */
export interface ChunkPlan {
  river: boolean;
  /** River neighbors per side (the channel runs through that side). */
  riverSides: [boolean, boolean, boolean, boolean];
  /** River sides whose seam road crosses on a bridge. */
  bridges: [boolean, boolean, boolean, boolean];
  /** Diagonal river neighbors: [-x-z, +x-z, -x+z, +x+z]. */
  riverCorners: [boolean, boolean, boolean, boolean];
  /** Highway along this chunk's -X seam / +X seam. */
  highwayWest: boolean;
  highwayEast: boolean;
  /** Which lot edge carries a highway on-ramp (2 = -X, 3 = +X), if any. */
  onRamp: 2 | 3 | null;
  feature: Feature | null;
}

/**
 * Whether the road on the seam between river chunks a and b crosses on a bridge (shared). The
 * whole seam line gets the same answer, so a road never bridges part of the way over the river.
 */
function bridgeOn(seed: number, ax: number, az: number, bx: number, bz: number): boolean {
  const onX = ax !== bx;
  const line = onX ? Math.max(ax, bx) : Math.max(az, bz);
  const h = hash3(seed ^ (PLAN_SALT * 7), line, onX ? 1 : 0, 23);
  // Mostly bridged, and never more than two unbridged roads in a row along the river.
  return h % 100 < 60 || line % 3 === 0;
}

export function chunkPlan(seed: number, cx: number, cz: number): ChunkPlan {
  const river = isRiver(seed, cx, cz);
  const riverSides = [0, 1, 2, 3].map((s) => river && isRiver(seed, cx + SIDE_DX[s], cz + SIDE_DZ[s])) as ChunkPlan['riverSides'];
  const bridges = [0, 1, 2, 3].map((s) => riverSides[s] && bridgeOn(seed, cx, cz, cx + SIDE_DX[s], cz + SIDE_DZ[s])) as ChunkPlan['bridges'];
  const riverCorners = (
    [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const
  ).map(([dx, dz]) => river && isRiver(seed, cx + dx, cz + dz)) as ChunkPlan['riverCorners'];
  const highwayWest = isHighwaySeam(seed, cx);
  const highwayEast = isHighwaySeam(seed, cx + 1);
  const feature = featureAt(seed, cx, cz);
  let onRamp: ChunkPlan['onRamp'] = null;
  if (!river && !feature && (highwayWest || highwayEast) && Math.max(Math.abs(cx), Math.abs(cz)) > 1) {
    // Every third chunk along a line has a ramp, alternating which side of the line.
    const line = highwayEast ? cx + 1 : cx;
    const h = hash3(seed ^ (PLAN_SALT * 11), line, Math.floor(cz / 3), 29);
    const rampZ = Math.floor(cz / 3) * 3 + (h % 3);
    const westSide = ((h >>> 3) & 1) === 1; // the chunk west of the line gets it
    if (cz === rampZ) {
      if (highwayEast && westSide) onRamp = 3;
      else if (highwayWest && !westSide) onRamp = 2;
    }
  }
  return { river, riverSides, bridges, riverCorners, highwayWest, highwayEast, onRamp, feature };
}
