import { randInt, type Rand } from '../../core/rng';
import { Contents, Ramp, SOLID } from '../../physics/brush';
import type { BrushWriter } from './BrushWriter';
import { District, Material } from './ChunkData';
import { inset, Occ, rd, rect, rw, subtractRects, type BuildingInfo, type GenContext, type Rect } from './genContext';

interface Opening {
  a: number;
  b: number;
  bottom: number;
  top: number;
}

const WALL_T = 0.3;
const DOOR_W = 1.6;
const DOOR_H = 2.4;
const FLOOR_H = 3.5;
const SLAB_T = 0.25;

/** Thin interior/house walls can be shot through. */
const THIN_WALL = SOLID | Contents.PENETRABLE;

/**
 * A straight wall with openings. `alongX` walls span x in [a0, a1] at z in [c0, c1];
 * otherwise they span z in [a0, a1] at x in [c0, c1]. Openings are in wall-length coordinates.
 */
function wall(
  w: BrushWriter,
  alongX: boolean,
  a0: number,
  a1: number,
  c0: number,
  c1: number,
  y0: number,
  height: number,
  openings: Opening[],
  mat: number,
  tint: number,
  contents: number = SOLID,
): void {
  const put = (s0: number, s1: number, yb: number, yt: number) => {
    if (s1 - s0 < 0.01 || yt - yb < 0.01) return;
    if (alongX) w.box(s0, yb, c0, s1, yt, c1, mat, contents, tint);
    else w.box(c0, yb, s0, c1, yt, s1, mat, contents, tint);
  };
  const ops = [...openings].sort((p, q) => p.a - q.a);
  let cur = a0;
  for (const o of ops) {
    const oa = Math.max(cur, o.a);
    const ob = Math.min(a1, o.b);
    if (ob <= oa) continue;
    put(cur, oa, y0, y0 + height);
    put(oa, ob, y0, y0 + o.bottom);
    put(oa, ob, y0 + o.top, y0 + height);
    cur = ob;
  }
  put(cur, a1, y0, y0 + height);
}

/** Openings for a wall of given length: an optional door plus evenly spaced windows. */
function wallOpenings(r: Rand, a0: number, a1: number, door: number | null, windows: boolean, winBottom: number, winTop: number): Opening[] {
  const out: Opening[] = [];
  if (door !== null) out.push({ a: door, b: door + DOOR_W, bottom: 0, top: DOOR_H });
  if (!windows) return out;
  const len = a1 - a0;
  const n = Math.floor((len - 1) / 3.2);
  for (let i = 0; i < n; i++) {
    const c = a0 + ((i + 1) * len) / (n + 1);
    const wa = c - 0.6;
    const wb = c + 0.6;
    if (wa < a0 + 0.6 || wb > a1 - 0.6) continue;
    if (door !== null && wb > door - 0.5 && wa < door + DOOR_W + 0.5) continue;
    if (r() < 0.8) out.push({ a: wa, b: wb, bottom: winBottom, top: winTop });
  }
  return out;
}

/** Clear zone around a door: `out` meters outside, `inn` inside, `hw` half-width along the wall. */
function doorClearance(px: number, pz: number, nx: number, nz: number, hw: number, out: number, inn: number): Rect {
  if (nz !== 0) {
    const a = pz + nz * out;
    const b = pz - nz * inn;
    return rect(px - hw, Math.min(a, b), px + hw, Math.max(a, b));
  }
  const a = px + nx * out;
  const b = px - nx * inn;
  return rect(Math.min(a, b), pz - hw, Math.max(a, b), pz + hw);
}

/** Shuffle helper. */
function shuffled<T>(r: Rand, a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** Side ids: 0 = -Z, 1 = +Z, 2 = -X, 3 = +X. */
type Side = 0 | 1 | 2 | 3;

/** Record the roof cap just written (the last brush) for the rooftop pass. */
function roof(ctx: GenContext, kind: BuildingInfo['kind'], fp: Rect, floors: number, roofY: number, overhang: number, doorSides: number[]): void {
  const cap = rect(fp.x0 - overhang, fp.z0 - overhang, fp.x1 + overhang, fp.z1 + overhang);
  ctx.buildings.push({ kind, fp, floors, roofY, capBrush: ctx.w.count - 1, cap, doorSides });
}

export function buildBuilding(ctx: GenContext, parcel: Rect): boolean {
  const d = ctx.district;
  const fp = inset(parcel, d.setback);
  if (rw(fp) < 5 || rd(fp) < 5) return false;
  const r = ctx.r;
  const floors = randInt(r, d.floorsMin, d.floorsMax);
  const canEnter = rw(fp) >= 6 && rd(fp) >= 6;
  const enterable = canEnter && r() < d.enterable;
  const mat = r() < 0.72 ? d.wallMaterial : d.altWallMaterial;
  const tint = mat === Material.Metal ? 4 : 80 + Math.floor(r() * 150);
  ctx.occ.mark(fp, Occ.Solid);
  if (d.id === District.Industrial && enterable) warehouse(ctx, fp, tint);
  else if (enterable) house(ctx, fp, floors, mat, tint);
  else solidBlock(ctx, fp, floors, mat, tint);
  return true;
}

function solidBlock(ctx: GenContext, fp: Rect, floors: number, mat: number, tint: number): void {
  const { w, lotY, r } = ctx;
  const height = Math.max(3.2, floors * FLOOR_H);
  const downtown = ctx.district.id === District.Downtown;
  if (downtown && floors >= 3) {
    // Tower: alternating wall bands and recessed window bands.
    w.box(fp.x0, lotY, fp.z0, fp.x1, lotY + FLOOR_H, fp.z1, mat, SOLID, tint);
    for (let f = 1; f < floors; f++) {
      const y = lotY + f * FLOOR_H;
      w.box(fp.x0 + 0.15, y, fp.z0 + 0.15, fp.x1 - 0.15, y + 1.3, fp.z1 - 0.15, Material.Metal, SOLID, 1);
      w.box(fp.x0, y + 1.3, fp.z0, fp.x1, y + FLOOR_H, fp.z1, mat, SOLID, tint);
    }
    w.box(fp.x0 - 0.1, lotY + height, fp.z0 - 0.1, fp.x1 + 0.1, lotY + height + 0.5, fp.z1 + 0.1, mat, SOLID, tint);
    roof(ctx, 'block', fp, floors, lotY + height + 0.5, 0.1, []);
  } else {
    w.box(fp.x0, lotY, fp.z0, fp.x1, lotY + height, fp.z1, mat, SOLID, tint);
    // Floor-line ledges (above head height, so they never block walking).
    for (let f = 1; f < floors; f++) {
      const y = lotY + f * FLOOR_H;
      w.box(fp.x0 - 0.12, y - 0.15, fp.z0 - 0.12, fp.x1 + 0.12, y, fp.z1 + 0.12, Material.Wood, SOLID, 110);
    }
    // Parapet cap.
    w.box(fp.x0 - 0.1, lotY + height, fp.z0 - 0.1, fp.x1 + 0.1, lotY + height + 0.3, fp.z1 + 0.1, mat, SOLID, Math.max(0, tint - 40));
    roof(ctx, 'block', fp, floors, lotY + height + 0.3, 0.1, []);
  }
  // Rooftop box (AC unit / stair house).
  if (r() < 0.6 && rw(fp) > 4 && rd(fp) > 4) {
    const cx = fp.x0 + 1 + r() * (rw(fp) - 3);
    const cz = fp.z0 + 1 + r() * (rd(fp) - 3);
    w.box(cx, lotY + height, cz, cx + 1.5, lotY + height + 1.1, cz + 1.2, Material.Metal, SOLID, 4);
  }
}

function house(ctx: GenContext, fp: Rect, floors: number, mat: number, tint: number): void {
  const { w, lotY, r } = ctx;
  const t = WALL_T;
  const I = inset(fp, t);
  const twoStory = floors >= 2 && rw(I) >= 7 && rd(I) >= 6.5;
  const groundH = twoStory ? FLOOR_H - SLAB_T : 3.2;
  // Interior floor space is open for props (walls stay marked solid).
  ctx.occ.set(inset(I, 0.3), Occ.Free);

  // Pick door sides (2-3), leaving the stair side door-free for two-story houses.
  const stairSide: Side = r() < 0.5 ? 0 : 1;
  const candidates: Side[] = twoStory ? ([0, 1, 2, 3] as Side[]).filter((s) => s !== stairSide) : [0, 1, 2, 3];
  const doorSides = new Set(shuffled(r, candidates).slice(0, r() < 0.4 ? 3 : 2));

  const doorAt = (a0: number, a1: number) => {
    const span = a1 - a0 - DOOR_W - 2.4;
    return a0 + 1.2 + (span > 0 ? Math.round(r() * span * 2) / 2 : 0);
  };
  const sides: { side: Side; alongX: boolean; a0: number; a1: number; c0: number; c1: number }[] = [
    { side: 0, alongX: true, a0: fp.x0, a1: fp.x1, c0: fp.z0, c1: fp.z0 + t },
    { side: 1, alongX: true, a0: fp.x0, a1: fp.x1, c0: fp.z1 - t, c1: fp.z1 },
    { side: 2, alongX: false, a0: fp.z0 + t, a1: fp.z1 - t, c0: fp.x0, c1: fp.x0 + t },
    { side: 3, alongX: false, a0: fp.z0 + t, a1: fp.z1 - t, c0: fp.x1 - t, c1: fp.x1 },
  ];
  for (const s of sides) {
    let door: number | null = null;
    if (doorSides.has(s.side)) {
      // Side doors on two-story houses stay clear of the stair strip.
      door = s.alongX ? doorAt(s.a0, s.a1) : (s.a0 + s.a1) / 2 - DOOR_W / 2;
      const dc = door + DOOR_W / 2;
      const nx = s.side === 2 ? -1 : s.side === 3 ? 1 : 0;
      const nz = s.side === 0 ? -1 : s.side === 1 ? 1 : 0;
      const px = s.alongX ? dc : (s.c0 + s.c1) / 2;
      const pz = s.alongX ? (s.c0 + s.c1) / 2 : dc;
      ctx.doors.push({ x: px, z: pz, nx, nz });
      // Keep 2 m outside and 1.5 m inside the door clear of props.
      ctx.occ.mark(doorClearance(px, pz, nx, nz, DOOR_W / 2 + 0.3, 2, 1.5), Occ.Reserved);
    }
    const ops = wallOpenings(r, s.a0, s.a1, door, true, 1.0, 2.0);
    wall(w, s.alongX, s.a0, s.a1, s.c0, s.c1, lotY, groundH, ops, mat, tint);
  }

  // Interior partition for long buildings (thin, penetrable, with a doorway).
  if (rw(I) > 10 && !twoStory) {
    const px = I.x0 + Math.round(rw(I) * (0.4 + r() * 0.2));
    const dz = I.z0 + 0.8 + r() * Math.max(0, rd(I) - DOOR_W - 1.6);
    wall(w, false, I.z0, I.z1, px, px + 0.15, lotY, groundH, [{ a: dz, b: dz + DOOR_W, bottom: 0, top: DOOR_H }], Material.Plaster, 160, THIN_WALL);
  }

  ctx.interiors.push(I);

  if (!twoStory) {
    w.box(fp.x0, lotY + groundH, fp.z0, fp.x1, lotY + groundH + SLAB_T, fp.z1, mat, SOLID, Math.max(0, tint - 30));
    w.box(fp.x0 - 0.1, lotY + groundH + SLAB_T, fp.z0 - 0.1, fp.x1 + 0.1, lotY + groundH + SLAB_T + 0.35, fp.z1 + 0.1, mat, SOLID, Math.max(0, tint - 50));
    roof(ctx, 'house', fp, 1, lotY + groundH + SLAB_T + 0.35, 0.1, [...doorSides]);
    return;
  }

  // Stairs along the stair-side wall, rising towards +X, with a hole in the upper slab.
  const rise = FLOOR_H;
  const steps = Math.round(rise / 0.25);
  const tread = 0.3;
  const run = steps * tread;
  // Wide enough that a bot fits between the wall and the railing above the top steps.
  const sw = 1.5;
  const sx0 = I.x0 + 0.9;
  const sx1 = sx0 + run;
  const sz0 = stairSide === 0 ? I.z0 : I.z1 - sw;
  const sz1 = sz0 + sw;
  w.stairs(sx0, lotY, sz0, sx1, lotY + rise, sz1, Ramp.PosX, Material.Wood, 0.25, 150);
  ctx.occ.mark(rect(sx0 - 1, sz0 - 0.8, sx1 + 1, sz1 + 0.8), Occ.Reserved);

  const upperY = lotY + FLOOR_H;
  // The slab meets the top step flush, so the landing is continuous floor.
  const hole = rect(sx0 - 0.1, sz0, sx1, sz1);
  for (const piece of subtractRects(I, [hole])) {
    w.box(piece.x0, upperY - SLAB_T, piece.z0, piece.x1, upperY, piece.z1, Material.Wood, SOLID | Contents.FLOOR, 120);
  }
  // Railing along the open side of the stair hole.
  const railZ = stairSide === 0 ? sz1 : sz0 - 0.08;
  w.box(sx0 + 1.2, upperY, railZ, sx1, upperY + 1.0, railZ + 0.08, Material.Wood, SOLID, 90);

  // Upper floor walls with windows all round.
  const upperH = 3.0;
  for (const s of sides) {
    const ops = wallOpenings(r, s.a0, s.a1, null, true, 0.9, 2.1);
    wall(w, s.alongX, s.a0, s.a1, s.c0, s.c1, upperY, upperH, ops, mat, tint);
  }
  const roofY = upperY + upperH;
  w.box(fp.x0, roofY, fp.z0, fp.x1, roofY + SLAB_T, fp.z1, mat, SOLID, Math.max(0, tint - 30));
  w.box(fp.x0 - 0.1, roofY + SLAB_T, fp.z0 - 0.1, fp.x1 + 0.1, roofY + SLAB_T + 0.35, fp.z1 + 0.1, mat, SOLID, Math.max(0, tint - 50));
  roof(ctx, 'house', fp, 2, roofY + SLAB_T + 0.35, 0.1, [...doorSides]);

  // Perches: upper floor spots next to windows, for overwatch bots.
  const py = upperY + 0.02;
  ctx.perches.push((I.x0 + I.x1) / 2, py, stairSide === 0 ? I.z1 - 0.8 : I.z0 + 0.8);
  ctx.perches.push(I.x1 - 0.8, py, (I.z0 + I.z1) / 2);
}

function warehouse(ctx: GenContext, fp: Rect, tint: number): void {
  const { w, lotY, r } = ctx;
  const t = WALL_T;
  const H = 7;
  const I = inset(fp, t);
  ctx.occ.set(inset(I, 0.3), Occ.Free);
  const bigSide: Side = r() < 0.5 ? 0 : 1;
  const sides: { side: Side; alongX: boolean; a0: number; a1: number; c0: number; c1: number }[] = [
    { side: 0, alongX: true, a0: fp.x0, a1: fp.x1, c0: fp.z0, c1: fp.z0 + t },
    { side: 1, alongX: true, a0: fp.x0, a1: fp.x1, c0: fp.z1 - t, c1: fp.z1 },
    { side: 2, alongX: false, a0: fp.z0 + t, a1: fp.z1 - t, c0: fp.x0, c1: fp.x0 + t },
    { side: 3, alongX: false, a0: fp.z0 + t, a1: fp.z1 - t, c0: fp.x1 - t, c1: fp.x1 },
  ];
  const sideDoor: Side = r() < 0.5 ? 2 : 3;
  for (const s of sides) {
    const ops: Opening[] = [];
    const len = s.a1 - s.a0;
    if (s.side === bigSide) {
      const bw = Math.min(4, len - 3);
      const a = s.a0 + (len - bw) / 2;
      ops.push({ a, b: a + bw, bottom: 0, top: 4 });
      ctx.doors.push({ x: a + bw / 2, z: (s.c0 + s.c1) / 2, nx: 0, nz: s.side === 0 ? -1 : 1 });
      const nz = s.side === 0 ? -1 : 1;
      ctx.occ.mark(rect(a - 0.5, nz < 0 ? s.c0 - 3 : s.c0 - 2, a + bw + 0.5, nz < 0 ? s.c1 + 2 : s.c1 + 3), Occ.Reserved);
    } else if (s.side === sideDoor) {
      const a = s.a0 + (len - DOOR_W) / 2;
      ops.push({ a, b: a + DOOR_W, bottom: 0, top: DOOR_H });
      const nx = s.side === 2 ? -1 : 1;
      ctx.doors.push({ x: (s.c0 + s.c1) / 2, z: a + DOOR_W / 2, nx, nz: 0 });
      ctx.occ.mark(rect(nx < 0 ? s.c0 - 2 : s.c0 - 1.5, a - 0.3, nx < 0 ? s.c1 + 1.5 : s.c1 + 2, a + DOOR_W + 0.3), Occ.Reserved);
    }
    // High clerestory windows.
    const n = Math.floor(len / 4);
    for (let i = 0; i < n; i++) {
      const c = s.a0 + ((i + 0.5) * len) / n;
      if (ops.some((o) => c + 0.8 > o.a - 0.3 && c - 0.8 < o.b + 0.3 && o.top > 4.4)) continue;
      ops.push({ a: c - 0.8, b: c + 0.8, bottom: 4.6, top: 5.6 });
    }
    wall(w, s.alongX, s.a0, s.a1, s.c0, s.c1, lotY, H, ops, Material.Metal, tint);
  }
  w.box(fp.x0 - 0.2, lotY + H, fp.z0 - 0.2, fp.x1 + 0.2, lotY + H + 0.3, fp.z1 + 0.2, Material.Metal, SOLID, 4);
  roof(ctx, 'warehouse', fp, 1, lotY + H + 0.3, 0.2, [bigSide, sideDoor]);

  // Catwalk along the wall opposite the big door, with a ramp up to it.
  if (rw(I) >= 12 && rd(I) >= 9) {
    const depth = 1.6;
    const cy = lotY + 3;
    const cz0 = bigSide === 0 ? I.z1 - depth : I.z0;
    const cz1 = cz0 + depth;
    const cxa = I.x0 + 0.5;
    const cxb = I.x1 - 0.5;
    w.box(cxa, cy - 0.2, cz0, cxb, cy, cz1, Material.Metal, SOLID | Contents.FLOOR, 4);
    // Railing.
    const rz = bigSide === 0 ? cz0 : cz1 - 0.06;
    w.box(cxa + 7.2, cy, rz, cxb, cy + 1.0, rz + 0.06, Material.Metal, SOLID, 4);
    // Supports.
    for (let x = cxa + 3; x < cxb - 1; x += 5) w.box(x, lotY, cz0 + 0.1, x + 0.15, cy - 0.2, cz0 + 0.25, Material.Metal, SOLID, 4);
    // Ramp from the floor up to the catwalk, running along the catwalk.
    const rz0 = bigSide === 0 ? cz0 - depth : cz1;
    w.ramp(cxa, lotY, rz0, cxa + 7, cy, rz0 + depth, Ramp.NegX, Material.Metal, SOLID | Contents.FLOOR, 4);
    ctx.occ.mark(rect(cxa - 1, Math.min(rz0, cz0) - 1, cxb, Math.max(rz0 + depth, cz1) + 1), Occ.Reserved);
    for (let x = cxa + 9; x < cxb - 1; x += 6) ctx.perches.push(x, cy + 0.02, (cz0 + cz1) / 2);
  }
  ctx.interiors.push(I);
}

/** Courtyard: a walled square with 2-3 gaps. The inside is left open for props and fights. */
export function buildCourtyard(ctx: GenContext, parcel: Rect): Rect {
  const { w, lotY, r } = ctx;
  const c = inset(parcel, 0.5);
  const t = 0.4;
  const h = 2.8;
  const mat = ctx.district.wallMaterial === Material.Metal ? Material.Concrete : ctx.district.wallMaterial;
  const tint = 90 + Math.floor(r() * 120);
  const gapSides = new Set(shuffled(r, [0, 1, 2, 3]).slice(0, r() < 0.5 ? 3 : 2));
  const gap = (a0: number, a1: number) => {
    const gw = 1.8 + Math.floor(r() * 2) * 0.6;
    const at = a0 + 1 + r() * Math.max(0, a1 - a0 - gw - 2);
    return { a: at, b: at + gw, bottom: 0, top: h + 1 };
  };
  const walls: [number, boolean, number, number, number, number][] = [
    [0, true, c.x0, c.x1, c.z0, c.z0 + t],
    [1, true, c.x0, c.x1, c.z1 - t, c.z1],
    [2, false, c.z0 + t, c.z1 - t, c.x0, c.x0 + t],
    [3, false, c.z0 + t, c.z1 - t, c.x1 - t, c.x1],
  ];
  for (const [side, alongX, a0, a1, c0, c1] of walls) {
    const ops = gapSides.has(side) ? [gap(a0, a1)] : [];
    wall(w, alongX, a0, a1, c0, c1, lotY, h, ops, mat, tint);
    const band = alongX ? rect(a0, c0, a1, c1) : rect(c0, a0, c1, a1);
    ctx.occ.mark(band, Occ.Solid);
    for (const o of ops) {
      // Keep the gap and its approach clear.
      const g = alongX ? rect(o.a - 0.3, c0 - 1.5, o.b + 0.3, c1 + 1.5) : rect(c0 - 1.5, o.a - 0.3, c1 + 1.5, o.b + 0.3);
      ctx.occ.mark(g, Occ.Reserved);
    }
  }
  const inner = inset(c, t);
  // Occasional well / planter in the middle.
  if (r() < 0.5 && rw(inner) > 8 && rd(inner) > 8) {
    const mx = (inner.x0 + inner.x1) / 2;
    const mz = (inner.z0 + inner.z1) / 2;
    w.box(mx - 0.9, lotY, mz - 0.9, mx + 0.9, lotY + 0.9, mz + 0.9, Material.Concrete, SOLID, 170);
    ctx.occ.mark(rect(mx - 1.6, mz - 1.6, mx + 1.6, mz + 1.6), Occ.Prop);
  }
  return inner;
}
