import { Contents, Ramp } from '../../physics/brush';
import { BRUSH_STRIDE, NAV_CELL, NAV_RES, NavFlag, wordContents, wordRamp } from './ChunkData';
import { LOT0, LOT1 } from './streets';

/** Half-width of a standing bot hull (16 HU = 0.406 m) plus clearance so paths never scrape corners. */
const INFLATE = 0.46;
/** Largest floor height difference between neighboring spans a bot can walk (stairs, curbs). */
export const NAV_STEP = 0.45;
const STEP_CM = NAV_STEP * 100;
const BODY_LO = 0.45;
const BODY_HI = 1.83;

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

/**
 * Layered nav: each 0.5 m column holds zero or more walkable *spans* (floors a bot can stand
 * on), sorted bottom-up, so upper storeys, rooftops and anything underground coexist with the
 * street below. Span arrays are indexed by span id; `col` holds each column's first span id
 * (column `c` owns spans `col[c]` to `col[c + 1] - 1`).
 */
/**
 * Off-grid link record (ladders), in both directions: from span, to span, cost (in cells),
 * and the ladder's outward normal nx, nz.
 */
export const NAV_LINK_STRIDE = 5;

export interface NavBake {
  links: Float32Array;
  col: Uint16Array;
  /** Floor height in cm per span. */
  floor: Int16Array;
  flags: Uint8Array;
  /** 8-direction cover bitmask per span (bit i = cover towards direction i*45°). */
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

/** Column index of every span (the inverse of `col`). */
export function spanColumns(col: Uint16Array): Uint16Array {
  const n = col.length ? col[col.length - 1] : 0;
  const out = new Uint16Array(n);
  for (let c = 0; c + 1 < col.length; c++) out.fill(c, col[c], col[c + 1]);
  return out;
}

/** Span in column `c` whose floor (cm) is within a step of `fromCm`, or -1. */
function stepSpan(nav: NavBake, c: number, fromCm: number): number {
  const s0 = nav.col[c];
  const e = nav.col[c + 1];
  if (e - s0 === 1) {
    const d = nav.floor[s0] - fromCm;
    return d <= STEP_CM && d >= -STEP_CM ? s0 : -1;
  }
  for (let s = s0; s < e; s++) {
    const d = nav.floor[s] - fromCm;
    if (d <= STEP_CM && d >= -STEP_CM) return s;
  }
  return -1;
}

/** Growable vertical interval lists per column (exact brush footprints). */
class Columns {
  head: Int32Array;
  next = new Int32Array(1 << 16);
  y0 = new Float32Array(1 << 16);
  y1 = new Float32Array(1 << 16);
  floor = new Uint8Array(1 << 16);
  n = 0;

  constructor(cells: number) {
    this.head = new Int32Array(cells).fill(-1);
  }

  push(c: number, y0: number, y1: number, isFloor: boolean): void {
    if (this.n === this.next.length) {
      const grow = <T extends Int32Array | Float32Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.next = grow(this.next);
      this.y0 = grow(this.y0);
      this.y1 = grow(this.y1);
      this.floor = grow(this.floor);
    }
    const k = this.n++;
    this.y0[k] = y0;
    this.y1[k] = y1;
    this.floor[k] = isFloor ? 1 : 0;
    this.next[k] = this.head[c];
    this.head[c] = k;
  }
}

/**
 * Rasterize a chunk's brushes into a 0.5 m layered walkability grid: the floors in each column
 * with room to stand, blocked spans (a bot hull would intersect solid), cover directions and
 * reachability from the street.
 */
export function bakeNav(packed: Int32Array, ladders: readonly number[] = []): NavBake {
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
  const NN = N * N;

  /** Cell index range whose centers lie within [a, b] (meters). */
  const lo = (a: number) => Math.max(0, Math.ceil(a / NAV_CELL - 0.5));
  const hi = (b: number) => Math.min(N - 1, Math.floor(b / NAV_CELL - 0.5));

  // Pass 1: rasterize exact footprints into per-column vertical intervals.
  const cols = new Columns(NN);
  // Per column: highest top, and highest bottom (if that is below a floor's head height,
  // everything in the column stands at body height and the highest top is the obstacle).
  const colTop = new Float32Array(NN).fill(-Infinity);
  const colBottom = new Float32Array(NN).fill(-Infinity);
  for (const b of brushes) {
    const isFloor = (b.contents & Contents.FLOOR) !== 0;
    const i0 = lo(b.x0);
    const i1 = hi(b.x1);
    const j0 = lo(b.z0);
    const j1 = hi(b.z1);
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * NAV_CELL;
      for (let i = i0; i <= i1; i++) {
        const t = b.ramp === Ramp.None ? b.y1 : topAt(b, (i + 0.5) * NAV_CELL, z);
        const c = j * N + i;
        cols.push(c, b.y0, t, isFloor);
        if (t > colTop[c]) colTop[c] = t;
        if (b.y0 > colBottom[c]) colBottom[c] = b.y0;
      }
    }
  }

  // Pass 2: candidate spans per column: FLOOR tops not buried in another brush. Floors less
  // than a step apart merge into the upper one (a curb on a slab).
  const start = new Int32Array(NN + 1);
  let spanF = new Float32Array(NN * 2);
  let count = 0;
  const tops = new Float32Array(64);
  const { head: cHead, next: cNext, y0: cY0, y1: cY1, floor: cFloor } = cols;
  for (let c = 0; c < NN; c++) {
    start[c] = count;
    let nt = 0;
    for (let k = cHead[c]; k >= 0; k = cNext[k]) {
      if (!cFloor[k]) continue;
      const t = cY1[k];
      // Nothing in the column rises past a step above this floor: it can't be buried.
      let buried = false;
      if (colTop[c] > t + BODY_LO) {
        for (let q = cHead[c]; q >= 0; q = cNext[q]) {
          if (q !== k && cY0[q] < t + BODY_HI && cY1[q] > t + BODY_LO) {
            buried = true;
            break;
          }
        }
      }
      if (buried || nt === tops.length) continue;
      // Insertion sort, ascending (columns hold a handful of floors).
      let p = nt++;
      while (p > 0 && tops[p - 1] > t) {
        tops[p] = tops[p - 1];
        p--;
      }
      tops[p] = t;
    }
    for (let s = 0; s < nt; s++) {
      if (s + 1 < nt && tops[s + 1] - tops[s] <= NAV_STEP) continue;
      if (count === spanF.length) {
        const g = new Float32Array(spanF.length * 2);
        g.set(spanF);
        spanF = g;
      }
      spanF[count++] = tops[s];
    }
  }
  start[NN] = count;

  // Pass 3: rasterize inflated brushes: a span is blocked if a bot hull standing on it would
  // intersect the brush; a ceiling over it marks it indoor.
  const blocked = new Uint8Array(count);
  const indoor = new Uint8Array(count);
  for (const b of brushes) {
    const i0 = lo(b.x0 - INFLATE);
    const i1 = hi(b.x1 + INFLATE);
    const j0 = lo(b.z0 - INFLATE);
    const j1 = hi(b.z1 + INFLATE);
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * NAV_CELL;
      for (let i = i0; i <= i1; i++) {
        const c = j * N + i;
        const s0 = start[c];
        const s1 = start[c + 1];
        if (s0 === s1) continue;
        const x = (i + 0.5) * NAV_CELL;
        const t = b.ramp === Ramp.None ? b.y1 : topAt(b, x, z);
        const inside = x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
        for (let s = s0; s < s1; s++) {
          if (blocked[s]) continue;
          const f = spanF[s];
          if (b.y0 < f + BODY_HI && t > f + BODY_LO) blocked[s] = 1;
          else if (inside && b.y0 > f + 1.9 && b.y0 < f + 8) indoor[s] = 1;
        }
      }
    }
  }

  // Compact: keep walkable spans only.
  const col = new Uint16Array(NN + 1);
  let kept = 0;
  for (let c = 0; c < NN; c++) {
    col[c] = kept;
    for (let s = start[c]; s < start[c + 1]; s++) if (!blocked[s]) kept++;
  }
  col[NN] = kept;
  if (kept > 0xffff) throw new Error(`nav: ${kept} spans exceed the 16-bit span index`);
  const floorM = new Float32Array(kept);
  const floor = new Int16Array(kept);
  const flags = new Uint8Array(kept);
  const cover = new Uint8Array(kept);
  const spanCol = new Uint16Array(kept);
  for (let j = 0, o = 0; j < N; j++) {
    const z = (j + 0.5) * NAV_CELL;
    const streetRow = z < LOT0 || z > LOT1;
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const x = (i + 0.5) * NAV_CELL;
      const street = streetRow || x < LOT0 || x > LOT1;
      for (let s = start[c]; s < start[c + 1]; s++) {
        if (blocked[s]) continue;
        floorM[o] = spanF[s];
        floor[o] = Math.round(spanF[s] * 100);
        let fl: number = NavFlag.Walkable;
        if (indoor[s]) fl |= NavFlag.Indoor;
        if (street) fl |= NavFlag.Street;
        flags[o] = fl;
        spanCol[o] = c;
        o++;
      }
    }
  }
  const nav: NavBake = { col, floor, flags, cover, links: new Float32Array(0) };

  // Ladder links: find the spans at both ends; a ladder whose ends aren't walkable is dropped.
  /** Walkable span nearest (x, y, z): in its cell or a neighboring one, within 0.6 m in height. */
  const spanNear = (x: number, y: number, z: number): number => {
    const ci = Math.floor(x / NAV_CELL);
    const cj = Math.floor(z / NAV_CELL);
    let best = -1;
    let bestD = Infinity;
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const c = j * N + i;
        const flat = Math.hypot((i + 0.5) * NAV_CELL - x, (j + 0.5) * NAV_CELL - z);
        for (let s = col[c]; s < col[c + 1]; s++) {
          const dy = Math.abs(floorM[s] - y);
          if (dy < 0.6 && flat + dy < bestD) {
            bestD = flat + dy;
            best = s;
          }
        }
      }
    }
    return best;
  };
  const links: number[] = [];
  for (let k = 0; k + 8 <= ladders.length; k += 8) {
    const lo = spanNear(ladders[k], ladders[k + 1], ladders[k + 2]);
    const up = spanNear(ladders[k + 3], ladders[k + 4], ladders[k + 5]);
    if (lo < 0 || up < 0) continue;
    const cost = 4 + (Math.abs(ladders[k + 4] - ladders[k + 1]) / NAV_CELL) * 1.5;
    links.push(lo, up, cost, ladders[k + 6], ladders[k + 7], up, lo, cost, ladders[k + 6], ladders[k + 7]);
  }
  nav.links = new Float32Array(links);
  const linksFrom = new Map<number, number[]>();
  for (let k = 0; k < links.length; k += NAV_LINK_STRIDE) {
    const list = linksFrom.get(links[k]);
    if (list) list.push(links[k + 1]);
    else linksFrom.set(links[k], [links[k + 1]]);
  }

  const W = NavFlag.Walkable;
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DZ = [0, 1, 1, 1, 0, -1, -1, -1];

  /** Height of whatever stands in column c at body height over floor f, relative to f. */
  const obstacleOver = (c: number, f: number): number => {
    if (colBottom[c] < f + BODY_HI) return colTop[c] - f;
    let h = -Infinity;
    for (let k = cHead[c]; k >= 0; k = cNext[k]) {
      if (cY0[k] < f + BODY_HI && cY1[k] - f > h) h = cY1[k] - f;
    }
    return h;
  };
  /** Whether column c has a walkable span within a step of floor fcm (cm). */
  const stepOk = (c: number, fcm: number): boolean => {
    for (let s = col[c], e = col[c + 1]; s < e; s++) {
      const d = floor[s] - fcm;
      if (d <= STEP_CM && d >= -STEP_CM) return true;
    }
    return false;
  };

  // Pass 4: near-wall and cover directions.
  for (let s = 0; s < kept; s++) {
    const c = spanCol[s];
    const i = c % N;
    const j = (c - i) / N;
    const f = floorM[s];
    const fcm = floor[s];
    let mask = 0;
    let half = false;
    let full = false;
    let nearWall = false;
    for (let d = 0; d < 8; d++) {
      const dx = DX[d];
      const dz = DZ[d];
      const ni = i + dx;
      const nj = j + dz;
      if (!nearWall && (ni < 0 || nj < 0 || ni >= N || nj >= N || !stepOk(nj * N + ni, fcm))) nearWall = true;
      for (let k = 1; k <= 2; k++) {
        const ki = i + dx * k;
        const kj = j + dz * k;
        if (ki < 0 || kj < 0 || ki >= N || kj >= N) break;
        const h = obstacleOver(kj * N + ki, f);
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
    cover[s] = mask;
    let fl = flags[s];
    if (nearWall) fl |= NavFlag.NearWall;
    if (full) fl |= NavFlag.CoverFull;
    if (half) fl |= NavFlag.CoverHalf;
    flags[s] = fl;
  }

  // Pass 5: flood fill reachability from walkable street spans.
  const R = NavFlag.Reachable;
  const queue = new Int32Array(kept);
  let head = 0;
  let tail = 0;
  for (let s = 0; s < kept; s++) {
    const fl = flags[s];
    if ((fl & NavFlag.Street) !== 0 && (fl & W) !== 0) {
      flags[s] = fl | R;
      queue[tail++] = s;
    }
  }
  while (head < tail) {
    const s = queue[head++];
    const c = spanCol[s];
    const i = c % N;
    const j = (c - i) / N;
    const fcm = floor[s];
    for (let d = 0; d < 8; d++) {
      const dx = DX[d];
      const dz = DZ[d];
      const ni = i + dx;
      const nj = j + dz;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const ns = stepSpan(nav, nj * N + ni, fcm);
      if (ns < 0 || (flags[ns] & R) !== 0) continue;
      // No corner cutting on diagonals.
      if (dx !== 0 && dz !== 0 && (!stepOk(j * N + ni, fcm) || !stepOk(nj * N + i, fcm))) continue;
      flags[ns] |= R;
      queue[tail++] = ns;
    }
    for (const ns of linksFrom.get(s) ?? []) {
      if (flags[ns] & R) continue;
      flags[ns] |= R;
      queue[tail++] = ns;
    }
  }

  return nav;
}
