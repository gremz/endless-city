import { Contents, Ramp } from '../../physics/brush';
import { BRUSH_STRIDE, NAV_CELL, NAV_RES, NavFlag, wordContents, wordRamp } from './ChunkData';
import { LOT0, LOT1 } from './streets';

/** Half-width of a standing bot hull (16 HU) plus a little slack. */
const INFLATE = 0.41;
const STEP = 0.45;
const BODY_LO = 0.45;
const BODY_HI = 1.83;
export const NO_FLOOR = -32768;

interface B {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  contents: number;
  ramp: number;
}

function topAt(b: B, x: number, z: number): number {
  if (b.ramp === Ramp.None) return b.y1;
  const h = b.y1 - b.y0;
  const cx = Math.min(b.x1, Math.max(b.x0, x));
  const cz = Math.min(b.z1, Math.max(b.z0, z));
  let t: number;
  switch (b.ramp) {
    case Ramp.PosX:
      t = (cx - b.x0) / (b.x1 - b.x0);
      break;
    case Ramp.NegX:
      t = (b.x1 - cx) / (b.x1 - b.x0);
      break;
    case Ramp.PosZ:
      t = (cz - b.z0) / (b.z1 - b.z0);
      break;
    default:
      t = (b.z1 - cz) / (b.z1 - b.z0);
      break;
  }
  return b.y0 + h * t;
}

export interface NavBake {
  floor: Int16Array;
  flags: Uint8Array;
  cover: Uint8Array;
}

/** 8 neighbor directions (dx, dz), index i = i*45° starting at +X. */
export const DIRS: readonly [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Rasterize a chunk's brushes into a 0.5 m walkability grid: floor height, blocked cells (a bot
 * hull would intersect solid), cover directions and reachability from the street.
 */
export function bakeNav(packed: Int32Array): NavBake {
  const n = packed.length / BRUSH_STRIDE;
  const brushes: B[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * BRUSH_STRIDE;
    const c = wordContents(packed[o + 6]);
    if ((c & Contents.SOLID_PLAYER) === 0) continue;
    brushes.push({
      x0: packed[o] / 100,
      y0: packed[o + 1] / 100,
      z0: packed[o + 2] / 100,
      x1: packed[o + 3] / 100,
      y1: packed[o + 4] / 100,
      z1: packed[o + 5] / 100,
      contents: c,
      ramp: wordRamp(packed[o + 6]),
    });
  }
  const N = NAV_RES;
  const floorM = new Float32Array(N * N).fill(-Infinity);
  const obstacle = new Float32Array(N * N).fill(-Infinity);
  const blocked = new Uint8Array(N * N);
  const indoor = new Uint8Array(N * N);
  const flags = new Uint8Array(N * N);
  const cover = new Uint8Array(N * N);

  /** Cell index range whose centers lie within [a, b] (meters). */
  const lo = (a: number) => Math.max(0, Math.ceil(a / NAV_CELL - 0.5));
  const hi = (b: number) => Math.min(N - 1, Math.floor(b / NAV_CELL - 0.5));

  // Pass 1: rasterize brushes: floor height (highest FLOOR top) and obstacle top per cell.
  for (const b of brushes) {
    const isFloor = (b.contents & Contents.FLOOR) !== 0;
    const i0 = lo(b.x0);
    const i1 = hi(b.x1);
    const j0 = lo(b.z0);
    const j1 = hi(b.z1);
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * NAV_CELL;
      for (let i = i0; i <= i1; i++) {
        const idx = j * N + i;
        const t = b.ramp === Ramp.None ? b.y1 : topAt(b, (i + 0.5) * NAV_CELL, z);
        if (isFloor && t > floorM[idx]) floorM[idx] = t;
        if (t > obstacle[idx]) obstacle[idx] = t;
      }
    }
  }

  // Pass 2: rasterize inflated brushes: a cell is blocked if a bot hull standing on its floor
  // would intersect the brush; ceilings over the cell mark it indoor.
  for (const b of brushes) {
    const i0 = lo(b.x0 - INFLATE);
    const i1 = hi(b.x1 + INFLATE);
    const j0 = lo(b.z0 - INFLATE);
    const j1 = hi(b.z1 + INFLATE);
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * NAV_CELL;
      for (let i = i0; i <= i1; i++) {
        const idx = j * N + i;
        const f = floorM[idx];
        if (f === -Infinity || blocked[idx]) continue;
        const x = (i + 0.5) * NAV_CELL;
        const t = b.ramp === Ramp.None ? b.y1 : topAt(b, x, z);
        if (b.y0 < f + BODY_HI && t > f + BODY_LO) {
          blocked[idx] = 1;
        } else if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.y0 > f + 1.9 && b.y0 < f + 8) {
          indoor[idx] = 1;
        }
      }
    }
  }

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      if (floorM[idx] === -Infinity || blocked[idx]) continue;
      const x = (i + 0.5) * NAV_CELL;
      const z = (j + 0.5) * NAV_CELL;
      let fl: number = NavFlag.Walkable;
      if (indoor[idx]) fl |= NavFlag.Indoor;
      if (x < LOT0 || x > LOT1 || z < LOT0 || z > LOT1) fl |= NavFlag.Street;
      flags[idx] = fl;
    }
  }

  const W = NavFlag.Walkable;
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DZ = [0, 1, 1, 1, 0, -1, -1, -1];

  // Pass 3: near-wall and cover directions.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      if ((flags[idx] & W) === 0) continue;
      const f = floorM[idx];
      let mask = 0;
      let half = false;
      let full = false;
      let nearWall = false;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d];
        const dz = DZ[d];
        const ni = i + dx;
        const nj = j + dz;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N || (flags[nj * N + ni] & W) === 0) nearWall = true;
        for (let k = 1; k <= 2; k++) {
          const ki = i + dx * k;
          const kj = j + dz * k;
          if (ki < 0 || kj < 0 || ki >= N || kj >= N) break;
          const h = obstacle[kj * N + ki] - f;
          if (h >= 1.8) {
            mask |= 1 << d;
            full = true;
            break;
          }
          if (h >= 0.95) {
            mask |= 1 << d;
            half = true;
            break;
          }
        }
      }
      cover[idx] = mask;
      let fl = flags[idx];
      if (nearWall) fl |= NavFlag.NearWall;
      if (full) fl |= NavFlag.CoverFull;
      if (half) fl |= NavFlag.CoverHalf;
      flags[idx] = fl;
    }
  }

  // Pass 4: flood fill reachability from walkable street cells.
  const R = NavFlag.Reachable;
  const queue = new Int32Array(N * N);
  let head = 0;
  let tail = 0;
  for (let idx = 0; idx < N * N; idx++) {
    const fl = flags[idx];
    if ((fl & NavFlag.Street) !== 0 && (fl & W) !== 0) {
      flags[idx] = fl | R;
      queue[tail++] = idx;
    }
  }
  while (head < tail) {
    const idx = queue[head++];
    const i = idx % N;
    const j = (idx - i) / N;
    const f = floorM[idx];
    for (let d = 0; d < 8; d++) {
      const dx = DX[d];
      const dz = DZ[d];
      const ni = i + dx;
      const nj = j + dz;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const nidx = nj * N + ni;
      const nf = flags[nidx];
      if ((nf & W) === 0 || (nf & R) !== 0) continue;
      // No corner cutting on diagonals.
      if (dx !== 0 && dz !== 0 && ((flags[j * N + ni] & W) === 0 || (flags[nj * N + i] & W) === 0)) continue;
      const df = floorM[nidx] - f;
      if (df > STEP || df < -STEP) continue;
      flags[nidx] = nf | R;
      queue[tail++] = nidx;
    }
  }

  const floor = new Int16Array(N * N);
  for (let idx = 0; idx < N * N; idx++) {
    floor[idx] = flags[idx] & NavFlag.Walkable ? Math.round(floorM[idx] * 100) : NO_FLOOR;
  }
  return { floor, flags, cover };
}
