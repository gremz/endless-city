import type { Rand } from '../../core/rng';
import { Contents, SOLID } from '../../physics/brush';
import { FLOOR_H } from './buildings';
import { District, FacadeCell, Material } from './ChunkData';
import type { BuildingInfo, GenContext } from './genContext';
import { CarGlassTint } from './meshBake';
import { LOT0, LOT1 } from './streets';

/**
 * Cosmetic dressing, run last so it can fit around everything else in the chunk.
 * - Solid blocks get window panels, sills and lintels, a stone plinth, cornice mouldings,
 *   quoins, and shopfronts with signs or awnings on their street walls.
 * - Real window openings get sills and lintels.
 * - Every roof gets a membrane skin and some clutter.
 *
 * All of it is VISIBLE-only brushes (no collision, no nav change) except roof clutter.
 * Nothing is placed where it would overlap an existing brush (fire escapes, ladders, bridges,
 * props). It draws from its own random stream, so the layout never shifts.
 */

const VIS = Contents.VISIBLE;
const STONE_TINT = 150;
/** Window panel size on solid blocks, and its height over each floor line. */
const WIN_W = 1.2;
const WIN_H = 1.6;
const WIN_SILL = 0.9;

/** One outside wall of a footprint: plane at `face`, outward sign `out`, extent a0..a1. */
interface Face {
  alongX: boolean;
  out: number;
  face: number;
  a0: number;
  a1: number;
}

function faces(b: BuildingInfo): Face[] {
  const fp = b.fp;
  return [
    { alongX: true, out: -1, face: fp.z0, a0: fp.x0, a1: fp.x1 },
    { alongX: true, out: 1, face: fp.z1, a0: fp.x0, a1: fp.x1 },
    { alongX: false, out: -1, face: fp.x0, a0: fp.z0, a1: fp.z1 },
    { alongX: false, out: 1, face: fp.x1, a0: fp.z0, a1: fp.z1 },
  ];
}

/** World box for d0..d1 meters out from a face, a0..a1 along it, y0..y1. */
function boxOf(f: Face, d0: number, d1: number, a0: number, a1: number): [number, number, number, number] {
  const c0 = f.face + f.out * d0;
  const c1 = f.face + f.out * d1;
  const lo = Math.min(c0, c1);
  const hi = Math.max(c0, c1);
  return f.alongX ? [a0, lo, a1, hi] : [lo, a0, hi, a1];
}

class Dresser {
  constructor(
    readonly ctx: GenContext,
    readonly r: Rand,
  ) {}

  /** Place a box in front of a face unless it would overlap anything (with `pad` of air around it). */
  put(f: Face, d0: number, d1: number, a0: number, a1: number, y0: number, y1: number, mat: number, tint: number, contents = VIS, pad = 0): boolean {
    const [x0, z0, x1, z1] = boxOf(f, d0, d1, a0, a1);
    // The pad never reaches back into the wall itself.
    const [px0, pz0, px1, pz1] = boxOf(f, d0, d1 + pad, a0 - pad, a1 + pad);
    // Nor below the lot surface (things standing on the ground touch the lot slab).
    const py0 = Math.max(y0 - pad, Math.min(y0, this.ctx.lotY + 0.01));
    if (this.ctx.w.overlaps(px0, py0, pz0, px1, y1 + pad, pz1)) return false;
    this.ctx.w.box(x0, y0, z0, x1, y1, z1, mat, contents, tint);
    return true;
  }

  /**
   * A run along a face (plinth, cornice), split around whatever overlaps it: the free spans of
   * [a0, a1] get a box each.
   */
  run(f: Face, d0: number, d1: number, a0: number, a1: number, y0: number, y1: number, mat: number, tint: number): void {
    const [x0, z0, x1, z1] = boxOf(f, d0, d1, a0, a1);
    const cuts: [number, number][] = [];
    this.ctx.w.forOverlaps(x0, y0, z0, x1, y1, z1, (bx0, bz0, bx1, bz1) => {
      cuts.push(f.alongX ? [bx0 - 0.05, bx1 + 0.05] : [bz0 - 0.05, bz1 + 0.05]);
    });
    cuts.sort((p, q) => p[0] - q[0]);
    let cur = a0;
    const emit = (s0: number, s1: number) => {
      if (s1 - s0 < 0.3) return;
      const [p0, q0, p1, q1] = boxOf(f, d0, d1, s0, s1);
      this.ctx.w.box(p0, y0, q0, p1, y1, q1, mat, VIS, tint);
    };
    for (const [c0, c1] of cuts) {
      if (c0 > cur) emit(cur, Math.min(c0, a1));
      cur = Math.max(cur, c1);
      if (cur >= a1) return;
    }
    emit(cur, a1);
  }
}

/** Whether a face looks onto the street (the sidewalk runs along the lot edge in front of it). */
function streetFace(f: Face): boolean {
  return f.out < 0 ? f.face - LOT0 < 2.5 : LOT1 - f.face < 2.5;
}

/** Facade cell for one window: mostly the building's style, some lit, a few odd ones out. */
function windowCell(r: Rand, base: number, oldtown: boolean): number {
  const k = r();
  if (k < 0.22) return r() < 0.6 ? FacadeCell.WindowLitWarm : FacadeCell.WindowLitCool;
  if (k < 0.34) return oldtown && r() < 0.5 ? FacadeCell.WindowShutters : [FacadeCell.Window, FacadeCell.WindowBlinds, FacadeCell.WindowCurtains][Math.floor(r() * 3)];
  return base;
}

/** Ground floor shops across the free stretch of a street wall. */
function shopfront(D: Dresser, f: Face, y: number): boolean {
  const r = D.r;
  const a0 = f.a0 + 0.5;
  const a1 = f.a1 - 0.5;
  const len = a1 - a0;
  if (len < 3.4) return false;
  const units = Math.max(1, Math.floor((len + 0.4) / 3.8));
  const uw = (len - 0.4 * (units - 1)) / units;
  let placed = false;
  for (let i = 0; i < units; i++) {
    const ua = a0 + i * (uw + 0.4);
    const ub = ua + uw;
    const k = r();
    const cell = k < 0.45 ? FacadeCell.ShopLit : k < 0.8 ? FacadeCell.Shop : FacadeCell.Shutter;
    if (!D.put(f, 0, 0.06, ua, ub, y, y + 2.6, Material.Facade, cell, VIS, 0.05)) continue;
    placed = true;
    // A stone surround at the base of each pier between shops.
    D.put(f, 0, 0.08, ub, ub + 0.4, y, y + 0.5, Material.Stone, STONE_TINT);
    if (cell === FacadeCell.Shutter) continue;
    if (r() < 0.5) {
      // Striped awning over the shop window (well above head height).
      D.put(f, 0, 1.1, ua - 0.1, ub + 0.1, y + 2.62, y + 2.85, Material.Facade, r() < 0.5 ? FacadeCell.AwningRed : FacadeCell.AwningGreen);
    } else if (uw >= 2.4) {
      // Sign board: 5:1, centered over the shop.
      const sw = Math.min(uw - 0.2, 3.5);
      const c = (ua + ub) / 2;
      D.put(f, 0, 0.1, c - sw / 2, c + sw / 2, y + 2.65, y + 2.65 + sw / 5, Material.Facade, FacadeCell.Sign + Math.floor(r() * 4));
    }
  }
  return placed;
}

/** Window panels, sills, lintels, plinth, cornice and quoins on a solid block. */
function dressBlock(D: Dresser, b: BuildingInfo): void {
  const { ctx, r } = D;
  const y0 = ctx.lotY;
  const top = b.wallTop ?? b.roofY;
  const district = ctx.district.id;
  const oldtown = district === District.Oldtown;
  const industrial = district === District.Industrial || b.mat === Material.Metal;
  const baseCell = oldtown
    ? [FacadeCell.WindowCurtains, FacadeCell.WindowShutters, FacadeCell.Window][Math.floor(r() * 3)]
    : [FacadeCell.Window, FacadeCell.WindowBlinds][Math.floor(r() * 2)];
  const trimTint = STONE_TINT - Math.floor(r() * 40);
  const lintels = oldtown || (b.mat === Material.Brick && r() < 0.6);
  // A tower's upper floors are glazed already: only its ground floor gets panels.
  const panelFloors = b.tower ? 1 : Math.max(1, Math.round((top - y0) / FLOOR_H));

  for (const f of faces(b)) {
    const len = f.a1 - f.a0;
    const street = streetFace(f);
    const shop = street && !industrial && r() < 0.8 && shopfront(D, f, y0);

    if (industrial && street && r() < 0.7 && len > 6) {
      // Roller shutter loading door.
      const c = f.a0 + 1.5 + r() * (len - 5);
      D.put(f, 0, 0.08, c, c + 3.2, y0, y0 + Math.min(3.2, top - y0 - 0.2), Material.Facade, FacadeCell.Shutter, VIS, 0.05);
    }
    const n = Math.floor((len - 1) / 3.2);
    for (let fl = shop ? 1 : 0; fl < panelFloors; fl++) {
      const wy = y0 + fl * FLOOR_H + (industrial ? 1.4 : WIN_SILL);
      const wt = Math.min(wy + WIN_H, top - 0.35);
      if (wt - wy < 0.8) continue;
      for (let i = 0; i < n; i++) {
        const c = f.a0 + ((i + 1) * len) / (n + 1);
        const wa = c - WIN_W / 2;
        const wb = c + WIN_W / 2;
        if (wa < f.a0 + 0.5 || wb > f.a1 - 0.5) continue;
        if (industrial && r() < 0.5) continue;
        // Clearance for the sill and lintel too (ladders, fire escape rails, props).
        if (!D.put(f, 0, 0.05, wa, wb, wy, wt, Material.Facade, windowCell(r, baseCell, oldtown), VIS, 0.2)) continue;
        D.put(f, 0, 0.14, wa - 0.12, wb + 0.12, wy - 0.08, wy, Material.Stone, trimTint);
        if (lintels) D.put(f, 0, 0.07, wa - 0.1, wb + 0.1, wt, wt + 0.18, Material.Stone, trimTint);
      }
    }

    // Stone plinth (after the windows: it only has to fit around what is already there).
    if (!industrial && !shop) D.run(f, 0, 0.07, f.a0 - 0.07, f.a1 + 0.07, y0, y0 + 0.75, Material.Stone, trimTint);

    // Cornice: two stepped mouldings under the roof cap, wrapping the corners.
    if (!industrial) {
      D.run(f, 0, 0.26, f.a0 - 0.26, f.a1 + 0.26, top - 0.28, top, Material.Stone, trimTint);
      D.run(f, 0, 0.13, f.a0 - 0.13, f.a1 + 0.13, top - 0.5, top - 0.28, Material.Stone, trimTint);
    }
  }

  // Oldtown quoins: alternating long and short stones up every corner. The X-running faces'
  // stones also cover the corner itself.
  if (oldtown && !b.tower && r() < 0.6) {
    const h = 0.42;
    for (const f of faces(b)) {
      const wrap = f.alongX ? 0.05 : 0;
      for (let k = 0, y = y0 + 0.8; y + h < top - 0.55; k++, y += h + 0.04) {
        const l = (k % 2 === 0) === f.alongX ? 0.62 : 0.34;
        D.put(f, 0, 0.05, f.a0 - wrap, f.a0 + l, y, y + h, Material.Stone, trimTint);
        D.put(f, 0, 0.05, f.a1 - l, f.a1 + wrap, y, y + h, Material.Stone, trimTint);
      }
    }
  }
}

/** Sills and lintels on the outside of real window openings (houses, landmarks). */
function trimOpenings(D: Dresser): void {
  const t = D.ctx.trims;
  const inside = (x: number, z: number) => D.ctx.buildings.some((b) => x > b.fp.x0 && x < b.fp.x1 && z > b.fp.z0 && z < b.fp.z1);
  const tint = STONE_TINT;
  for (let o = 0; o < t.length; o += 7) {
    const alongX = t[o] === 1;
    const [a, b, c0, c1, ys, yh] = [t[o + 1], t[o + 2], t[o + 3], t[o + 4], t[o + 5], t[o + 6]];
    const mid = (a + b) / 2;
    for (const [face, out] of [[c0, -1], [c1, 1]] as const) {
      const px = alongX ? mid : face + out * 0.4;
      const pz = alongX ? face + out * 0.4 : mid;
      if (inside(px, pz)) continue;
      const f: Face = { alongX, out, face, a0: a, a1: b };
      D.put(f, 0, 0.12, a - 0.1, b + 0.1, ys - 0.08, ys, Material.Stone, tint);
      D.put(f, 0, 0.06, a - 0.08, b + 0.08, yh, yh + 0.16, Material.Stone, tint);
    }
  }
}

/** Roof membrane and clutter: AC units, vents, a water tank, antennas, skylights. */
function dressRoof(D: Dresser, b: BuildingInfo): void {
  const { ctx, r } = D;
  const w = ctx.w;
  const y = b.roofY;
  const fp = b.fp;
  // Membrane skin just above the walkable cap, inside the parapet line.
  const inset = 0.25;
  if (fp.x1 - fp.x0 > inset * 2 + 1 && fp.z1 - fp.z0 > inset * 2 + 1) {
    w.box(fp.x0 + inset, y, fp.z0 + inset, fp.x1 - inset, y + 0.02, fp.z1 - inset, Material.RoofTar, VIS, 128);
  }

  // Keep the routes onto the roof and the overwatch spots clear.
  const keep: [number, number, number][] = [];
  for (let i = 0; i < ctx.perches.length; i += 3) keep.push([ctx.perches[i], ctx.perches[i + 2], 1.4]);
  for (let i = 0; i < ctx.ladders.length; i += 8) keep.push([ctx.ladders[i + 3], ctx.ladders[i + 5], 1.8]);
  const kept = (x0: number, z0: number, x1: number, z1: number) =>
    keep.some(([kx, kz, rr]) => kx > x0 - rr && kx < x1 + rr && kz > z0 - rr && kz < z1 + rr);

  /** Try a few spots for an item of size sx x sz, at least `edge` meters in from the roof edge. */
  const spot = (sx: number, sz: number, h: number, edge: number): [number, number] | null => {
    const spanX = fp.x1 - fp.x0 - edge * 2 - sx;
    const spanZ = fp.z1 - fp.z0 - edge * 2 - sz;
    if (spanX < 0 || spanZ < 0) return null;
    for (let k = 0; k < 6; k++) {
      const x = fp.x0 + edge + r() * spanX;
      const z = fp.z0 + edge + r() * spanZ;
      if (kept(x, z, x + sx, z + sz)) continue;
      // A meter of air around it, so it never pinches a walkway shut.
      if (w.overlaps(x - 1, y + 0.03, z - 1, x + sx + 1, y + h + 1, z + sz + 1)) continue;
      return [x, z];
    }
    return null;
  };

  const area = (fp.x1 - fp.x0) * (fp.z1 - fp.z0);
  const tall = b.floors >= 3;
  const items = Math.min(4, Math.floor(area / 45));
  for (let i = 0; i < items; i++) {
    const k = r();
    if (k < 0.4) {
      // Condenser unit with a fan grille on top.
      const s = spot(1.3, 1.0, 1.0, 1.2);
      if (!s) continue;
      const [x, z] = s;
      w.box(x, y, z, x + 1.3, y + 0.95, z + 1.0, Material.Metal, SOLID, 4);
      w.box(x + 0.1, y + 0.95, z + 0.05, x + 1.2, y + 0.97, z + 0.95, Material.Facade, VIS, FacadeCell.Grille);
    } else if (k < 0.6) {
      // Vent stacks with caps.
      const s = spot(0.35, 0.35, 1.1, 1.2);
      if (!s) continue;
      const [x, z] = s;
      w.box(x, y, z, x + 0.35, y + 0.9, z + 0.35, Material.Metal, SOLID, 4);
      w.box(x - 0.08, y + 0.9, z - 0.08, x + 0.43, y + 1.0, z + 0.43, Material.Metal, VIS, 4);
    } else if (k < 0.8 && tall && ctx.district.id !== District.Industrial) {
      // Timber water tank on a steel stand.
      const s = spot(2.0, 2.0, 3.8, 1.5);
      if (!s) continue;
      const [x, z] = s;
      for (const [lx, lz] of [[0.1, 0.1], [1.75, 0.1], [0.1, 1.75], [1.75, 1.75]]) w.box(x + lx, y, z + lz, x + lx + 0.15, y + 1.4, z + lz + 0.15, Material.Metal, SOLID, 4);
      w.box(x, y + 1.4, z, x + 2.0, y + 3.5, z + 2.0, Material.Wood, SOLID, 110);
      w.box(x + 0.1, y + 3.5, z + 0.1, x + 1.9, y + 3.8, z + 1.9, Material.Metal, VIS, 4);
    } else if (k < 0.9) {
      // Skylight: dark glazing in a low curb, split by a glazing bar (not a wall window laid flat).
      const s = spot(1.4, 2.0, 0.3, 1.2);
      if (!s) continue;
      const [x, z] = s;
      w.box(x, y, z, x + 1.4, y + 0.22, z + 2.0, Material.Metal, SOLID, 4);
      w.box(x + 0.08, y + 0.22, z + 0.08, x + 1.32, y + 0.24, z + 1.92, Material.CarGlass, VIS, CarGlassTint.Intact);
      w.box(x + 0.66, y + 0.24, z + 0.08, x + 0.74, y + 0.27, z + 1.92, Material.Metal, VIS, 4);
    } else if (tall) {
      // Antenna mast with cross arms (see-through, no collision).
      const s = spot(0.1, 0.1, 5, 1.0);
      if (!s) continue;
      const [x, z] = s;
      const h = 3 + r() * 3;
      w.box(x, y, z, x + 0.08, y + h, z + 0.08, Material.Metal, VIS, 4);
      for (let a = 1; a <= 2; a++) w.box(x - 0.5, y + h * (0.55 + a * 0.18), z + 0.02, x + 0.58, y + h * (0.55 + a * 0.18) + 0.04, z + 0.06, Material.Metal, VIS, 4);
    }
  }
}

export function dressBuildings(ctx: GenContext, r: Rand): void {
  ctx.w.indexed();
  const D = new Dresser(ctx, r);
  // Snapshot: dressing one building must not stop the next from being dressed around it.
  const buildings = [...ctx.buildings];
  for (const b of buildings) if (b.kind === 'block' && b.wallTop !== undefined) dressBlock(D, b);
  trimOpenings(D);
  // Landmark roofs are designed (stair houses, parking decks with ramp holes): left alone.
  for (const b of buildings) if (b.kind !== 'landmark') dressRoof(D, b);
}
