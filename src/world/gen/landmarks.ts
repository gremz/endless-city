import { randInt, type Rand } from '../../core/rng';
import { Contents, Ramp, SOLID, type RampDir } from '../../physics/brush';
import { DOOR_H, doorLeaf, FLOOR_H, lockDoor, SLAB_T, THIN_WALL, wall, wallOpenings, WALL_T, type Opening } from './buildings';
import { District, DoorFlag, Landmark, Material } from './ChunkData';
import { Occ, rect, subtractRects, type GenContext, type Rect } from './genContext';
import { rollCarStyle, carBrushes, CAR_L, CAR_W } from './streets';

/**
 * Landmark buildings: big enterable buildings, several storeys high, one per landmark chunk.
 * - Apartment block: a corridor on every floor with rooms behind doors on both sides.
 * - Office: open-plan floors of desks behind glass curtain walls, a glazed lobby.
 * - Parking garage: open decks joined by long ramps cars can drive up.
 * The apartment and office share a switchback stair core that runs up to a stair house on the
 * roof. All floors are walkable nav, so squads spawn and fight on every level.
 */

export type LandmarkKind = 'apartment' | 'office' | 'garage';

export const LANDMARK_IDS: Record<LandmarkKind, number> = { apartment: Landmark.Apartment, office: Landmark.Office, garage: Landmark.Garage };

/** Footprints (long side × short side, meters), not counting the setback around them. */
export const LANDMARK_SIZE: Record<LandmarkKind, [number, number]> = {
  apartment: [22, 15],
  office: [24, 16],
  garage: [26, 18],
};

const FLOOR = SOLID | Contents.FLOOR;
const GARAGE_H = 3;
/** Stair core: strip width, and its zones measured from the landing edge. */
const STRIP = 1.5;
const CORE_W = STRIP * 2;
const CORE_LANDING = 1.4;
const CORE_RUN = 2.1;
const CORE_LEN = CORE_LANDING + CORE_RUN + 1.4;
/** Wide enough for a bot to fit between the jambs (0.46 m clearance each side). */
const INNER_DOOR_W = 1.5;
const INNER_DOOR_H = 2.2;

/** Which landmark (if any) a chunk gets, from the district and a roll. */
export function pickLandmark(district: number, roll: number): LandmarkKind | null {
  if (roll >= 0.34) return null;
  const t = roll / 0.34;
  switch (district) {
    case District.Oldtown:
      return 'apartment';
    case District.Downtown:
      return t < 0.4 ? 'office' : t < 0.75 ? 'apartment' : 'garage';
    case District.Industrial:
      return t < 0.6 ? 'garage' : null;
    default:
      return null;
  }
}

/**
 * Local frame over a footprint: u runs along the long side, v across it. `swap` means u is
 * world Z. Everything below is written in (u, v) and mapped here.
 */
class Frame {
  readonly L: number;
  readonly D: number;

  constructor(
    readonly ctx: GenContext,
    readonly fp: Rect,
    readonly swap: boolean,
  ) {
    this.L = swap ? fp.z1 - fp.z0 : fp.x1 - fp.x0;
    this.D = swap ? fp.x1 - fp.x0 : fp.z1 - fp.z0;
  }

  /** World coordinate along u / v. */
  au(u: number): number {
    return (this.swap ? this.fp.z0 : this.fp.x0) + u;
  }

  av(v: number): number {
    return (this.swap ? this.fp.x0 : this.fp.z0) + v;
  }

  xz(u: number, v: number): [number, number] {
    return this.swap ? [this.av(v), this.au(u)] : [this.au(u), this.av(v)];
  }

  rect(u0: number, v0: number, u1: number, v1: number): Rect {
    const [xa, za] = this.xz(Math.min(u0, u1), Math.min(v0, v1));
    const [xb, zb] = this.xz(Math.max(u0, u1), Math.max(v0, v1));
    return rect(Math.min(xa, xb), Math.min(za, zb), Math.max(xa, xb), Math.max(za, zb));
  }

  box(u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, mat: number, contents: number = SOLID, tint = 128, ramp: RampDir = Ramp.None): void {
    const r = this.rect(u0, v0, u1, v1);
    this.ctx.w.box(r.x0, y0, r.z0, r.x1, y1, r.z1, mat, contents, tint, ramp);
  }

  /** Ramp direction for rising along +u/-u (axis 'u') or +v/-v. */
  dir(axis: 'u' | 'v', sign: number): RampDir {
    const alongX = (axis === 'u') !== this.swap;
    return alongX ? (sign > 0 ? Ramp.PosX : Ramp.NegX) : sign > 0 ? Ramp.PosZ : Ramp.NegZ;
  }

  openStairs(u0: number, v0: number, u1: number, v1: number, y0: number, y1: number, axis: 'u' | 'v', sign: number, mat: number, tint: number): void {
    const r = this.rect(u0, v0, u1, v1);
    this.ctx.w.openStairs(r.x0, y0, r.z0, r.x1, y1, r.z1, this.dir(axis, sign), mat, tint);
  }

  /** A wall running along u (at v in [v0, v1]) with openings in u coordinates. */
  wallU(u0: number, u1: number, v0: number, v1: number, y: number, h: number, ops: Opening[], mat: number, tint: number, contents = SOLID): void {
    const off = this.au(0);
    const shifted = ops.map((o) => ({ ...o, a: o.a + off, b: o.b + off }));
    wall(this.ctx.w, !this.swap, this.au(u0), this.au(u1), this.av(v0), this.av(v1), y, h, shifted, mat, tint, contents, this.ctx.glass, contents === SOLID ? this.ctx.trims : null);
  }

  /** A wall running along v (at u in [u0, u1]) with openings in v coordinates. */
  wallV(v0: number, v1: number, u0: number, u1: number, y: number, h: number, ops: Opening[], mat: number, tint: number, contents = SOLID): void {
    const off = this.av(0);
    const shifted = ops.map((o) => ({ ...o, a: o.a + off, b: o.b + off }));
    wall(this.ctx.w, this.swap, this.av(v0), this.av(v1), this.au(u0), this.au(u1), y, h, shifted, mat, tint, contents, this.ctx.glass, contents === SOLID ? this.ctx.trims : null);
  }

  /** Door leaf in a wall along u (spanning u) or along v, centered at (u, v). */
  door(u: number, v: number, inU: boolean, inward: number, width: number, height: number, flags: number, y: number): number {
    const [x, z] = this.xz(u, v);
    const at = doorLeaf(this.ctx, x, z, inU !== this.swap, inward, width, height, flags);
    this.ctx.doorLeaves[at + 1] = y;
    return at;
  }

  perch(u: number, y: number, v: number): void {
    const [x, z] = this.xz(u, v);
    this.ctx.perches.push(x, y + 0.02, z);
  }
}

/**
 * Switchback stair core, `floors` flights high (the last one reaches the roof). Its landing edge
 * is at u = ul and it runs towards u = ul + s * CORE_LEN, across v in [v0, v0 + CORE_W]: from
 * each floor's landing, flight A climbs half a storey along the first strip to the mid
 * landing, flight B climbs the rest back along the second strip. Returns the hole each upper
 * slab needs.
 */
function stairCore(F: Frame, ul: number, s: number, v0: number, levels: number[], tint: number): Rect {
  const at = (t: number) => ul + s * t;
  const u = (t0: number, t1: number): [number, number] => [Math.min(at(t0), at(t1)), Math.max(at(t0), at(t1))];
  for (let i = 0; i + 1 < levels.length; i++) {
    const y = levels[i];
    const mid = (y + levels[i + 1]) / 2;
    const [ra, rb] = u(CORE_LANDING, CORE_LANDING + CORE_RUN);
    F.openStairs(ra, v0, rb, v0 + STRIP, y, mid, 'u', s, Material.Concrete, tint);
    const [ma, mb] = u(CORE_LANDING + CORE_RUN, CORE_LEN);
    F.box(ma, mid - 0.15, v0, mb, mid, v0 + CORE_W, Material.Concrete, FLOOR, tint);
    F.openStairs(ra, v0 + STRIP, rb, v0 + CORE_W, mid, levels[i + 1], 'u', -s, Material.Concrete, tint);
  }
  const [ha, hb] = u(CORE_LANDING, CORE_LEN);
  return F.rect(ha, v0, hb, v0 + CORE_W);
}

/** A ceiling light panel (lamp glass: it glows at night), render-only. */
function lightPanel(F: Frame, u: number, v: number, ceiling: number, size = 0.6): void {
  F.box(u - size / 2, ceiling - 0.03, v - size / 2, u + size / 2, ceiling, v + size / 2, Material.LampGlow, Contents.VISIBLE, 0);
}

/** A floor slab with holes cut out (in world rects). */
function slab(F: Frame, full: Rect, y: number, holes: Rect[], mat: number, tint: number): void {
  for (const p of subtractRects(full, holes)) F.ctx.w.box(p.x0, y - SLAB_T, p.z0, p.x1, y, p.z1, mat, FLOOR, tint);
}

/** A small box of stairs-top housing on the roof, open towards the roof at the landing end. */
function stairHouse(F: Frame, ul: number, s: number, v0: number, roofY: number, mat: number, tint: number): void {
  const [a, b] = [Math.min(ul, ul + s * CORE_LEN), Math.max(ul, ul + s * CORE_LEN)];
  const h = 2.6;
  F.wallU(a, b, v0 - 0.2, v0, roofY, h, [], mat, tint);
  F.wallU(a, b, v0 + CORE_W, v0 + CORE_W + 0.2, roofY, h, [], mat, tint);
  F.box(a, roofY + h, v0 - 0.2, b, roofY + h + 0.2, v0 + CORE_W + 0.2, mat, SOLID, tint);
}

/** Roof parapet walls around the footprint. */
function parapet(F: Frame, y: number, h: number, mat: number, tint: number): void {
  F.wallU(0, F.L, 0, WALL_T, y, h, [], mat, tint);
  F.wallU(0, F.L, F.D - WALL_T, F.D, y, h, [], mat, tint);
  F.wallV(WALL_T, F.D - WALL_T, 0, WALL_T, y, h, [], mat, tint);
  F.wallV(WALL_T, F.D - WALL_T, F.L - WALL_T, F.L, y, h, [], mat, tint);
}

/** Record the roof for the rooftop pass (bridges to neighbors). */
function roofInfo(F: Frame, floors: number, roofY: number, capBrush: number): void {
  const fp = F.fp;
  F.ctx.buildings.push({ kind: 'landmark', fp, floors, roofY, capBrush, cap: fp, doorSides: [] });
}

/** Some furniture in a room: a table or bed, maybe a cabinet (penetrable cover). */
function furnish(F: Frame, r: Rand, u0: number, v0: number, u1: number, v1: number, y: number, keepOut: Rect[]): void {
  const n = r() < 0.3 ? 0 : r() < 0.7 ? 1 : 2;
  for (let k = 0; k < n; k++) {
    const w = 1.2 + r() * 0.8;
    const d = 0.8 + r() * 0.4;
    const h = r() < 0.5 ? 0.75 : 0.5;
    const along = r() < 0.5;
    const su = along ? w : d;
    const sv = along ? d : w;
    if (u1 - u0 < su + 1.6 || v1 - v0 < sv + 1.6) continue;
    const pu = u0 + 0.8 + r() * (u1 - u0 - su - 1.6);
    const pv = v0 + 0.8 + r() * (v1 - v0 - sv - 1.6);
    const box = F.rect(pu - 0.8, pv - 0.8, pu + su + 0.8, pv + sv + 0.8);
    if (keepOut.some((q) => q.x0 < box.x1 && box.x0 < q.x1 && q.z0 < box.z1 && box.z0 < q.z1)) continue;
    F.box(pu, y, pv, pu + su, y + h, pv + sv, Material.Wood, THIN_WALL, 90 + Math.floor(r() * 80));
  }
}

/** Keep-out zone in front of a door (both sides), so furniture never blocks it. */
function doorZone(F: Frame, u: number, v: number, inU: boolean): Rect {
  return inU ? F.rect(u - 1, v - 1.4, u + 1, v + 1.4) : F.rect(u - 1.4, v - 1, u + 1.4, v + 1);
}

/**
 * Apartment block. The stair core sits at the u = 0 end, centered on the corridor that runs
 * down the middle of every floor; rooms line both sides, each with a door on the corridor.
 * Ground floor: a main entrance at the far end of the corridor and a street door into the
 * first front room.
 */
function apartment(F: Frame, r: Rand, floors: number, front: 0 | 1): void {
  const ctx = F.ctx;
  const { lotY } = ctx;
  const { L, D } = F;
  const rb = ctx.rb;
  const mat = r() < 0.5 ? Material.Brick : Material.Plaster;
  const tint = 90 + Math.floor(r() * 120);
  const vc = D / 2;
  const coreV0 = vc - CORE_W / 2;
  const coreEnd = WALL_T + CORE_LEN;
  const levels = Array.from({ length: floors + 1 }, (_, i) => lotY + i * FLOOR_H);
  const roofY = levels[floors];
  const hole = stairCore(F, coreEnd, -1, coreV0, levels, tint);
  const full = F.rect(WALL_T, WALL_T, L - WALL_T, D - WALL_T);

  // Room cuts along u (shared by every floor).
  const cuts: number[] = [];
  for (let u = coreEnd + 3 + r() * 1.5; u < L - 3.5; u += 3.5 + r() * 2) cuts.push(u);
  const rooms: [number, number][] = [];
  let prev = WALL_T;
  for (const c of [...cuts, L - WALL_T]) {
    rooms.push([prev, c]);
    prev = c;
  }

  for (let f = 0; f < floors; f++) {
    const y = levels[f];
    const h = levels[f + 1] - y - SLAB_T;
    // Exterior walls with glazed windows; the far end has the main entrance on the ground floor.
    const winB = 0.9;
    const winT = 2.1;
    for (const side of [0, 1] as const) {
      const v0 = side === 0 ? 0 : D - WALL_T;
      const ops = wallOpenings(r, WALL_T, L - WALL_T, null, true, winB, winT, rb).filter((o) => !cuts.some((c) => o.a < c + 0.3 && o.b > c - 0.3));
      if (f === 0 && side === front) {
        // Street door into the first front room past the core.
        const [a0, a1] = rooms[0][1] - rooms[0][0] > 3 ? rooms[0] : rooms[1];
        const du = Math.max(a0 + 0.6, Math.min(a1 - 0.6 - INNER_DOOR_W - 0.4, coreEnd + 0.6));
        const clear = ops.filter((o) => o.b < du - 0.4 || o.a > du + INNER_DOOR_W + 0.4);
        clear.push({ a: du, b: du + INNER_DOOR_W + 0.4, bottom: 0, top: DOOR_H });
        F.wallU(0, L, v0, v0 + WALL_T, y, h, clear, mat, tint);
        const leaf = F.door(du + (INNER_DOOR_W + 0.4) / 2, v0 + WALL_T / 2, true, side === 0 ? 1 : -1, INNER_DOOR_W + 0.4, DOOR_H, 0, y);
        if (rb() < 0.3) lockDoor(ctx, leaf);
        ctx.occ.mark(F.rect(du - 0.5, side === 0 ? -2 : D - 1, du + INNER_DOOR_W + 0.9, side === 0 ? 1 : D + 2), Occ.Reserved);
      } else F.wallU(0, L, v0, v0 + WALL_T, y, h, ops, mat, tint);
    }
    const endOps: Opening[] = f === 0 ? [{ a: vc - 0.8, b: vc + 0.8, bottom: 0, top: DOOR_H }] : [{ a: vc - 0.6, b: vc + 0.6, bottom: winB, top: winT, glass: rb() < 0.8 }];
    F.wallV(WALL_T, D - WALL_T, L - WALL_T, L, y, h, endOps, mat, tint);
    if (f === 0) {
      F.door(L - WALL_T / 2, vc, false, -1, 1.6, DOOR_H, 0, y);
      ctx.occ.mark(F.rect(L - 1.5, vc - 1.2, L + 2, vc + 1.2), Occ.Reserved);
    }
    F.wallV(WALL_T, D - WALL_T, 0, WALL_T, y, h, wallOpenings(r, WALL_T, D - WALL_T, null, true, winB, winT, rb).filter((o) => o.b < coreV0 - 0.3 || o.a > coreV0 + CORE_W + 0.3), mat, tint);

    // Core side walls (the core opens onto the corridor at u = coreEnd).
    F.wallU(WALL_T, coreEnd, coreV0 - 0.15, coreV0, y, h, [], Material.Plaster, 160, THIN_WALL);
    F.wallU(WALL_T, coreEnd, coreV0 + CORE_W, coreV0 + CORE_W + 0.15, y, h, [], Material.Plaster, 160, THIN_WALL);

    // Corridor walls with a door into every room, and partitions between rooms.
    const keep: Rect[] = [hole];
    for (const side of [0, 1] as const) {
      const cv0 = side === 0 ? vc - 1.1 : vc + 1;
      const ops: Opening[] = [];
      rooms.forEach(([a0, a1], i) => {
        const lo = Math.max(a0, coreEnd) + 0.4;
        const hi = a1 - 0.4 - INNER_DOOR_W;
        if (hi < lo) return;
        const du = lo + r() * (hi - lo);
        ops.push({ a: du, b: du + INNER_DOOR_W, bottom: 0, top: INNER_DOOR_H });
        const cu = du + INNER_DOOR_W / 2;
        keep.push(doorZone(F, cu, cv0 + 0.05, true));
        if (rb() < 0.6) {
          const leaf = F.door(cu, cv0 + 0.05, true, side === 0 ? -1 : 1, INNER_DOOR_W, INNER_DOOR_H, 0, y);
          if (i > 0 && rb() < 0.15) lockDoor(ctx, leaf);
        }
      });
      F.wallU(coreEnd, L - WALL_T, cv0, cv0 + 0.1, y, h, ops, Material.Plaster, 170, THIN_WALL);
    }
    for (const c of cuts) {
      F.wallV(WALL_T, vc - 1.1, c - 0.05, c + 0.05, y, h, [], Material.Plaster, 150, THIN_WALL);
      F.wallV(vc + 1.1, D - WALL_T, c - 0.05, c + 0.05, y, h, [], Material.Plaster, 150, THIN_WALL);
    }
    // Furniture (never in the core or in front of doors), and overwatch spots at front windows
    // on upper floors.
    keep.push(F.rect(0, coreV0 - 0.7, coreEnd + 0.5, coreV0 + CORE_W + 0.7));
    for (const [a0, a1] of rooms) {
      furnish(F, r, a0, WALL_T, a1, vc - 1.1, y, keep);
      furnish(F, r, a0, vc + 1.1, a1, D - WALL_T, y, keep);
    }
    if (f > 0) F.perch((rooms[1]?.[0] ?? rooms[0][0]) + 1.5, y, front === 0 ? WALL_T + 0.9 : D - WALL_T - 0.9);
    const ceiling = levels[f + 1] - SLAB_T;
    for (let u = coreEnd + 1.5; u < L - 1; u += 4) lightPanel(F, u, vc, ceiling, 0.5);
    for (const [a0, a1] of rooms) {
      lightPanel(F, (Math.max(a0, coreEnd) + a1) / 2, (WALL_T + vc - 1.1) / 2, ceiling);
      lightPanel(F, (Math.max(a0, coreEnd) + a1) / 2, (vc + 1.1 + D - WALL_T) / 2, ceiling);
    }

    const top = levels[f + 1];
    slab(F, full, top, [hole], f + 1 < floors ? Material.Concrete : mat, f + 1 < floors ? 140 : Math.max(0, tint - 40));
  }
  const capBrush = ctx.w.count - 1;
  parapet(F, roofY, 1.0, mat, tint);
  stairHouse(F, coreEnd, -1, coreV0, roofY, mat, tint);
  F.perch(L - 2, roofY, vc);
  roofInfo(F, floors, roofY, capBrush);
}

/**
 * Office: the stair core and an elevator shaft at the u = 0 end, open-plan floors with rows of
 * desks behind glass curtain walls, and a lobby with a glass front and a main door.
 */
function office(F: Frame, r: Rand, floors: number, front: 0 | 1): void {
  const ctx = F.ctx;
  const { lotY } = ctx;
  const { L, D } = F;
  const rb = ctx.rb;
  const mat = Material.Concrete;
  const tint = 120 + Math.floor(r() * 90);
  const vc = D / 2;
  const coreV0 = vc - CORE_W / 2;
  const coreEnd = WALL_T + CORE_LEN;
  const levels = Array.from({ length: floors + 1 }, (_, i) => lotY + i * FLOOR_H);
  const roofY = levels[floors];
  const hole = stairCore(F, coreEnd, -1, coreV0, levels, tint);
  const full = F.rect(WALL_T, WALL_T, L - WALL_T, D - WALL_T);
  // Elevator shaft beside the core, closed off on every floor.
  const shaftV0 = coreV0 + CORE_W + 0.15;
  F.box(WALL_T, lotY, shaftV0, WALL_T + 2.2, roofY + 2.6, shaftV0 + 2.2, Material.Metal, SOLID, 5);

  /** Curtain wall along u: a sill, panes between thin mullions, a band under the next floor. */
  const curtain = (v0: number, y: number, h: number, doorAt: number | null) => {
    const ops: Opening[] = [];
    for (let a = WALL_T + 0.3; a + 2.5 <= L - WALL_T - 0.3; a += 2.8) {
      if (doorAt !== null && a < doorAt + 2 && a + 2.5 > doorAt - 0.4) continue;
      ops.push({ a, b: a + 2.5, bottom: doorAt !== null ? 0.3 : 0.9, top: h - 0.4, glass: rb() < 0.9 });
    }
    if (doorAt !== null) ops.push({ a: doorAt, b: doorAt + 1.6, bottom: 0, top: DOOR_H });
    F.wallU(0, L, v0, v0 + WALL_T, y, h, ops, mat, tint);
  };

  for (let f = 0; f < floors; f++) {
    const y = levels[f];
    const h = levels[f + 1] - y - SLAB_T;
    const lobbyDoor = f === 0 ? Math.round(L / 2) : null;
    curtain(0, y, h, front === 0 ? lobbyDoor : null);
    curtain(D - WALL_T, y, h, front === 1 ? lobbyDoor : null);
    if (lobbyDoor !== null) {
      const v = front === 0 ? WALL_T / 2 : D - WALL_T / 2;
      const leaf = F.door(lobbyDoor + 0.8, v, true, front === 0 ? 1 : -1, 1.6, DOOR_H, 0, y);
      if (rb() < 0.2) lockDoor(ctx, leaf);
      ctx.occ.mark(F.rect(lobbyDoor - 0.6, front === 0 ? -2 : D - 1, lobbyDoor + 2.2, front === 0 ? 1 : D + 2), Occ.Reserved);
    }
    F.wallV(WALL_T, D - WALL_T, 0, WALL_T, y, h, [], mat, tint);
    const endOps: Opening[] = f === 0 ? [{ a: vc - 0.8, b: vc + 0.8, bottom: 0, top: DOOR_H }] : [{ a: vc - 1.2, b: vc + 1.2, bottom: 0.9, top: h - 0.4, glass: rb() < 0.9 }];
    F.wallV(WALL_T, D - WALL_T, L - WALL_T, L, y, h, endOps, mat, tint);
    if (f === 0) {
      F.door(L - WALL_T / 2, vc, false, -1, 1.6, DOOR_H, DoorFlag.Metal, y);
      ctx.occ.mark(F.rect(L - 1.5, vc - 1.2, L + 2, vc + 1.2), Occ.Reserved);
    }
    // Core walls, the side towards the floor open at the landing.
    F.wallU(WALL_T, coreEnd, coreV0 - 0.15, coreV0, y, h, [], Material.Plaster, 170, THIN_WALL);

    // Desks with screens in rows, clear of the core, the doors and a walkway round the edge.
    if (f > 0 || r() < 0.5) {
      const keep = [F.rect(0, 0, coreEnd + 1.5, D), F.rect(L - 3, vc - 2, L, vc + 2)];
      if (lobbyDoor !== null) keep.push(F.rect(lobbyDoor - 1, 0, lobbyDoor + 2.6, D));
      for (let u = coreEnd + 2.5; u + 1.6 < L - 2; u += 3.4) {
        for (const [dv0, dv1] of [
          [1.8, 2.6],
          [D - 2.6, D - 1.8],
          [vc - 2.2, vc - 1.4],
          [vc + 1.4, vc + 2.2],
        ]) {
          const box = F.rect(u - 0.5, dv0 - 0.5, u + 2.1, dv1 + 0.5);
          if (keep.some((q) => q.x0 < box.x1 && box.x0 < q.x1 && q.z0 < box.z1 && box.z0 < q.z1) || r() < 0.2) continue;
          F.box(u, y, dv0, u + 1.6, y + 0.75, dv1, Material.Wood, THIN_WALL, 110);
          const sv = dv0 < vc ? dv1 : dv0 - 0.05;
          F.box(u, y, sv, u + 1.6, y + 1.3, sv + 0.05, Material.Plaster, THIN_WALL, 60);
        }
      }
    }
    const ceiling = levels[f + 1] - SLAB_T;
    for (let u = coreEnd + 2; u < L - 1.5; u += 3.4) for (const v of [D * 0.25, D * 0.5, D * 0.75]) lightPanel(F, u, v, ceiling, 1.2);
    if (f > 0) {
      F.perch(L / 2, y, front === 0 ? WALL_T + 1 : D - WALL_T - 1);
      F.perch(L - 1.5, y, vc + (r() < 0.5 ? -3 : 3));
    }
    slab(F, full, levels[f + 1], [hole, F.rect(WALL_T, shaftV0, WALL_T + 2.2, shaftV0 + 2.2)], Material.Concrete, 150);
  }
  const capBrush = ctx.w.count - 1;
  parapet(F, roofY, 1.1, mat, tint);
  stairHouse(F, coreEnd, -1, coreV0, roofY, mat, tint);
  F.perch(L - 2, roofY, vc);
  roofInfo(F, floors, roofY, capBrush);
}

/**
 * Parking garage: open decks every 3 m on pillars, joined by ramps along the v = 0 side (all
 * rising towards +u, with room to turn at both ends). Half walls round the upper decks, wrecks
 * parked along the far side, and sometimes a car that still runs on the roof deck.
 */
function garage(F: Frame, r: Rand, decks: number): void {
  const ctx = F.ctx;
  const { lotY } = ctx;
  const { L, D } = F;
  const tint = 150 + Math.floor(r() * 60);
  const ramp0 = 6;
  const ramp1 = L - 4;
  const rampV = 4.2;
  const levels = Array.from({ length: decks + 1 }, (_, i) => lotY + i * GARAGE_H);
  const full = F.rect(0, 0, L, D);
  const rampHole = F.rect(ramp0, 0.3, ramp1, 0.3 + rampV);
  for (let k = 0; k < decks; k++) {
    const y = levels[k];
    const top = levels[k + 1];
    // Ramp from this deck to the next, in wedges short enough to leave headroom beneath.
    const rr = F.rect(ramp0, 0.3, ramp1, 0.3 + rampV);
    ctx.w.slopedSlab(rr.x0, y, rr.z0, rr.x1, top, rr.z1, F.dir('u', 1), Material.Concrete, tint - 20);
    // Ramp side wall (keeps cars and people from dropping off the inner edge).
    F.box(ramp0 + 2, y + 0.5, 0.3 + rampV, ramp1, top + 1, 0.3 + rampV + 0.2, Material.Concrete, SOLID, tint);
    // Pillars.
    for (let u = 2; u < L - 1; u += 8) {
      for (const v of [0.3 + rampV + 0.4, D / 2 + 1, D - 1]) {
        if (u > ramp0 - 1 && u < ramp1 + 1 && v < 0.3 + rampV + 1) continue;
        F.box(u, y, v - 0.25, u + 0.5, top - SLAB_T, v + 0.25, Material.Concrete, SOLID, tint);
      }
    }
    // Deck above.
    slab(F, full, top, [rampHole], Material.Concrete, tint);
    // Half walls round the deck above, open where the ramp arrives and leaves.
    const hw = 1;
    F.wallU(0, L, D - 0.25, D, top, hw, [], Material.Concrete, tint);
    F.wallV(0.3 + rampV, D - 0.25, 0, 0.25, top, hw, [], Material.Concrete, tint);
    F.wallV(0.3 + rampV, D - 0.25, L - 0.25, L, top, hw, [], Material.Concrete, tint);
    F.wallU(0, L, 0, 0.25, top, hw, [], Material.Concrete, tint);
    // Wrecks in the bays along the far side.
    for (let u = 1; u + CAR_W < L - 1; u += 2.6) {
      if (r() < 0.55) continue;
      // Nose to the far wall: the car's length runs along v.
      carBrushes(ctx.w, rollCarStyle(r, 'wreck'), F.swap, F.au(u), F.av(D - 0.6 - CAR_L), y);
    }
    if (k > 0) F.perch(L - 2, y, D - 2);
  }
  const roofY = levels[decks];
  if (ctx.rb() < 0.4) {
    // A car that still runs, parked along the roof deck.
    ctx.vehicles.push({ style: rollCarStyle(ctx.rb, 'intact'), alongX: !F.swap, lane: F.av(D / 2 + 1 - CAR_W / 2), at: F.au(L / 2 - CAR_L / 2), y: roofY });
  }
  F.perch(L - 2, roofY, D - 2);
  roofInfo(F, decks, roofY, ctx.w.count - 1);
}

/**
 * Build a landmark on `site` (which includes the setback around it). `front` says which long
 * side faces the street: 0 is the side at the low v coordinate.
 */
export function buildLandmark(ctx: GenContext, kind: LandmarkKind, site: Rect, front: 0 | 1, r: Rand): void {
  const fp = rect(site.x0 + 1, site.z0 + 1, site.x1 - 1, site.z1 - 1);
  ctx.occ.mark(fp, Occ.Solid);
  const swap = fp.z1 - fp.z0 > fp.x1 - fp.x0;
  const F = new Frame(ctx, fp, swap);
  if (kind === 'apartment') apartment(F, r, ctx.district.id === District.Downtown ? randInt(r, 4, 5) : randInt(r, 3, 4), front);
  else if (kind === 'office') office(F, r, randInt(r, 4, 6), front);
  else garage(F, r, ctx.district.id === District.Industrial ? randInt(r, 2, 3) : randInt(r, 3, 4));
}
