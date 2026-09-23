import { CHUNK } from '../../core/config';
import { hash3, Salt, sfc32, type Rand } from '../../core/rng';
import { Contents, Ramp, SOLID } from '../../physics/brush';
import { BrushWriter } from './BrushWriter';
import { Material } from './ChunkData';
import { Occ, rect, subtractRects, type GenContext, type Rect } from './genContext';

/** Road half-width inside this chunk and sidewalk width. The lot is the inner region. */
export const ROAD = 4;
export const WALK = 2;
export const LOT0 = ROAD + WALK;
export const LOT1 = CHUNK - LOT0;
export const CURB = 0.15;

const FLOOR = SOLID | Contents.FLOOR;
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
  // Street lamps on the sidewalk corners.
  for (const [x, z] of [
    [LOT0 - 1, LOT0 - 1],
    [LOT1 + 1, LOT0 - 1],
    [LOT0 - 1, LOT1 + 1],
    [LOT1 + 1, LOT1 + 1],
    [C / 2, LOT0 - 1],
    [C / 2, LOT1 + 1],
  ]) {
    w.box(x - 0.09, CURB, z - 0.09, x + 0.09, 5, z + 0.09, Material.Metal, SOLID, 4);
    w.box(x - 0.25, 5, z - 0.25, x + 0.25, 5.15, z + 0.25, Material.Metal, SOLID, 4);
  }

  buildEdges(ctx);
}

/**
 * Edge features on the roads between chunks. The shared edge hash picks the feature so both
 * neighbors agree; each chunk builds only the half on its own side.
 */
function buildEdges(ctx: GenContext): void {
  const { seed, cx, cz, w } = ctx;
  const C = CHUNK;
  // [hash, alongX (road runs along X), stripStart, stripEnd, sideSign]
  const edges: [number, boolean, number, number][] = [
    [hash3(seed, cx + 1, cz, Salt.EdgeX), false, C - ROAD, C], // +X edge: road runs along Z
    [hash3(seed, cx, cz, Salt.EdgeX), false, 0, ROAD], // -X edge
    [hash3(seed, cx, cz + 1, Salt.EdgeZ), true, C - ROAD, C], // +Z edge: road runs along X
    [hash3(seed, cx, cz, Salt.EdgeZ), true, 0, ROAD], // -Z edge
  ];
  for (const [h, alongX, s0, s1] of edges) {
    const roll = h % 100;
    const r = sfc32(h ^ 0x9e37);
    // Shared position along the road, away from intersections.
    const along = 14 + (Math.floor(r() * 1000) % 34);
    const near = (s0 + s1) / 2 < C / 2;
    if (roll < 58) continue;
    if (roll < 75) {
      // Road block of jersey barriers across the road with a gap on one side.
      const gapInMyHalf = ((h >>> 8) & 1) === (near ? 1 : 0);
      barrierLine(w, alongX, s0, s1, along, gapInMyHalf);
    } else if (roll < 90) {
      // Parked cars along my half of the road.
      const n = 2 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const t = 10 + i * 12 + Math.floor(r() * 5);
        if (t > C - 12) break;
        car(w, r, alongX, near ? s0 + 0.4 : s1 - 2.2, t);
      }
    } else {
      // A container left in the road on my half.
      const lane = near ? s0 + 0.6 : s1 - 3.0;
      if (alongX) w.box(along, 0, lane, along + 6.06, 2.6, lane + 2.44, Material.Metal, SOLID, Math.floor(r() * 6));
      else w.box(lane, 0, along, lane + 2.44, 2.6, along + 6.06, Material.Metal, SOLID, Math.floor(r() * 6));
    }
  }
}

function barrierLine(w: BrushWriter, alongX: boolean, s0: number, s1: number, at: number, gap: boolean): void {
  // Barriers are 0.6 thick, 0.81 tall; perpendicular to the road across my half.
  const h = 0.81;
  const a0 = s0 + (gap ? 0 : 0);
  const a1 = gap ? s1 - 2.2 : s1;
  if (a1 - a0 < 0.5) return;
  if (alongX) w.box(at, 0, a0, at + 0.6, h, a1, Material.Concrete, SOLID, 210);
  else w.box(a0, 0, at, a1, h, at + 0.6, Material.Concrete, SOLID, 210);
}

/** A parked car: body plus cabin, ~1.5 m tall (half cover). `lane` is the car's near side. */
export function car(w: BrushWriter, r: Rand, alongX: boolean, lane: number, at: number, y = 0): void {
  const tint = Math.floor(r() * 6);
  if (alongX) {
    w.box(at, y + 0.3, lane, at + 4.3, y + 1.05, lane + 1.8, Material.Metal, SOLID, tint);
    w.box(at + 1.1, y + 1.05, lane + 0.15, at + 3.3, y + 1.5, lane + 1.65, Material.Metal, SOLID, tint);
    w.box(at + 0.4, y, lane + 0.1, at + 3.9, y + 0.3, lane + 1.7, Material.Metal, SOLID, 4);
  } else {
    w.box(lane, y + 0.3, at, lane + 1.8, y + 1.05, at + 4.3, Material.Metal, SOLID, tint);
    w.box(lane + 0.15, y + 1.05, at + 1.1, lane + 1.65, y + 1.5, at + 3.3, Material.Metal, SOLID, tint);
    w.box(lane + 0.1, y, at + 0.4, lane + 1.7, y + 0.3, at + 3.9, Material.Metal, SOLID, 4);
  }
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
