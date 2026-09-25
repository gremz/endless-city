import { CHUNK } from '../../core/config';
import { hash3, Salt, sfc32, type Rand } from '../../core/rng';
import { Contents, Ramp, SOLID } from '../../physics/brush';
import { BrushWriter } from './BrushWriter';
import { District, Material } from './ChunkData';
import { BURNT_PAINT, CAR_PAINT_COUNT, CarGlassTint, CarTrim, PRIMER_PAINT, RUST_PAINT, WRECK_PAINT_BASE, WRECK_PAINT_COUNT } from './meshBake';
import { Occ, rect, subtractRects, type GenContext, type Rect } from './genContext';

/** Road half-width inside this chunk and sidewalk width. The lot is the inner region. */
export const ROAD = 4;
export const WALK = 2;
export const LOT0 = ROAD + WALK;
export const LOT1 = CHUNK - LOT0;
export const CURB = 0.15;

const FLOOR = SOLID | Contents.FLOOR;

/** Street lamp spots (chunk-local x, z): the same in every chunk, so the sim can find them too. */
export const LAMPS: readonly (readonly [number, number])[] = [
  [LOT0 - 1, LOT0 - 1],
  [LOT1 + 1, LOT0 - 1],
  [LOT0 - 1, LOT1 + 1],
  [LOT1 + 1, LOT1 + 1],
  [CHUNK / 2, LOT0 - 1],
  [CHUNK / 2, LOT1 + 1],
];
/** Height of the lamp head (the light comes from just below it). */
export const LAMP_Y = 5;

/**
 * Distance (m, horizontal) from a world point to the nearest street lamp. `stands` can rule out
 * lamps that aren't there (chunk, lamp index).
 */
export function nearestLampDist(x: number, z: number, stands?: (cx: number, cz: number, i: number) => boolean): number {
  const cx = Math.floor(x / CHUNK);
  const cz = Math.floor(z / CHUNK);
  let best = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ox = (cx + dx) * CHUNK;
      const oz = (cz + dz) * CHUNK;
      LAMPS.forEach(([lx, lz], i) => {
        if (!stands || stands(cx + dx, cz + dz, i)) best = Math.min(best, Math.hypot(ox + lx - x, oz + lz - z));
      });
    }
  }
  return best;
}
const PAINT = Contents.VISIBLE;

/** Asphalt, sidewalks, curbs, road markings, street lamps. */
export function buildStreets(ctx: GenContext): void {
  const { w, occ } = ctx;
  const C = CHUNK;
  // Road strips around the border (top at y = 0).
  w.box(0, -1, 0, C, 0, ROAD, Material.Asphalt, FLOOR, 128);
  w.box(0, -1, C - ROAD, C, 0, C, Material.Asphalt, FLOOR, 128);
  w.box(0, -1, ROAD, ROAD, 0, C - ROAD, Material.Asphalt, FLOOR, 128);
  w.box(C - ROAD, -1, ROAD, C, 0, C - ROAD, Material.Asphalt, FLOOR, 128);

  // Sidewalk ring (curb height). If the lot is sunken it doubles as the retaining wall.
  const bottom = Math.min(0, ctx.lotY) - 0.5;
  const sw = Material.Sidewalk;
  w.box(ROAD, bottom, ROAD, C - ROAD, CURB, LOT0, sw, FLOOR, 150);
  w.box(ROAD, bottom, LOT1, C - ROAD, CURB, C - ROAD, sw, FLOOR, 150);
  w.box(ROAD, bottom, LOT0, LOT0, CURB, LOT1, sw, FLOOR, 150);
  w.box(LOT1, bottom, LOT0, C - ROAD, CURB, LOT1, sw, FLOOR, 150);
  occ.mark(rect(0, 0, C, LOT0), Occ.Reserved);
  occ.mark(rect(0, LOT1, C, C), Occ.Reserved);
  occ.mark(rect(0, 0, LOT0, C), Occ.Reserved);
  occ.mark(rect(LOT1, 0, C, C), Occ.Reserved);

  // Dashed center lines on the chunk borders (each chunk paints its half of the line).
  const lw = 0.07;
  for (let a = 8; a < C - 8; a += 3) {
    w.box(a, 0, 0, a + 1.5, 0.01, lw, Material.Paint, PAINT, 200);
    w.box(a, 0, C - lw, a + 1.5, 0.01, C, Material.Paint, PAINT, 200);
    w.box(0, 0, a, lw, 0.01, a + 1.5, Material.Paint, PAINT, 200);
    w.box(C - lw, 0, a, C, 0.01, a + 1.5, Material.Paint, PAINT, 200);
  }
  // Street lamps on the sidewalk corners, glass underneath the head.
  for (const [x, z] of LAMPS) {
    w.box(x - 0.09, CURB, z - 0.09, x + 0.09, LAMP_Y, z + 0.09, Material.Metal, SOLID, 4);
    w.box(x - 0.25, LAMP_Y, z - 0.25, x + 0.25, LAMP_Y + 0.15, z + 0.25, Material.Metal, SOLID, 4);
    w.box(x - 0.2, LAMP_Y - 0.04, z - 0.2, x + 0.2, LAMP_Y, z + 0.2, Material.LampGlow, Contents.VISIBLE, 0);
  }

  buildEdges(ctx);
}

/**
 * Edge features on the roads between chunks. The shared edge hash picks the feature so both
 * neighbors agree; each chunk builds only the half on its own side. `sides` (-Z, +Z, -X, +X)
 * leaves out edges with no road (along the river).
 */
export function buildEdges(ctx: GenContext, sides: readonly boolean[] = [true, true, true, true]): void {
  const { seed, cx, cz, w } = ctx;
  const C = CHUNK;
  // [hash, alongX (road runs along X), stripStart, stripEnd, sideSign]
  const edges: [number, boolean, number, number][] = [
    [hash3(seed, cx + 1, cz, Salt.EdgeX), false, C - ROAD, C], // +X edge: road runs along Z
    [hash3(seed, cx, cz, Salt.EdgeX), false, 0, ROAD], // -X edge
    [hash3(seed, cx, cz + 1, Salt.EdgeZ), true, C - ROAD, C], // +Z edge: road runs along X
    [hash3(seed, cx, cz, Salt.EdgeZ), true, 0, ROAD], // -Z edge
  ];
  // Edge order here is +X, -X, +Z, -Z; `sides` is indexed -Z, +Z, -X, +X.
  const sideOf = [3, 2, 1, 0];
  for (let e = 0; e < edges.length; e++) {
    if (!sides[sideOf[e]]) continue;
    const [h, alongX, s0, s1] = edges[e];
    if (e === SPAWN_CAR_EDGE && ctx.district.id === District.Spawn) {
      // The spawn plaza always has a car ready on its own half of the -Z road.
      const r = sfc32(h ^ 0x5a17);
      parkVehicle(ctx, rollCarStyle(r, 'intact'), alongX, parkLane(s0 + s1 < C), SPAWN_CAR_AT, 0);
      continue;
    }
    const roll = h % 100;
    const r = sfc32(h ^ 0x9e37);
    // Shared position along the road, away from intersections.
    const along = 14 + (Math.floor(r() * 1000) % 34);
    const near = (s0 + s1) / 2 < C / 2;
    if (roll < 75) continue;
    if (roll < 90) {
      // Parked cars against the curb on my half of the road. Often one of them still runs.
      const n = 2 + Math.floor(r() * 3);
      const dr = sfc32(h ^ 0x51ed);
      const driveable = dr() < DRIVEABLE_ROW_CHANCE ? Math.floor(dr() * n) : -1;
      const lane = parkLane(near);
      for (let i = 0; i < n; i++) {
        const t = 10 + i * 12 + Math.floor(r() * 5);
        if (t > C - 12) break;
        if (i === driveable) parkVehicle(ctx, rollCarStyle(r, 'intact'), alongX, lane, t, 0);
        else car(w, r, alongX, lane, t);
      }
    } else {
      // A container left in the road on my half.
      const lane = near ? s0 + 0.6 : s1 - 3.0;
      if (alongX) w.box(along, 0, lane, along + 6.06, 2.6, lane + 2.44, Material.Metal, SOLID, Math.floor(r() * 6));
      else w.box(lane, 0, along, lane + 2.44, 2.6, along + 6.06, Material.Metal, SOLID, Math.floor(r() * 6));
    }
  }
}

/**
 * Near side of a car parked against the curb, two wheels up on the sidewalk so it leaves the
 * road clear. `near`: the road strip at the low edge of the chunk (its curb is at ROAD).
 */
function parkLane(near: boolean): number {
  return near ? CURB_PARK : CHUNK - CURB_PARK - CAR_W;
}
/** Distance from the road's center line to a curb-parked car's near side. */
const CURB_PARK = ROAD - 1.2;

/** Chance a row of parked cars has one driveable car in it. */
const DRIVEABLE_ROW_CHANCE = 0.75;
/** Edge (index into buildEdges' list) and position of the spawn plaza's car. */
const SPAWN_CAR_EDGE = 3;
const SPAWN_CAR_AT = 27;

/** A driveable car: a vehicle spawn instead of brushes. */
export function parkVehicle(ctx: GenContext, style: CarStyle, alongX: boolean, lane: number, at: number, y: number): void {
  ctx.vehicles.push({ style, alongX, lane, at, y });
}

export const CAR_L = 4.3;
export const CAR_W = 1.8;
const DETAIL = Contents.VISIBLE;

/**
 * How a car looks. `intact` cars are the driveable ones (they are vehicles, not brushes);
 * `wreck` is every car baked into the city: flat tires, smashed black glass, dead lights and
 * faded paint, so it's obvious at a glance which cars can't be driven. `burnt` is a car that
 * was destroyed.
 */
export type CarLook = 'intact' | 'wreck' | 'burnt';

export interface CarStyle {
  /** Index into the intact paint colors (0..CAR_PAINT_COUNT-1). */
  paint: number;
  hatch: boolean;
  /** Front at the far end of the footprint instead of the near end. */
  flip: boolean;
  look: CarLook;
}

/** Roll a car's looks. Consumes exactly one value from `r`. */
export function rollCarStyle(r: Rand, look: CarLook): CarStyle {
  const cr = sfc32((r() * 0x100000000) >>> 0);
  const paint = Math.floor(cr() * CAR_PAINT_COUNT);
  const flip = cr() < 0.5;
  const hatch = cr() < 0.4;
  return { paint, hatch, flip, look };
}

/**
 * Heading (yaw, see anglesToForward) of a car laid out by carBrushes: the front is at `at`
 * (or at the far end when flipped).
 */
export function carYaw(alongX: boolean, flip: boolean): number {
  if (alongX) return flip ? -Math.PI / 2 : Math.PI / 2;
  return flip ? Math.PI : 0;
}

/**
 * A parked wreck in a 4.3 x 1.8 m footprint, at most 1.5 m tall (half cover). `lane` is the car's
 * near side. Consumes exactly one value from `r` so the rest of the chunk layout doesn't depend
 * on car looks.
 */
export function car(w: BrushWriter, r: Rand, alongX: boolean, lane: number, at: number, y = 0): void {
  carBrushes(w, rollCarStyle(r, 'wreck'), alongX, lane, at, y);
}

/**
 * Car brushes in a 4.3 x 1.8 m footprint, at most 1.5 m tall. Solid parts (tires, body, bumpers,
 * cabin, sloped glass) block movement and shots; rims, lights, side glass, seams and mirrors are
 * render-only details 1-2 cm proud of the body.
 */
export function carBrushes(w: BrushWriter, style: CarStyle, alongX: boolean, lane: number, at: number, y = 0): void {
  const { hatch, flip, look } = style;
  const intact = look === 'intact';
  const paint =
    look === 'intact' ? style.paint : look === 'wreck' ? WRECK_PAINT_BASE + (style.paint % WRECK_PAINT_COUNT) : BURNT_PAINT;
  const glass = intact ? CarGlassTint.Intact : CarGlassTint.Broken;
  // Wrecks sit on flat tires.
  const sag = look === 'wreck' ? 0.14 : look === 'burnt' ? 0.08 : 0;

  /** Box in car space: s along the length (front at 0), t across, y up. `rise` = ramp towards ±s. */
  const part = (
    s0: number,
    y0: number,
    t0: number,
    s1: number,
    y1: number,
    t1: number,
    mat: number,
    contents: number,
    tint: number,
    rise = 0,
  ) => {
    if (flip) {
      [s0, s1] = [CAR_L - s1, CAR_L - s0];
      rise = -rise;
    }
    const dir = rise === 0 ? Ramp.None : alongX ? (rise > 0 ? Ramp.PosX : Ramp.NegX) : rise > 0 ? Ramp.PosZ : Ramp.NegZ;
    if (alongX) w.box(at + s0, y + y0, lane + t0, at + s1, y + y1, lane + t1, mat, contents, tint, dir);
    else w.box(lane + t0, y + y0, at + s0, lane + t1, y + y1, at + s1, mat, contents, tint, dir);
  };
  /** A body part, lowered onto flat tires on a wreck. */
  const body = (s0: number, y0: number, t0: number, s1: number, y1: number, t1: number, mat: number, contents: number, tint: number, rise = 0) =>
    part(s0, Math.max(0, y0 - sag), t0, s1, y1 - sag, t1, mat, contents, tint, rise);
  /** The same part on both sides of the car (t measured from the near side). */
  const pair = (s0: number, y0: number, t0: number, s1: number, y1: number, t1: number, mat: number, contents: number, tint: number) => {
    body(s0, y0, t0, s1, y1, t1, mat, contents, tint);
    body(s0, y0, CAR_W - t1, s1, y1, CAR_W - t0, mat, contents, tint);
  };

  const { CarPaint, CarGlass, CarWheel, CarTrim: Trim } = Material;
  const roof = hatch ? 1.5 : 1.45;
  const belt = 0.95;
  // Cabin span: windshield base, roof start, roof end, rear window base.
  const ws = 1.25;
  const r0 = 1.85;
  const r1 = hatch ? 3.55 : 3.1;
  const rw = hatch ? 3.8 : 3.6;

  // Solid shell.
  // Wheels: a solid black tire block with the rim texture only on a thin outer face. Flat tires
  // are squashed along with the body.
  const tire = 0.64 - sag;
  for (const s of [0.55, 3.1]) {
    for (const [t0, t1] of [[0.06, 0.3], [CAR_W - 0.3, CAR_W - 0.06]]) part(s, 0, t0, s + 0.64, tire, t1, Trim, SOLID, CarTrim.Plastic);
    for (const [t0, t1] of [[0.05, 0.06], [CAR_W - 0.06, CAR_W - 0.05]]) part(s, 0, t0, s + 0.64, tire, t1, CarWheel, DETAIL, 0);
  }
  body(0.3, 0.14, 0.2, 4.0, 0.34, 1.6, Trim, SOLID, CarTrim.Plastic);
  body(0.1, 0.34, 0.07, 4.2, belt, 1.73, CarPaint, SOLID, paint);
  body(0.01, 0.3, 0.05, 0.1, 0.55, 1.75, Trim, SOLID, CarTrim.Plastic);
  body(4.2, 0.3, 0.05, 4.29, 0.55, 1.75, Trim, SOLID, CarTrim.Plastic);
  body(ws, belt, 0.17, r0, roof, 1.63, CarGlass, SOLID, glass, 1);
  body(r0, belt, 0.15, r1, roof, 1.65, CarPaint, SOLID, paint);
  body(r1, belt, 0.17, rw, roof, 1.63, CarGlass, SOLID, glass, -1);

  if (look === 'wreck') {
    // Rust eating the sills and wheel arches, and a bonnet off another car in grey primer.
    pair(0.3, 0.34, 0.06, 4.0, 0.52, 0.07, CarPaint, DETAIL, RUST_PAINT);
    for (const s of [0.45, 3.0]) pair(s, 0.52, 0.06, s + 0.84, 0.7, 0.07, CarPaint, DETAIL, RUST_PAINT);
    if (style.paint % 3 !== 0) body(0.15, belt, 0.12, ws - 0.02, belt + 0.01, CAR_W - 0.12, CarPaint, DETAIL, PRIMER_PAINT);
  }

  // Side glass (front and rear door windows) with a B-pillar between.
  const top = roof - 0.06;
  pair(r0 + 0.03, 1.0, 0.14, 2.45, top, 0.15, CarGlass, DETAIL, glass);
  pair(2.53, 1.0, 0.14, r1 - 0.03, top, 0.15, CarGlass, DETAIL, glass);
  // Door seams and handles.
  for (const s of [ws, 2.45, 3.05]) pair(s, 0.4, 0.06, s + 0.02, belt - 0.02, 0.07, Trim, DETAIL, CarTrim.Plastic);
  for (const s of [2.15, 2.8]) pair(s, 0.8, 0.05, s + 0.15, 0.84, 0.07, Trim, DETAIL, intact ? CarTrim.Chrome : CarTrim.Plastic);
  // Mirrors (a wreck has lost one).
  if (intact) pair(ws + 0.05, belt, 0, ws + 0.17, belt + 0.12, 0.07, Trim, DETAIL, CarTrim.Plastic);
  else body(ws + 0.05, belt, CAR_W - 0.07, ws + 0.17, belt + 0.12, CAR_W, Trim, DETAIL, CarTrim.Plastic);
  // Front: headlights, grille, plate. A wreck's lights are smashed dark.
  const head = intact ? CarTrim.Headlight : CarTrim.Plastic;
  pair(0.09, 0.68, 0.15, 0.1, 0.82, 0.5, Trim, DETAIL, head);
  pair(0.09, 0.6, 0.5, 0.1, 0.68, 0.6, Trim, DETAIL, intact ? CarTrim.Amber : CarTrim.Plastic);
  body(0.09, 0.6, 0.62, 0.1, 0.82, 1.18, Trim, DETAIL, CarTrim.Plastic);
  if (look !== 'burnt') body(0, 0.36, 0.64, 0.01, 0.48, 1.16, Trim, DETAIL, CarTrim.Plate);
  // Rear: taillights, plate.
  pair(4.2, 0.7, 0.12, 4.21, 0.84, 0.45, Trim, DETAIL, intact ? CarTrim.Taillight : CarTrim.Plastic);
  if (look !== 'burnt') body(4.29, 0.36, 0.64, 4.3, 0.48, 1.16, Trim, DETAIL, CarTrim.Plate);
}

/**
 * Lot slab at ctx.lotY. Raised lots get stair cuts from the sidewalk; sunken lots get ramps
 * down from the sidewalk. Returns rects that must stay clear (stairs/ramps and their landings).
 */
export function buildLot(ctx: GenContext): Rect[] {
  const { w, r, lotY, occ } = ctx;
  const lot = rect(LOT0, LOT0, LOT1, LOT1);
  const mat = ctx.district.groundMaterial;
  const keep: Rect[] = [];
  if (lotY <= CURB + 0.01 && lotY >= CURB - 0.01) {
    w.box(lot.x0, 0, lot.z0, lot.x1, lotY, lot.z1, mat, FLOOR, 140);
    return keep;
  }
  if (lotY < 0) {
    // Sunken yard with loading ramps down from the sidewalk.
    w.box(lot.x0, lotY - 0.5, lot.z0, lot.x1, lotY, lot.z1, Material.Concrete, FLOOR, 120);
    const rampLen = 6;
    const sides = pickSides(r, 2);
    for (const side of sides) {
      const at = 16 + Math.floor(r() * 20);
      let rr: Rect;
      switch (side) {
        case 0: // -Z side, ramp rises towards -Z
          rr = rect(LOT0 + at, LOT0, LOT0 + at + 4, LOT0 + rampLen);
          w.ramp(rr.x0, lotY, rr.z0, rr.x1, CURB, rr.z1, Ramp.NegZ, Material.Concrete);
          break;
        case 1:
          rr = rect(LOT0 + at, LOT1 - rampLen, LOT0 + at + 4, LOT1);
          w.ramp(rr.x0, lotY, rr.z0, rr.x1, CURB, rr.z1, Ramp.PosZ, Material.Concrete);
          break;
        case 2:
          rr = rect(LOT0, LOT0 + at, LOT0 + rampLen, LOT0 + at + 4);
          w.ramp(rr.x0, lotY, rr.z0, rr.x1, CURB, rr.z1, Ramp.NegX, Material.Concrete);
          break;
        default:
          rr = rect(LOT1 - rampLen, LOT0 + at, LOT1, LOT0 + at + 4);
          w.ramp(rr.x0, lotY, rr.z0, rr.x1, CURB, rr.z1, Ramp.PosX, Material.Concrete);
          break;
      }
      occ.mark(rr, Occ.Reserved);
      keep.push(rr);
      // Landing at the bottom of the ramp.
      const land = landingFor(rr, side, 3);
      occ.mark(land, Occ.Reserved);
      keep.push(land);
    }
    return keep;
  }

  // Raised terrace: stair notches cut into the slab from the sidewalk.
  const rise = lotY - CURB;
  const stepH = 0.25;
  const steps = Math.max(1, Math.round(rise / stepH));
  const run = steps * 0.32;
  const width = 3;
  const holes: Rect[] = [];
  const stairs: [Rect, number][] = [];
  for (const side of pickSides(r, 3)) {
    const at = 12 + Math.floor(r() * 24);
    let hole: Rect;
    switch (side) {
      case 0:
        hole = rect(LOT0 + at, LOT0, LOT0 + at + width, LOT0 + run);
        break;
      case 1:
        hole = rect(LOT0 + at, LOT1 - run, LOT0 + at + width, LOT1);
        break;
      case 2:
        hole = rect(LOT0, LOT0 + at, LOT0 + run, LOT0 + at + width);
        break;
      default:
        hole = rect(LOT1 - run, LOT0 + at, LOT1, LOT0 + at + width);
        break;
    }
    holes.push(hole);
    stairs.push([hole, side]);
  }
  for (const piece of subtractRects(lot, holes)) {
    w.box(piece.x0, 0, piece.z0, piece.x1, lotY, piece.z1, mat, FLOOR, 140);
  }
  // Retaining wall trim (concrete band on the terrace edge).
  for (const [hole, side] of stairs) {
    // Stairs rise inward from the sidewalk.
    const dir = side === 0 ? Ramp.PosZ : side === 1 ? Ramp.NegZ : side === 2 ? Ramp.PosX : Ramp.NegX;
    w.stairs(hole.x0, CURB, hole.z0, hole.x1, lotY, hole.z1, dir, Material.Concrete, rise / steps, 130, true);
    occ.mark(hole, Occ.Reserved);
    keep.push(hole);
    const land = landingFor(hole, side, 2.5);
    occ.mark(land, Occ.Reserved);
    keep.push(land);
  }
  return keep;
}

/** Up to n distinct lot sides (0 = -Z, 1 = +Z, 2 = -X, 3 = +X). */
function pickSides(r: Rand, n: number): number[] {
  const sides = [0, 1, 2, 3];
  for (let i = sides.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [sides[i], sides[j]] = [sides[j], sides[i]];
  }
  return sides.slice(0, n);
}

/** Clear area on the lot beyond the inner end of a ramp/stair. */
function landingFor(rr: Rect, side: number, depth: number): Rect {
  switch (side) {
    case 0:
      return rect(rr.x0 - 0.5, rr.z1, rr.x1 + 0.5, rr.z1 + depth);
    case 1:
      return rect(rr.x0 - 0.5, rr.z0 - depth, rr.x1 + 0.5, rr.z0);
    case 2:
      return rect(rr.x1, rr.z0 - 0.5, rr.x1 + depth, rr.z1 + 0.5);
    default:
      return rect(rr.x0 - depth, rr.z0 - 0.5, rr.x0, rr.z1 + 0.5);
  }
}
