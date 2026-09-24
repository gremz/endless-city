import type { Vec3 } from '../core/math';
import type { Brush } from './brush';
import { DIST_EPSILON, finishTrace, resetTrace, traceBrush, type TraceResult } from './trace';

/** Broadphase cell size in meters (8 cells per 64 m chunk). */
export const CELL = 8;
const CELL_BIAS = 1 << 15;

const cellKey = (ix: number, iz: number) => (ix + CELL_BIAS) * 65536 + (iz + CELL_BIAS);

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * All collision geometry currently loaded, bucketed into 2D columns of CELL meters.
 * Chunks add/remove whole sets of brushes; traces walk the cells overlapped by the sweep.
 */
export class CollisionWorld {
  private cells = new Map<number, Brush[]>();
  private chunks = new Map<number, { brushes: Brush[]; cellKeys: number[] }>();
  /** Moving brushes (vehicles) by owner id, with the cells they are bucketed in. */
  private dynamic = new Map<number, { brushes: Brush[]; cellKeys: number[] }>();
  private stamp = 1;
  /** Brushes of this owner (a vehicle id) are invisible to traces; 0 = none. */
  ignoreOwner = 0;
  /** Number of brush tests performed (debug stat). */
  brushTests = 0;

  hasChunk(key: number): boolean {
    return this.chunks.has(key);
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get brushCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.brushes.length;
    return n;
  }

  addChunk(key: number, brushes: Brush[]): void {
    if (this.chunks.has(key)) this.removeChunk(key);
    const keys = new Set<number>();
    for (const b of brushes) {
      b.chunkKey = key;
      const ix0 = Math.floor(b.minX / CELL);
      const ix1 = Math.floor(b.maxX / CELL);
      const iz0 = Math.floor(b.minZ / CELL);
      const iz1 = Math.floor(b.maxZ / CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = cellKey(ix, iz);
          let list = this.cells.get(k);
          if (!list) {
            list = [];
            this.cells.set(k, list);
          }
          list.push(b);
          keys.add(k);
        }
      }
    }
    this.chunks.set(key, { brushes, cellKeys: [...keys] });
  }

  /** A resident chunk's static brushes, in their packed order. */
  chunkBrushes(key: number): readonly Brush[] | undefined {
    return this.chunks.get(key)?.brushes;
  }

  removeChunk(key: number): void {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const k of c.cellKeys) {
      const list = this.cells.get(k);
      if (!list) continue;
      const kept = list.filter((b) => b.owner !== 0 || b.chunkKey !== key);
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
    this.chunks.delete(key);
  }

  /**
   * Put (or move) an owner's moving brushes. Brushes are bucketed by their current bounds, so
   * call this again whenever they move.
   */
  setDynamic(owner: number, brushes: Brush[]): void {
    this.clearDynamic(owner);
    const keys: number[] = [];
    for (const b of brushes) {
      b.owner = owner;
      b.chunkKey = -1;
      const ix0 = Math.floor(b.minX / CELL);
      const ix1 = Math.floor(b.maxX / CELL);
      const iz0 = Math.floor(b.minZ / CELL);
      const iz1 = Math.floor(b.maxZ / CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = cellKey(ix, iz);
          let list = this.cells.get(k);
          if (!list) {
            list = [];
            this.cells.set(k, list);
          }
          list.push(b);
          if (!keys.includes(k)) keys.push(k);
        }
      }
    }
    this.dynamic.set(owner, { brushes, cellKeys: keys });
  }

  clearDynamic(owner: number): void {
    const d = this.dynamic.get(owner);
    if (!d) return;
    for (const k of d.cellKeys) {
      const list = this.cells.get(k);
      if (!list) continue;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) list.splice(i, 1);
      if (!list.length) this.cells.delete(k);
    }
    this.dynamic.delete(owner);
  }

  hasDynamic(owner: number): boolean {
    return this.dynamic.has(owner);
  }

  /** Visit every brush whose cell overlaps the XZ box (brushes may be visited once per call). */
  forEachBrushInBox(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    fn: (b: Brush) => void,
  ): void {
    const stamp = ++this.stamp;
    const ix0 = Math.floor(minX / CELL);
    const ix1 = Math.floor(maxX / CELL);
    const iz0 = Math.floor(minZ / CELL);
    const iz1 = Math.floor(maxZ / CELL);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const b of list) {
          if (b.stamp === stamp) continue;
          b.stamp = stamp;
          if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
          fn(b);
        }
      }
    }
  }

  /**
   * Sweep a hull from start to end. Long sweeps are walked in CELL-sized segments so a
   * hit found early stops the search.
   */
  traceBox(
    tr: TraceResult,
    start: Vec3,
    end: Vec3,
    mins: Vec3,
    maxs: Vec3,
    mask: number,
  ): TraceResult {
    resetTrace(tr);
    const sx = start.x;
    const sy = start.y;
    const sz = start.z;
    const ex = end.x;
    const ey = end.y;
    const ez = end.z;
    const dx = ex - sx;
    const dz = ez - sz;
    const horiz = Math.hypot(dx, dz);
    const segments = Math.max(1, Math.ceil(horiz / CELL));
    const stamp = ++this.stamp;
    const pad = DIST_EPSILON * 2;

    for (let s = 0; s < segments; s++) {
      const f0 = s / segments;
      const f1 = (s + 1) / segments;
      const ax = sx + dx * f0;
      const az = sz + dz * f0;
      const bx = sx + dx * f1;
      const bz = sz + dz * f1;
      const minX = Math.min(ax, bx) + mins.x - pad;
      const maxX = Math.max(ax, bx) + maxs.x + pad;
      const minZ = Math.min(az, bz) + mins.z - pad;
      const maxZ = Math.max(az, bz) + maxs.z + pad;
      const loY = Math.min(sy, ey) + mins.y - pad;
      const hiY = Math.max(sy, ey) + maxs.y + pad;
      const ix0 = Math.floor(minX / CELL);
      const ix1 = Math.floor(maxX / CELL);
      const iz0 = Math.floor(minZ / CELL);
      const iz1 = Math.floor(maxZ / CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const list = this.cells.get(cellKey(ix, iz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (b.stamp === stamp) continue;
            b.stamp = stamp;
            if ((b.contents & mask) === 0) continue;
            if (b.owner !== 0 && b.owner === this.ignoreOwner) continue;
            // Cheap AABB rejection against the whole sweep's vertical span and this segment.
            if (b.maxY < loY || b.minY > hiY) continue;
            if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) {
              // Not in this segment's box; allow a later segment to test it.
              b.stamp = 0;
              continue;
            }
            this.brushTests++;
            traceBrush(tr, b, sx, sy, sz, ex, ey, ez, mins, maxs);
            if (tr.allSolid) {
              finishTrace(tr, sx, sy, sz, ex, ey, ez);
              return tr;
            }
          }
        }
      }
      if (tr.fraction <= f1) break;
    }
    finishTrace(tr, sx, sy, sz, ex, ey, ez);
    return tr;
  }

  traceRay(tr: TraceResult, start: Vec3, end: Vec3, mask: number): TraceResult {
    return this.traceBox(tr, start, end, ZERO, ZERO, mask);
  }

  /** True if the hull at pos overlaps any solid in mask. */
  testBox(tr: TraceResult, pos: Vec3, mins: Vec3, maxs: Vec3, mask: number): boolean {
    this.traceBox(tr, pos, pos, mins, maxs, mask);
    return tr.startSolid;
  }
}
