import { CHUNK } from '../../core/config';
import { randInt, type Rand } from '../../core/rng';
import { Contents, Ramp, SOLID, type RampDir } from '../../physics/brush';
import { chunkPlan, isRiver, type ChunkPlan } from './cityPlan';
import { Material } from './ChunkData';
import { Occ, rect, subtractRects, type GenContext, type Rect } from './genContext';
import { buildEdges, car, CURB, LAMPS, LAMP_Y, LOT0, LOT1, ROAD } from './streets';

/**
 * City-scale features built into chunks: the river (a channel of wadeable water with bridges
 * carrying the cross streets), elevated highway decks with on-ramps, parks and plazas.
 */

const C = CHUNK;
const FLOOR = SOLID | Contents.FLOOR;
const PAINT = Contents.VISIBLE;
/** River: bed and water surface heights (about waist-deep). */
export const RIVER_BED = -3.4;
export const RIVER_WATER = -2.2;
/** Elevated highway deck top, and its thickness. */
export const HIGHWAY_Y = 9;
const DECK_T = 0.6;
/** Depth of a river bridge's deck below the road surface. */
const DECK_UNDER = 0.7;

const rw = (r: Rect) => r.x1 - r.x0;
const rd = (r: Rect) => r.z1 - r.z0;

/**
 * Strip along a chunk side: `d0..d1` meters in from the edge, `a0..a1` along it.
 * Sides: 0 = -Z, 1 = +Z, 2 = -X, 3 = +X.
 */
function band(side: number, d0: number, d1: number, a0: number, a1: number): Rect {
  switch (side) {
    case 0:
      return rect(a0, d0, a1, d1);
    case 1:
      return rect(a0, C - d1, a1, C - d0);
    case 2:
      return rect(d0, a0, d1, a1);
    default:
      return rect(C - d1, a0, C - d0, a1);
  }
}

/** The two sides perpendicular to `side`, low end first. */
const perp = (side: number): [number, number] => (side < 2 ? [2, 3] : [0, 1]);

function boxR(ctx: GenContext, r: Rect, y0: number, y1: number, mat: number, contents: number = SOLID, tint = 128, ramp: RampDir = Ramp.None): void {
  ctx.w.box(r.x0, y0, r.z0, r.x1, y1, r.z1, mat, contents, tint, ramp);
}

// ------------------------------------------------------------------------------- river

/** Where the water is in a river chunk: the lot, arms through connected sides, and corners. */
export function riverChannel(plan: ChunkPlan): Rect[] {
  const out: Rect[] = [rect(LOT0, LOT0, LOT1, LOT1)];
  for (let s = 0; s < 4; s++) if (plan.riverSides[s]) out.push(band(s, 0, LOT0, LOT0, LOT1));
  // Corners, where both sides and the diagonal neighbor are river: [-x-z, +x-z, -x+z, +x+z].
  const corners: [number, number, Rect][] = [
    [2, 0, rect(0, 0, LOT0, LOT0)],
    [3, 0, rect(LOT1, 0, C, LOT0)],
    [2, 1, rect(0, LOT1, LOT0, C)],
    [3, 1, rect(LOT1, LOT1, C, C)],
  ];
  corners.forEach(([sx, sz, r], i) => {
    if (plan.riverSides[sx] && plan.riverSides[sz] && plan.riverCorners[i]) out.push(r);
  });
  return out;
}

/**
 * A river chunk, in place of the usual streets and lot: embankment streets on the sides away
 * from the river (sidewalks drop straight into the channel behind a railing), bridge decks for
 * the roads that cross it, the channel bed and water, and stairs down to the water.
 */
export function buildRiver(ctx: GenContext, plan: ChunkPlan, r: Rand): void {
  const { w } = ctx;
  const conn = plan.riverSides;
  const bridges = plan.bridges;
  const wallBottom = RIVER_BED - 0.8;
  const stairsAt: [number, number][] = [];
  const landSides = [0, 1, 2, 3].filter((s) => !conn[s]);
  for (const s of landSides.slice(0, 2)) stairsAt.push([s, 14 + Math.floor(r() * 30)]);

  for (let s = 0; s < 4; s++) {
    const [p0, p1] = perp(s);
    if (!conn[s]) {
      // Embankment street: road, then a sidewalk that is also the channel wall.
      boxR(ctx, band(s, 0, ROAD, 0, C), -1, 0, Material.Asphalt, FLOOR, 128);
      // The sidewalk runs out over the channel ends, but stops at a bridge deck (it only
      // closes off the channel underneath it, so the road runs flat onto the bridge).
      const a0 = conn[p0] && !bridges[p0] ? 0 : ROAD;
      const a1 = conn[p1] && !bridges[p1] ? C : C - ROAD;
      boxR(ctx, band(s, ROAD, LOT0, a0, a1), wallBottom, CURB, Material.Sidewalk, FLOOR, 150);
      if (bridges[p0]) boxR(ctx, band(s, ROAD, LOT0, 0, ROAD), wallBottom, -DECK_UNDER, Material.Sidewalk, SOLID, 150);
      if (bridges[p1]) boxR(ctx, band(s, ROAD, LOT0, C - ROAD, C), wallBottom, -DECK_UNDER, Material.Sidewalk, SOLID, 150);
      for (let a = 8; a < C - 8; a += 3) boxR(ctx, band(s, 0, 0.07, a, a + 1.5), 0, 0.01, Material.Paint, PAINT, 200);
      // Railing along the water, open where the stairs come up, ending at a bridge deck.
      const e0 = conn[p0] ? (bridges[p0] ? ROAD : 0) : LOT0;
      const e1 = conn[p1] ? (bridges[p1] ? C - ROAD : C) : LOT1;
      const gaps = stairsAt.filter(([ss]) => ss === s).map(([, at]) => [at - 0.1, at + 2.3]);
      let cur = e0;
      for (const g of [...gaps, [e1, e1]]) {
        if (g[0] > cur) boxR(ctx, band(s, LOT0 - 0.08, LOT0, cur, g[0]), CURB, CURB + 1, Material.Metal, SOLID, 4);
        cur = g[1];
      }
    } else if (plan.bridges[s]) {
      // Bridge: this chunk's half of the cross street's deck, a parapet, and piers.
      // The parapet stops where it would cross another bridge's deck at a corner.
      const e0 = conn[p0] ? (bridges[p0] ? ROAD - 0.3 : 0) : LOT0;
      const e1 = conn[p1] ? (bridges[p1] ? C - ROAD + 0.3 : C) : LOT1;
      boxR(ctx, band(s, 0, ROAD, 0, C), -DECK_UNDER, 0, Material.Asphalt, FLOOR, 120);
      for (let a = 8; a < C - 8; a += 3) boxR(ctx, band(s, 0, 0.07, a, a + 1.5), 0, 0.01, Material.Paint, PAINT, 200);
      boxR(ctx, band(s, ROAD - 0.3, ROAD, e0, e1), 0, 1, Material.Concrete, SOLID, 170);
      for (const a of [16, 32, 48]) boxR(ctx, band(s, 0, 1.2, a - 0.8, a + 0.8), wallBottom, -DECK_UNDER, Material.Concrete, SOLID, 150);
    }
  }
  // Corner islands where two river sides meet but the diagonal is land.
  const corners: [number, number, Rect][] = [
    [2, 0, rect(0, 0, LOT0, LOT0)],
    [3, 0, rect(LOT1, 0, C, LOT0)],
    [2, 1, rect(0, LOT1, LOT0, C)],
    [3, 1, rect(LOT1, LOT1, C, C)],
  ];
  corners.forEach(([sx, sz, rr], i) => {
    if (!conn[sx] || !conn[sz] || plan.riverCorners[i]) return;
    // Under a bridge deck the island stops below it, so the road stays flat.
    const decks = [sx, sz].filter((s) => bridges[s]).map((s) => band(s, 0, ROAD, 0, C));
    if (decks.length) boxR(ctx, rr, wallBottom, -DECK_UNDER, Material.Sidewalk, SOLID, 150);
    for (const piece of subtractRects(rr, decks)) boxR(ctx, piece, decks.length ? -DECK_UNDER : wallBottom, CURB, Material.Sidewalk, FLOOR, 150);
  });

  // Channel: bed and water.
  const channel = riverChannel(plan);
  for (const c of channel) {
    boxR(ctx, c, RIVER_BED - 0.5, RIVER_BED, Material.Concrete, FLOOR, 70);
    boxR(ctx, c, RIVER_BED, RIVER_WATER, Material.Water, Contents.WATER | Contents.VISIBLE, 128);
  }
  // Stairs from the water up to the embankment sidewalk.
  const rise = CURB - RIVER_BED;
  const run = Math.round(rise / 0.25) * 0.3;
  for (const [s, at] of stairsAt) {
    const st = band(s, LOT0, LOT0 + run, at, at + 2.2);
    const dir = s === 0 ? Ramp.NegZ : s === 1 ? Ramp.PosZ : s === 2 ? Ramp.NegX : Ramp.PosX;
    w.stairs(st.x0, RIVER_BED, st.z0, st.x1, CURB, st.z1, dir, Material.Concrete, rise / Math.round(rise / 0.25), 140, true);
  }
  // Street lamps where there's land under them.
  const inWater = (x: number, z: number) => channel.some((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1);
  for (const [x, z] of LAMPS) {
    if (inWater(x, z)) continue;
    w.box(x - 0.09, CURB, z - 0.09, x + 0.09, LAMP_Y, z + 0.09, Material.Metal, SOLID, 4);
    w.box(x - 0.25, LAMP_Y, z - 0.25, x + 0.25, LAMP_Y + 0.15, z + 0.25, Material.Metal, SOLID, 4);
    w.box(x - 0.2, LAMP_Y - 0.04, z - 0.2, x + 0.2, LAMP_Y, z + 0.2, Material.LampGlow, Contents.VISIBLE, 0);
  }
  ctx.occ.mark(rect(0, 0, C, C), Occ.Reserved);
  // Road features only on the embankment streets (the edge hash keeps neighbors in step).
  buildEdges(ctx, [!conn[0], !conn[1], !conn[2], !conn[3]]);
}

/** Whether street lamp `i` (of LAMPS) stands in chunk (cx, cz): not where the river runs. */
export function lampStands(seed: number, cx: number, cz: number, i: number): boolean {
  if (!isRiver(seed, cx, cz)) return true;
  const [x, z] = LAMPS[i];
  return !riverChannel(chunkPlan(seed, cx, cz)).some((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1);
}

// ----------------------------------------------------------------------------- highway

/** Lot area an on-ramp takes (kept clear of buildings), or null. */
export function rampSite(plan: ChunkPlan): Rect | null {
  if (plan.onRamp === 3) return rect(LOT1 - 5, LOT0, LOT1, LOT1);
  if (plan.onRamp === 2) return rect(LOT0, LOT0, LOT0 + 5, LOT1);
  return null;
}

/**
 * Elevated highway along this chunk's -X and/or +X seam: this chunk's half of the deck (one
 * lane), a barrier on the inner edge, half pillars on the seam, and sometimes an on-ramp up from
 * the lot along that edge.
 */
export function buildHighway(ctx: GenContext, plan: ChunkPlan, r: Rand): void {
  const groundY = plan.river ? RIVER_BED - 0.5 : 0;
  for (const side of [2, 3] as const) {
    if (side === 2 ? !plan.highwayWest : !plan.highwayEast) continue;
    const ramp = plan.onRamp === side;
    const deck = band(side, 0, ROAD, 0, C);
    boxR(ctx, deck, HIGHWAY_Y - DECK_T, HIGHWAY_Y, Material.Concrete, FLOOR, 160);
    // Lane paint: the seam line (each half paints its side) and an edge line.
    for (let a = 4; a < C - 4; a += 4) boxR(ctx, band(side, 0, 0.08, a, a + 2), HIGHWAY_Y, HIGHWAY_Y + 0.01, Material.Paint, PAINT, 200);
    boxR(ctx, band(side, ROAD - 0.6, ROAD - 0.5, 0, C), HIGHWAY_Y, HIGHWAY_Y + 0.01, Material.Paint, PAINT, 200);
    // Barrier on the inner edge, open where the on-ramp joins.
    const joins = ramp ? [LOT1 - 8, LOT1 - 0.5] : null;
    const barrier = (a0: number, a1: number) => boxR(ctx, band(side, ROAD - 0.4, ROAD, a0, a1), HIGHWAY_Y, HIGHWAY_Y + 0.9, Material.Concrete, SOLID, 190);
    if (joins) {
      barrier(0, joins[0]);
      barrier(joins[1], C);
    } else barrier(0, C);
    // Half pillars on the seam (the neighbor builds the other half).
    for (const a of [8, 24, 40, 56]) boxR(ctx, band(side, 0, 0.45, a - 0.45, a + 0.45), groundY, HIGHWAY_Y - DECK_T, Material.Concrete, SOLID, 140);
    // Abandoned cars on the deck.
    if (r() < 0.35) {
      const at = 6 + Math.floor(r() * 50);
      const lane = side === 2 ? 0.8 : C - ROAD + 1.2;
      car(ctx.w, r, false, lane, at, HIGHWAY_Y);
    }
    if (ramp) onRamp(ctx, side);
  }
}

/** On-ramp: a long slope up the lot edge, then a platform over the sidewalk onto the deck. */
function onRamp(ctx: GenContext, side: 2 | 3): void {
  const { w, lotY } = ctx;
  const x0 = side === 3 ? LOT1 - 4.5 : LOT0 + 0.5;
  const x1 = x0 + 4;
  const top = LOT1 - 8;
  w.slopedSlab(x0, lotY, LOT0 + 1, x1, HIGHWAY_Y, top, Ramp.PosZ, Material.Concrete, 150, 3);
  // Platform across the sidewalk and road to the deck.
  const px0 = side === 3 ? x0 : ROAD;
  const px1 = side === 3 ? C - ROAD : x1;
  w.box(px0, HIGHWAY_Y - DECK_T, top, px1, HIGHWAY_Y, LOT1 - 0.5, Material.Concrete, FLOOR, 160);
  // Outer barrier on the platform, and a pillar under it.
  w.box(px0, HIGHWAY_Y, LOT1 - 0.9, px1, HIGHWAY_Y + 0.9, LOT1 - 0.5, Material.Concrete, SOLID, 190);
  w.box((x0 + x1) / 2 - 0.4, lotY, top + 3, (x0 + x1) / 2 + 0.4, HIGHWAY_Y - DECK_T, top + 3.8, Material.Concrete, SOLID, 140);
  // Curbs along the ramp so cars and people keep to it.
  w.box(x0 - 0.25, lotY, LOT0 + 1, x0, lotY + 0.3, top, Material.Concrete, SOLID, 170);
  w.box(x1, lotY, LOT0 + 1, x1 + 0.25, lotY + 0.3, top, Material.Concrete, SOLID, 170);
  ctx.occ.mark(rect(x0 - 1, LOT0, x1 + 1, LOT1), Occ.Reserved);
  // A sniper spot at the top.
  ctx.perches.push((x0 + x1) / 2, HIGHWAY_Y + 0.02, top + 3);
}

// ------------------------------------------------------------------------ parks, plazas

function tree(ctx: GenContext, x: number, z: number, r: Rand): void {
  const { w, lotY } = ctx;
  const h = 2.6 + r() * 0.8;
  w.box(x - 0.22, lotY, z - 0.22, x + 0.22, lotY + h + 0.4, z + 0.22, Material.Wood, SOLID, 60);
  // Foliage stops shots and sight but not people (it's overhead anyway).
  const leaves = Contents.SOLID_BULLET | Contents.VISIBLE;
  const s = 1.5 + r() * 0.5;
  w.box(x - s, lotY + h, z - s, x + s, lotY + h + 2.2, z + s, Material.Grass, leaves, 60 + Math.floor(r() * 40));
  w.box(x - s * 0.6, lotY + h + 2.2, z - s * 0.6, x + s * 0.6, lotY + h + 3.2, z + s * 0.6, Material.Grass, leaves, 70);
}

/** Try to claim a free rect in the lot (with a margin); marks it on success. */
function claim(ctx: GenContext, r: Rect, margin: number, as: number = Occ.Prop): boolean {
  if (!ctx.occ.free(rect(r.x0 - margin, r.z0 - margin, r.x1 + margin, r.z1 + margin))) return false;
  ctx.occ.mark(r, as);
  return true;
}

/**
 * Park: grass with crossing paths, trees (their crowns block sight), hedges to hide behind, a
 * fountain basin, benches, and a bandstand with a ladder up to its roof.
 */
export function buildPark(ctx: GenContext, lot: Rect, r: Rand): void {
  const { w, lotY } = ctx;
  w.box(lot.x0, 0, lot.z0, lot.x1, lotY, lot.z1, Material.Grass, FLOOR, 128);
  // Paths (paving laid on the grass).
  const pz = lot.z0 + 10 + r() * (rd(lot) - 20);
  const px = lot.x0 + 10 + r() * (rw(lot) - 20);
  const paths = [rect(lot.x0, pz - 1.5, lot.x1, pz + 1.5), rect(px - 1.5, lot.z0, px + 1.5, lot.z1)];
  for (const p of paths) {
    w.box(p.x0, lotY, p.z0, p.x1, lotY + 0.02, p.z1, Material.Sidewalk, PAINT, 180);
    ctx.occ.mark(p, Occ.Reserved);
  }
  // Bandstand in one quadrant, fountain basin in another.
  const quads = [
    rect(lot.x0 + 2, lot.z0 + 2, px - 3, pz - 3),
    rect(px + 3, lot.z0 + 2, lot.x1 - 2, pz - 3),
    rect(lot.x0 + 2, pz + 3, px - 3, lot.z1 - 2),
    rect(px + 3, pz + 3, lot.x1 - 2, lot.z1 - 2),
  ].sort((a, b) => rw(b) * rd(b) - rw(a) * rd(a));
  const bq = quads[0];
  if (rw(bq) >= 10 && rd(bq) >= 10) bandstand(ctx, (bq.x0 + bq.x1) / 2, (bq.z0 + bq.z1) / 2);
  const fq = quads[1];
  if (rw(fq) >= 9 && rd(fq) >= 9) {
    const cx = (fq.x0 + fq.x1) / 2;
    const cz = (fq.z0 + fq.z1) / 2;
    basin(ctx, rect(cx - 3.5, cz - 3.5, cx + 3.5, cz + 3.5));
  }
  // Trees and hedges wherever there's room.
  for (let i = 0; i < 40; i++) {
    const x = lot.x0 + 2 + r() * (rw(lot) - 4);
    const z = lot.z0 + 2 + r() * (rd(lot) - 4);
    if (claim(ctx, rect(x - 0.4, z - 0.4, x + 0.4, z + 0.4), 3)) tree(ctx, x, z, r);
  }
  for (let i = 0; i < 12; i++) {
    const along = r() < 0.5;
    const len = 3.5 + r() * 3;
    const x = lot.x0 + 2 + r() * (rw(lot) - 4 - len);
    const z = lot.z0 + 2 + r() * (rd(lot) - 4 - len);
    const hr = along ? rect(x, z, x + len, z + 0.8) : rect(x, z, x + 0.8, z + len);
    if (claim(ctx, hr, 1.2)) w.box(hr.x0, lotY, hr.z0, hr.x1, lotY + 1.1, hr.z1, Material.Grass, SOLID | Contents.PENETRABLE, 50);
  }
  // Benches beside the paths.
  for (const p of paths) {
    const alongX = rw(p) > rd(p);
    for (let i = 0; i < 3; i++) {
      const a = (alongX ? p.x0 : p.z0) + 6 + r() * ((alongX ? rw(p) : rd(p)) - 12);
      const b = r() < 0.5 ? -1 : 1;
      const br = alongX ? rect(a, b < 0 ? p.z0 - 0.9 : p.z1 + 0.4, a + 1.6, b < 0 ? p.z0 - 0.4 : p.z1 + 0.9) : rect(b < 0 ? p.x0 - 0.9 : p.x1 + 0.4, a, b < 0 ? p.x0 - 0.4 : p.x1 + 0.9, a + 1.6);
      if (ctx.occ.free(br)) {
        ctx.occ.mark(br, Occ.Prop);
        w.box(br.x0, lotY, br.z0, br.x1, lotY + 0.45, br.z1, Material.Wood, SOLID, 110);
      }
    }
  }
}

/** Raised stone basin of shallow water with a spout in the middle. */
function basin(ctx: GenContext, b: Rect): void {
  const { w, lotY } = ctx;
  if (!claim(ctx, b, 0.5, Occ.Solid)) return;
  const t = 0.5;
  const h = lotY + 0.4;
  w.box(b.x0, lotY, b.z0, b.x1, h, b.z0 + t, Material.Concrete, SOLID, 190);
  w.box(b.x0, lotY, b.z1 - t, b.x1, h, b.z1, Material.Concrete, SOLID, 190);
  w.box(b.x0, lotY, b.z0 + t, b.x0 + t, h, b.z1 - t, Material.Concrete, SOLID, 190);
  w.box(b.x1 - t, lotY, b.z0 + t, b.x1, h, b.z1 - t, Material.Concrete, SOLID, 190);
  w.box(b.x0 + t, lotY, b.z0 + t, b.x1 - t, h - 0.05, b.z1 - t, Material.Water, Contents.WATER | Contents.VISIBLE, 128);
  const mx = (b.x0 + b.x1) / 2;
  const mz = (b.z0 + b.z1) / 2;
  w.box(mx - 0.4, lotY, mz - 0.4, mx + 0.4, lotY + 1.8, mz + 0.4, Material.Concrete, SOLID, 200);
}

/** Bandstand: a raised platform with steps, four posts and a roof you can climb onto. */
function bandstand(ctx: GenContext, cx: number, cz: number): void {
  const { w, lotY } = ctx;
  const s = 3.5;
  const b = rect(cx - s, cz - s, cx + s, cz + s);
  if (!claim(ctx, rect(b.x0, b.z0 - 3, b.x1, b.z1 + 1.5), 0.5, Occ.Solid)) return;
  const top = lotY + 0.7;
  w.box(b.x0, lotY, b.z0, b.x1, top, b.z1, Material.Wood, FLOOR, 130);
  // Steps up on the -Z side.
  w.stairs(cx - 1.2, lotY, b.z0 - 1.2, cx + 1.2, top, b.z0, Ramp.PosZ, Material.Wood, 0.25, 110);
  for (const [x, z] of [
    [b.x0, b.z0],
    [b.x1 - 0.3, b.z0],
    [b.x0, b.z1 - 0.3],
    [b.x1 - 0.3, b.z1 - 0.3],
  ]) {
    w.box(x, top, z, x + 0.3, top + 3, z + 0.3, Material.Wood, SOLID, 90);
  }
  const roof = top + 3.3;
  w.box(b.x0, top + 3, b.z0, b.x1, roof, b.z1, Material.Wood, FLOOR, 70);
  // Ladder up the +Z side to the roof.
  w.ladder(1, b.z1, cx, lotY, roof);
  ctx.ladders.push(cx, lotY, b.z1 + 1.1, cx, roof, b.z1 - 1.1, 0, 1);
  ctx.perches.push(cx, roof + 0.02, cz);
}

/**
 * Plaza: paving, a monument or big fountain in the middle, raised planters for cover, a couple
 * of kiosks and a colonnade along one side.
 */
export function buildPlaza(ctx: GenContext, lot: Rect, r: Rand): void {
  const { w, lotY } = ctx;
  w.box(lot.x0, 0, lot.z0, lot.x1, lotY, lot.z1, Material.Sidewalk, FLOOR, 175);
  const mx = (lot.x0 + lot.x1) / 2;
  const mz = (lot.z0 + lot.z1) / 2;
  // Paving pattern: a border square around the middle.
  for (const [a, b, c, d] of [
    [mx - 12, mz - 12, mx + 12, mz - 11.5],
    [mx - 12, mz + 11.5, mx + 12, mz + 12],
    [mx - 12, mz - 11.5, mx - 11.5, mz + 11.5],
    [mx + 11.5, mz - 11.5, mx + 12, mz + 11.5],
  ]) {
    w.box(a, lotY, b, c, lotY + 0.02, d, Material.Concrete, PAINT, 120);
  }
  if (r() < 0.5) {
    // Monument: a plinth you can climb, a column and a figure on top.
    ctx.occ.mark(rect(mx - 4, mz - 4, mx + 4, mz + 4), Occ.Solid);
    w.box(mx - 2.5, lotY, mz - 2.5, mx + 2.5, lotY + 1.1, mz + 2.5, Material.Concrete, FLOOR, 200);
    w.box(mx - 0.7, lotY + 1.1, mz - 0.7, mx + 0.7, lotY + 7, mz + 0.7, Material.Concrete, SOLID, 210);
    w.box(mx - 0.5, lotY + 7, mz - 0.9, mx + 0.5, lotY + 8.8, mz + 0.9, Material.Metal, SOLID, 3);
  } else basin(ctx, rect(mx - 4.5, mz - 4.5, mx + 4.5, mz + 4.5));
  // Colonnade along one side.
  const side = randInt(r, 0, 3);
  for (let a = 3; a < LOT1 - LOT0 - 2; a += 3.2) {
    const along = LOT0 + a;
    const inner = 3;
    const cr =
      side === 0
        ? rect(along, lot.z0 + inner, along + 0.6, lot.z0 + inner + 0.6)
        : side === 1
          ? rect(along, lot.z1 - inner - 0.6, along + 0.6, lot.z1 - inner)
          : side === 2
            ? rect(lot.x0 + inner, along, lot.x0 + inner + 0.6, along + 0.6)
            : rect(lot.x1 - inner - 0.6, along, lot.x1 - inner, along + 0.6);
    w.box(cr.x0, lotY, cr.z0, cr.x1, lotY + 4, cr.z1, Material.Concrete, SOLID, 215);
  }
  const roofR =
    side === 0 ? rect(lot.x0, lot.z0, lot.x1, lot.z0 + 3.8) : side === 1 ? rect(lot.x0, lot.z1 - 3.8, lot.x1, lot.z1) : side === 2 ? rect(lot.x0, lot.z0, lot.x0 + 3.8, lot.z1) : rect(lot.x1 - 3.8, lot.z0, lot.x1, lot.z1);
  w.box(roofR.x0, lotY + 4, roofR.z0, roofR.x1, lotY + 4.4, roofR.z1, Material.Concrete, SOLID, 190);
  ctx.occ.mark(roofR, Occ.Reserved);
  // Planters and kiosks.
  for (let i = 0; i < 24; i++) {
    const along = r() < 0.5;
    const x = lot.x0 + 5 + r() * (rw(lot) - 13);
    const z = lot.z0 + 5 + r() * (rd(lot) - 13);
    const pr = along ? rect(x, z, x + 3, z + 1.2) : rect(x, z, x + 1.2, z + 3);
    if (!claim(ctx, pr, 2.5)) continue;
    w.box(pr.x0, lotY, pr.z0, pr.x1, lotY + 0.9, pr.z1, Material.Concrete, SOLID, 185);
    w.box(pr.x0 + 0.1, lotY + 0.9, pr.z0 + 0.1, pr.x1 - 0.1, lotY + 0.93, pr.z1 - 0.1, Material.Grass, PAINT, 110);
  }
  for (let i = 0, made = 0; i < 12 && made < 2; i++) {
    const x = lot.x0 + 6 + r() * (rw(lot) - 14);
    const z = lot.z0 + 6 + r() * (rd(lot) - 14);
    if (!claim(ctx, rect(x, z, x + 2.4, z + 2.4), 1.5)) continue;
    w.box(x, lotY, z, x + 2.4, lotY + 2.4, z + 2.4, Material.Paint, SOLID, 60 + made * 100);
    w.box(x - 0.3, lotY + 2.4, z - 0.3, x + 2.7, lotY + 2.6, z + 2.7, Material.Metal, SOLID, 2);
    made++;
  }
}
