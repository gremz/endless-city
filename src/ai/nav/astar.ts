import { NAV_RES, NavFlag } from '../../world/gen/ChunkData';
import { cellCenter, type NavGrid } from './NavGrid';

const STEP = 0.45;
const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DZ = [0, 1, 0, -1, 1, 1, -1, -1];
const COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

export interface PathPoint {
  x: number;
  y: number;
  z: number;
}

export interface PathOptions {
  /** Extra cost for entering a cell (e.g. flank routes avoiding the enemy's view). */
  extraCost?: (gx: number, gz: number) => number;
  /** Cells to keep out of (fires): expensive to enter, and never cut through when smoothing. */
  hazard?: (gx: number, gz: number) => boolean;
  maxExpansions?: number;
}

/** Cost of stepping into a hazard cell: high enough to go around, low enough to walk out of one. */
const HAZARD_COST = 40;
type CellTest = ((gx: number, gz: number) => boolean) | undefined;

export interface PathResult {
  points: PathPoint[];
  /** False if the goal was not reached (partial path towards it). */
  complete: boolean;
  expansions: number;
}

/**
 * A* over a window of 3x3 chunks (384 x 384 cells) of the global nav grid, with
 * preallocated arrays and visit stamps so queries never allocate or clear.
 */
export class AStar {
  static readonly W = NAV_RES * 3;
  private g = new Float32Array(AStar.W * AStar.W);
  private parent = new Int32Array(AStar.W * AStar.W);
  private stamp = new Uint32Array(AStar.W * AStar.W);
  private closed = new Uint32Array(AStar.W * AStar.W);
  private heap = new Int32Array(AStar.W * AStar.W);
  private heapF = new Float32Array(AStar.W * AStar.W);
  private heapSize = 0;
  private cur = 0;
  queries = 0;

  constructor(private nav: NavGrid) {}

  private push(node: number, f: number): void {
    let i = this.heapSize++;
    const h = this.heap;
    const hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      h[i] = h[p];
      hf[i] = hf[p];
      i = p;
    }
    h[i] = node;
    hf[i] = f;
  }

  private pop(): number {
    const h = this.heap;
    const hf = this.heapF;
    const top = h[0];
    const n = --this.heapSize;
    const node = h[n];
    const f = hf[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && hf[c + 1] < hf[c]) c++;
      if (hf[c] >= f) break;
      h[i] = h[c];
      hf[i] = hf[c];
      i = c;
    }
    h[i] = node;
    hf[i] = f;
    return top;
  }

  /**
   * Find a path between world points. The search window is the 3x3 chunks centered on
   * (homeCx, homeCz). Returns a smoothed path (world points on floor height) or null.
   */
  find(
    sx: number,
    sz: number,
    gxGoal: number,
    gzGoal: number,
    homeCx: number,
    homeCz: number,
    opts: PathOptions = {},
  ): PathResult | null {
    this.queries++;
    const nav = this.nav;
    const W = AStar.W;
    const ox = (homeCx - 1) * NAV_RES;
    const oz = (homeCz - 1) * NAV_RES;
    const start = nav.nearestWalkable(sx, sz, 4);
    if (!start) return null;
    const [sgx, sgz] = start;
    const inWin = (gx: number, gz: number) => gx >= ox && gz >= oz && gx < ox + W && gz < oz + W;
    if (!inWin(sgx, sgz)) return null;
    const gx1 = Math.max(ox, Math.min(ox + W - 1, gxGoal));
    const gz1 = Math.max(oz, Math.min(oz + W - 1, gzGoal));

    const stampV = ++this.cur;
    const g = this.g;
    const parent = this.parent;
    const stamp = this.stamp;
    const closed = this.closed;
    this.heapSize = 0;
    const idx = (gx: number, gz: number) => (gz - oz) * W + (gx - ox);
    const h = (gx: number, gz: number) => {
      const dx = Math.abs(gx - gx1);
      const dz = Math.abs(gz - gz1);
      return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * 1.001;
    };
    const s = idx(sgx, sgz);
    g[s] = 0;
    parent[s] = -1;
    stamp[s] = stampV;
    this.push(s, h(sgx, sgz));
    let best = s;
    let bestH = h(sgx, sgz);
    const maxExp = opts.maxExpansions ?? 6000;
    let expansions = 0;
    let found = -1;
    const goalIdx = idx(gx1, gz1);

    while (this.heapSize > 0 && expansions < maxExp) {
      const cur = this.pop();
      if (closed[cur] === stampV) continue;
      closed[cur] = stampV;
      expansions++;
      if (cur === goalIdx) {
        found = cur;
        break;
      }
      const cgx = (cur % W) + ox;
      const cgz = Math.floor(cur / W) + oz;
      const hc = h(cgx, cgz);
      if (hc < bestH) {
        bestH = hc;
        best = cur;
      }
      const cf = nav.floor(cgx, cgz);
      for (let d = 0; d < 8; d++) {
        const nx = cgx + DX[d];
        const nz = cgz + DZ[d];
        if (!inWin(nx, nz)) continue;
        const ni = idx(nx, nz);
        if (closed[ni] === stampV) continue;
        const nf = nav.floor(nx, nz);
        if (Number.isNaN(nf) || Math.abs(nf - cf) > STEP) continue;
        if (d >= 4 && (!nav.walkable(cgx + DX[d], cgz) || !nav.walkable(cgx, cgz + DZ[d]))) continue;
        let cost = COST[d];
        if (nav.flags(nx, nz) & NavFlag.NearWall) cost += 0.4;
        if (opts.extraCost) cost += opts.extraCost(nx, nz);
        if (opts.hazard?.(nx, nz)) cost += HAZARD_COST;
        const ng = g[cur] + cost;
        if (stamp[ni] === stampV && ng >= g[ni]) continue;
        stamp[ni] = stampV;
        g[ni] = ng;
        parent[ni] = cur;
        this.push(ni, ng + h(nx, nz));
      }
    }

    const end = found >= 0 ? found : best;
    const cells: number[] = [];
    for (let c = end; c !== -1; c = parent[c]) cells.push(c);
    cells.reverse();
    const toG = (c: number): [number, number] => [(c % W) + ox, Math.floor(c / W) + oz];
    const smoothed = smooth(nav, cells.map(toG), 64, opts.hazard);
    return {
      points: smoothed.map(([gx, gz]) => ({ x: cellCenter(gx), y: nav.floor(gx, gz), z: cellCenter(gz) })),
      complete: found >= 0,
      expansions,
    };
  }
}

/**
 * True if a bot can walk in a straight line between two cells: every cell the line passes
 * through (supercover) is walkable and consecutive floors differ by at most a step.
 */
export function walkableLine(nav: NavGrid, ax: number, az: number, bx: number, bz: number, hazard?: CellTest): boolean {
  let x = ax;
  let z = az;
  const dx = Math.abs(bx - ax);
  const dz = Math.abs(bz - az);
  const sx = bx > ax ? 1 : -1;
  const sz = bz > az ? 1 : -1;
  let err = dx - dz;
  let prev = nav.floor(x, z);
  if (Number.isNaN(prev)) return false;
  const n = dx + dz;
  for (let k = 0; k < n; k++) {
    const e2 = 2 * err;
    if (e2 > -dz && e2 < dx) {
      // Diagonal step: both side cells must be walkable (no corner cutting).
      if (!nav.walkable(x + sx, z) || !nav.walkable(x, z + sz)) return false;
      err -= dz;
      x += sx;
      err += dx;
      z += sz;
      k++;
    } else if (e2 > -dz) {
      err -= dz;
      x += sx;
    } else {
      err += dx;
      z += sz;
    }
    const f = nav.floor(x, z);
    if (Number.isNaN(f) || Math.abs(f - prev) > STEP) return false;
    if (hazard?.(x, z)) return false;
    // Near walls, require clearance on the line (keeps bots from grinding corners).
    prev = f;
  }
  return true;
}

/**
 * Line test with clearance: the center line must be walkable, and so must lines offset one
 * cell (0.5 m) to each side, unless that side is a wall only for part of the way. This keeps
 * smoothed shortcuts from clipping door jambs and corners.
 */
export function clearLine(nav: NavGrid, ax: number, az: number, bx: number, bz: number, hazard?: CellTest): boolean {
  if (!walkableLine(nav, ax, az, bx, bz, hazard)) return false;
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz);
  if (l < 3) return true;
  const ox = Math.round(-dz / l);
  const oz = Math.round(dx / l);
  if (ox === 0 && oz === 0) return true;
  // A shortcut that hugs a wall on one side is fine; one squeezed on both sides is not.
  const left = walkableLine(nav, ax + ox, az + oz, bx + ox, bz + oz);
  const right = walkableLine(nav, ax - ox, az - oz, bx - ox, bz - oz);
  return left || right;
}

/**
 * Greedy string pulling: from each kept waypoint, scan forward while the straight line stays
 * walkable and keep the last visible cell (bounded lookahead keeps it linear-ish).
 */
export function smooth(nav: NavGrid, cells: [number, number][], lookahead = 64, hazard?: CellTest): [number, number][] {
  if (cells.length <= 2) return cells;
  const out: [number, number][] = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = i + 1;
    const limit = Math.min(cells.length - 1, i + lookahead);
    while (j < limit && clearLine(nav, cells[i][0], cells[i][1], cells[j + 1][0], cells[j + 1][1], hazard)) j++;
    out.push(cells[j]);
    i = j;
  }
  return out;
}
