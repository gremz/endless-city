import { NAV_RES, NavFlag } from '../../world/gen/ChunkData';
import { NAV_LINK_STRIDE, NAV_STEP } from '../../world/gen/navBake';
import { cellCenter, toCell, type NavChunk, type NavGrid } from './NavGrid';

const STEP = NAV_STEP;
const STEP_CM = NAV_STEP * 100;
const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DZ = [0, 1, 0, -1, 1, 1, -1, -1];
const COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

export interface PathPoint {
  x: number;
  y: number;
  z: number;
  /** Set on a point reached by climbing a ladder: the ladder's outward normal. */
  ladder?: { nx: number; nz: number };
}

export interface PathOptions {
  /** Extra cost for entering a cell (e.g. flank routes avoiding the enemy's view). */
  extraCost?: (gx: number, gz: number) => number;
  /** Cells to keep out of (fires): expensive to enter, and never cut through when smoothing. */
  hazard?: (gx: number, gz: number) => boolean;
  maxExpansions?: number;
}

/** Extra cost of wading a cell (bots take a bridge when there is one). */
const WATER_COST = 3;
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
 * Cell in a path: global cell coordinates plus the floor height of its span, and for a cell
 * reached by ladder, the ladder's outward normal.
 */
export type PathCell = [gx: number, gz: number, y: number, ladderNx?: number, ladderNz?: number];

/**
 * A* over the layered nav spans in a window of 3x3 chunks, with arrays reused across queries
 * (visit stamps, so queries never clear). A node is a span: its window chunk slot's offset
 * plus the chunk-local span id.
 */
export class AStar {
  private cap = 0;
  private g = new Float32Array(0);
  private parent = new Int32Array(0);
  private stamp = new Uint32Array(0);
  private closed = new Uint32Array(0);
  /** Ladder link record a node was reached through, or -1. */
  private via = new Int32Array(0);
  private heap = new Int32Array(0);
  private heapF = new Float32Array(0);
  private heapSize = 0;
  private cur = 0;
  private slotChunk: (NavChunk | undefined)[] = new Array(9).fill(undefined);
  private slotOff = new Int32Array(10);
  queries = 0;

  constructor(private nav: NavGrid) {}

  private ensure(nodes: number, heap: number): void {
    if (nodes > this.cap) {
      this.cap = Math.max(nodes, this.cap * 2);
      this.g = new Float32Array(this.cap);
      this.parent = new Int32Array(this.cap);
      this.stamp = new Uint32Array(this.cap);
      this.closed = new Uint32Array(this.cap);
      this.via = new Int32Array(this.cap);
      this.cur = 0;
    }
    if (heap > this.heap.length) {
      this.heap = new Int32Array(heap);
      this.heapF = new Float32Array(heap);
    }
  }

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
    sy: number,
    sz: number,
    tx: number,
    ty: number,
    tz: number,
    homeCx: number,
    homeCz: number,
    opts: PathOptions = {},
  ): PathResult | null {
    this.queries++;
    const nav = this.nav;
    const N = NAV_RES;
    const W = N * 3;
    const ox = (homeCx - 1) * N;
    const oz = (homeCz - 1) * N;
    const slotChunk = this.slotChunk;
    const slotOff = this.slotOff;
    let total = 0;
    for (let k = 0; k < 9; k++) {
      const c = nav.chunkByCoord(homeCx - 1 + (k % 3), homeCz - 1 + Math.floor(k / 3));
      slotChunk[k] = c;
      slotOff[k] = total;
      total += c ? c.floor.length : 0;
    }
    slotOff[9] = total;
    const maxExp = opts.maxExpansions ?? 6000;
    this.ensure(total, maxExp * 8 + 16);

    const inWin = (gx: number, gz: number) => gx >= ox && gz >= oz && gx < ox + W && gz < oz + W;
    /** Node id of the span in cell (gx, gz) within a step of floor `fcm` (cm), or -1. */
    const stepNode = (gx: number, gz: number, fcm: number): number => {
      const slot = Math.floor((gz - oz) / N) * 3 + Math.floor((gx - ox) / N);
      const c = slotChunk[slot];
      if (!c) return -1;
      const l = (gz - oz) % N * N + ((gx - ox) % N);
      for (let s = c.col[l], e = c.col[l + 1]; s < e; s++) {
        const d = c.floor[s] - fcm;
        if (d <= STEP_CM && d >= -STEP_CM) return slotOff[slot] + s;
      }
      return -1;
    };
    const nodeOf = (gx: number, gz: number, chunk: NavChunk | undefined, span: number): number => {
      if (!chunk || span < 0 || !inWin(gx, gz)) return -1;
      const slot = Math.floor((gz - oz) / N) * 3 + Math.floor((gx - ox) / N);
      return slotChunk[slot] === chunk ? slotOff[slot] + span : -1;
    };

    const start = nav.nearestWalkable(sx, sy, sz, 4, 2);
    if (!start) return null;
    nav.near(start[0], start[1], start[2], 0);
    const s = nodeOf(start[0], start[1], nav.qChunk, nav.qSpan);
    if (s < 0) return null;
    const gx1 = Math.max(ox, Math.min(ox + W - 1, toCell(tx)));
    const gz1 = Math.max(oz, Math.min(oz + W - 1, toCell(tz)));
    nav.near(gx1, gz1, ty, 1000);
    const goal = nodeOf(gx1, gz1, nav.qChunk, nav.qSpan);
    const y1 = Number.isNaN(nav.qFloor) ? ty : nav.qFloor;

    const stampV = ++this.cur;
    const g = this.g;
    const parent = this.parent;
    const stamp = this.stamp;
    const closed = this.closed;
    this.heapSize = 0;
    const h = (gx: number, gz: number, y: number) => {
      const dx = Math.abs(gx - gx1);
      const dz = Math.abs(gz - gz1);
      const flat = Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
      return Math.max(flat, Math.abs(y - y1) / STEP) * 1.001;
    };
    // Decoded node: cell and floor (reused scratch).
    let ngx = 0;
    let ngz = 0;
    let nfl = 0;
    let nfcm = 0;
    let nflags = 0;
    let nslot = 0;
    let nchunk: NavChunk | undefined;
    let nspan = 0;
    const decode = (node: number) => {
      let k = 0;
      while (node >= slotOff[k + 1]) k++;
      const c = slotChunk[k]!;
      const sp = node - slotOff[k];
      nslot = k;
      nchunk = c;
      nspan = sp;
      const col = c.spanCol[sp];
      ngx = c.cx * N + (col % N);
      ngz = c.cz * N + Math.floor(col / N);
      nfcm = c.floor[sp];
      nfl = nfcm / 100;
      nflags = c.flags[sp];
    };

    const via = this.via;
    decode(s);
    g[s] = 0;
    parent[s] = -1;
    via[s] = -1;
    stamp[s] = stampV;
    let bestH = h(ngx, ngz, nfl);
    this.push(s, bestH);
    let best = s;
    let expansions = 0;
    let found = -1;

    while (this.heapSize > 0 && expansions < maxExp) {
      const cur = this.pop();
      if (closed[cur] === stampV) continue;
      closed[cur] = stampV;
      expansions++;
      if (cur === goal) {
        found = cur;
        break;
      }
      decode(cur);
      const cgx = ngx;
      const cgz = ngz;
      const cfcm = nfcm;
      const cslot = nslot;
      const cchunk = nchunk!;
      const cspan = nspan;
      const hc = h(cgx, cgz, nfl);
      if (hc < bestH) {
        bestH = hc;
        best = cur;
      }
      for (let d = 0; d < 8; d++) {
        const nx = cgx + DX[d];
        const nz = cgz + DZ[d];
        if (!inWin(nx, nz)) continue;
        const ni = stepNode(nx, nz, cfcm);
        if (ni < 0 || closed[ni] === stampV) continue;
        if (d >= 4 && (!inWin(cgx + DX[d], cgz) || !inWin(cgx, cgz + DZ[d]) || stepNode(cgx + DX[d], cgz, cfcm) < 0 || stepNode(cgx, cgz + DZ[d], cfcm) < 0)) continue;
        decode(ni);
        let cost = COST[d];
        if (nflags & NavFlag.NearWall) cost += 0.4;
        if (nflags & NavFlag.Water) cost += WATER_COST;
        if (opts.extraCost) cost += opts.extraCost(nx, nz);
        if (opts.hazard?.(nx, nz)) cost += HAZARD_COST;
        const ng = g[cur] + cost;
        if (stamp[ni] === stampV && ng >= g[ni]) continue;
        if (this.heapSize >= this.heap.length) continue;
        stamp[ni] = stampV;
        g[ni] = ng;
        parent[ni] = cur;
        via[ni] = -1;
        this.push(ni, ng + h(nx, nz, nfl));
      }
      // Ladders.
      const lks = cchunk.linksFrom.get(cspan);
      if (lks) {
        for (const li of lks) {
          const o = li * NAV_LINK_STRIDE;
          const ni = slotOff[cslot] + cchunk.links[o + 1];
          if (closed[ni] === stampV) continue;
          const ng = g[cur] + cchunk.links[o + 2];
          if (stamp[ni] === stampV && ng >= g[ni]) continue;
          if (this.heapSize >= this.heap.length) continue;
          decode(ni);
          stamp[ni] = stampV;
          g[ni] = ng;
          parent[ni] = cur;
          via[ni] = li;
          this.push(ni, ng + h(ngx, ngz, nfl));
        }
      }
    }

    const end = found >= 0 ? found : best;
    const cells: PathCell[] = [];
    for (let c = end; c !== -1; c = parent[c]) {
      decode(c);
      if (via[c] >= 0) {
        const o = via[c] * NAV_LINK_STRIDE;
        cells.push([ngx, ngz, nfl, nchunk!.links[o + 3], nchunk!.links[o + 4]]);
      } else cells.push([ngx, ngz, nfl]);
    }
    cells.reverse();
    const smoothed = smooth(nav, cells, 64, opts.hazard);
    return {
      points: smoothed.map(([gx, gz, y, nx, nz]) =>
        nx === undefined ? { x: cellCenter(gx), y, z: cellCenter(gz) } : { x: cellCenter(gx), y, z: cellCenter(gz), ladder: { nx, nz: nz! } },
      ),
      complete: found >= 0,
      expansions,
    };
  }
}

/**
 * True if a bot can walk in a straight line between two cells, starting on the floor at
 * height `ay` and ending on the one at `by`: every cell the line passes through (supercover)
 * has a floor within a step of the previous one.
 */
export function walkableLine(nav: NavGrid, ax: number, az: number, ay: number, bx: number, bz: number, by: number, hazard?: CellTest): boolean {
  let x = ax;
  let z = az;
  const dx = Math.abs(bx - ax);
  const dz = Math.abs(bz - az);
  const sx = bx > ax ? 1 : -1;
  const sz = bz > az ? 1 : -1;
  let err = dx - dz;
  let prev = nav.stepFloor(x, z, ay);
  if (Number.isNaN(prev)) return false;
  const n = dx + dz;
  for (let k = 0; k < n; k++) {
    const e2 = 2 * err;
    if (e2 > -dz && e2 < dx) {
      // Diagonal step: both side cells must be walkable (no corner cutting).
      if (Number.isNaN(nav.stepFloor(x + sx, z, prev)) || Number.isNaN(nav.stepFloor(x, z + sz, prev))) return false;
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
    const f = nav.stepFloor(x, z, prev);
    if (Number.isNaN(f)) return false;
    if (hazard?.(x, z)) return false;
    prev = f;
  }
  // Same floor at the far end (not the storey above or below it).
  return Math.abs(prev - by) <= STEP;
}

/**
 * Line test with clearance: the center line must be walkable, and so must lines offset one
 * cell (0.5 m) to each side, unless that side is a wall only for part of the way. This keeps
 * smoothed shortcuts from clipping door jambs and corners.
 */
export function clearLine(nav: NavGrid, a: PathCell, b: PathCell, hazard?: CellTest): boolean {
  const [ax, az, ay] = a;
  const [bx, bz, by] = b;
  if (!walkableLine(nav, ax, az, ay, bx, bz, by, hazard)) return false;
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz);
  if (l < 3) return true;
  const ox = Math.round(-dz / l);
  const oz = Math.round(dx / l);
  if (ox === 0 && oz === 0) return true;
  // A shortcut that hugs a wall on one side is fine; one squeezed on both sides is not.
  const left = walkableLine(nav, ax + ox, az + oz, ay, bx + ox, bz + oz, by);
  const right = walkableLine(nav, ax - ox, az - oz, ay, bx - ox, bz - oz, by);
  return left || right;
}

/**
 * Greedy string pulling: from each kept waypoint, scan forward while the straight line stays
 * walkable and keep the last visible cell (bounded lookahead keeps it linear-ish).
 */
export function smooth(nav: NavGrid, cells: PathCell[], lookahead = 64, hazard?: CellTest): PathCell[] {
  if (cells.length <= 2) return cells;
  const out: PathCell[] = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = i + 1;
    const limit = Math.min(cells.length - 1, i + lookahead);
    while (j < limit && clearLine(nav, cells[i], cells[j + 1], hazard)) j++;
    out.push(cells[j]);
    i = j;
  }
  return out;
}
