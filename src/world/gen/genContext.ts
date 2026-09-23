import type { Rand } from '../../core/rng';
import type { BrushWriter } from './BrushWriter';
import type { DistrictParams } from './district';

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0, z0, x1, z1 });
export const rw = (r: Rect) => r.x1 - r.x0;
export const rd = (r: Rect) => r.z1 - r.z0;
export const inset = (r: Rect, d: number): Rect => rect(r.x0 + d, r.z0 + d, r.x1 - d, r.z1 - d);

/** Occupancy cell states. */
export const Occ = { Free: 0, Solid: 1, Reserved: 2, Prop: 3 } as const;

/** 0.5 m occupancy grid over the chunk, used to keep props out of walls, doors and walkways. */
export class Occupancy {
  static readonly CELL = 0.5;
  static readonly RES = 128;
  readonly cells = new Uint8Array(Occupancy.RES * Occupancy.RES);

  private range(r: Rect): [number, number, number, number] {
    const c = Occupancy.CELL;
    const n = Occupancy.RES;
    return [
      Math.max(0, Math.floor(r.x0 / c)),
      Math.max(0, Math.floor(r.z0 / c)),
      Math.min(n - 1, Math.ceil(r.x1 / c) - 1),
      Math.min(n - 1, Math.ceil(r.z1 / c) - 1),
    ];
  }

  mark(r: Rect, v: number): void {
    const [a, b, c, d] = this.range(r);
    for (let z = b; z <= d; z++) for (let x = a; x <= c; x++) this.cells[z * Occupancy.RES + x] = Math.max(this.cells[z * Occupancy.RES + x], v);
  }

  /** Overwrite cells in r with v. */
  set(r: Rect, v: number): void {
    const [a, b, c, d] = this.range(r);
    for (let z = b; z <= d; z++) for (let x = a; x <= c; x++) this.cells[z * Occupancy.RES + x] = v;
  }

  /** True if every cell in r is Free. */
  free(r: Rect): boolean {
    const [a, b, c, d] = this.range(r);
    for (let z = b; z <= d; z++) for (let x = a; x <= c; x++) if (this.cells[z * Occupancy.RES + x] !== Occ.Free) return false;
    return true;
  }
}

export interface DoorInfo {
  /** Door center (local meters). */
  x: number;
  z: number;
  /** Outward normal. */
  nx: number;
  nz: number;
}

export interface GenContext {
  seed: number;
  cx: number;
  cz: number;
  w: BrushWriter;
  /** Layout RNG stream. */
  r: Rand;
  /** Prop RNG stream. */
  rp: Rand;
  district: DistrictParams;
  level: number;
  /** Lot floor height (top of lot slab). */
  lotY: number;
  occ: Occupancy;
  doors: DoorInfo[];
  /** Open parcels (courtyards, yards, lots, alleys) — encounter arena candidates. */
  open: Rect[];
  /** Building interiors (for indoor spawn slots). */
  interiors: Rect[];
  /** Perch points for overwatch bots (x, y, z). */
  perches: number[];
}

/** Subtract a set of holes from a rectangle, returning non-overlapping rectangles (grid decomposition). */
export function subtractRects(base: Rect, holes: Rect[]): Rect[] {
  const xs = new Set<number>([base.x0, base.x1]);
  const zs = new Set<number>([base.z0, base.z1]);
  for (const h of holes) {
    if (h.x0 > base.x0 && h.x0 < base.x1) xs.add(h.x0);
    if (h.x1 > base.x0 && h.x1 < base.x1) xs.add(h.x1);
    if (h.z0 > base.z0 && h.z0 < base.z1) zs.add(h.z0);
    if (h.z1 > base.z0 && h.z1 < base.z1) zs.add(h.z1);
  }
  const X = [...xs].sort((a, b) => a - b);
  const Z = [...zs].sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let j = 0; j < Z.length - 1; j++) {
    let run: Rect | null = null;
    for (let i = 0; i < X.length - 1; i++) {
      const cx = (X[i] + X[i + 1]) / 2;
      const cz = (Z[j] + Z[j + 1]) / 2;
      const inHole = holes.some((h) => cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1);
      if (inHole) {
        if (run) out.push(run);
        run = null;
      } else if (run) {
        run.x1 = X[i + 1];
      } else {
        run = rect(X[i], Z[j], X[i + 1], Z[j + 1]);
      }
    }
    if (run) out.push(run);
  }
  return out;
}
