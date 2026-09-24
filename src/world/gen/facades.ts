import type { Rand } from '../../core/rng';
import { Contents, Ramp, SOLID } from '../../physics/brush';
import { Material } from './ChunkData';
import { Occ, rect, type BuildingInfo, type GenContext, type Rect } from './genContext';
import { LOT0, LOT1 } from './streets';

/**
 * Rooftop pass, run once every structure in the chunk is placed: fire escapes and ladders up
 * the outside of buildings, plank bridges between neighboring roofs, and walkable roofs (with
 * overwatch perches) for every roof that ended up with a way up.
 */

const FLOOR_H = 3.5;
/**
 * Fire escape: landing strip depth against the wall, flight strip depth outside it (both wide
 * enough for a bot to pass the rails), the entry bay each flight starts from (where the drop
 * ladder hangs), the run of one flight, and the platform each flight arrives on.
 */
const LANDING_D = 1.5;
const FLIGHT_D = 1.6;
const ENTRY = 1.6;
const FLIGHT_RUN = 4.2;
const ARRIVAL = 0.9;
const ESCAPE_LEN = ENTRY + FLIGHT_RUN + ARRIVAL;
const MAX_BRIDGE_GAP = 4;
const GRATE = SOLID | Contents.FLOOR;

/** One wall of a building: outward side, plane coordinate and extent along the wall. */
interface Wall {
  side: number;
  alongX: boolean;
  /** +1 if outward is towards +X/+Z. */
  out: number;
  face: number;
  a0: number;
  a1: number;
}

function walls(fp: Rect): Wall[] {
  return [
    { side: 0, alongX: true, out: -1, face: fp.z0, a0: fp.x0, a1: fp.x1 },
    { side: 1, alongX: true, out: 1, face: fp.z1, a0: fp.x0, a1: fp.x1 },
    { side: 2, alongX: false, out: -1, face: fp.x0, a0: fp.z0, a1: fp.z1 },
    { side: 3, alongX: false, out: 1, face: fp.x1, a0: fp.z0, a1: fp.z1 },
  ];
}

/** Rect in front of a wall: `d0..d1` meters out from the face, `a0..a1` along it. */
function front(w: Wall, d0: number, d1: number, a0: number, a1: number): Rect {
  const c0 = w.face + w.out * d0;
  const c1 = w.face + w.out * d1;
  return w.alongX
    ? rect(a0, Math.min(c0, c1), a1, Math.max(c0, c1))
    : rect(Math.min(c0, c1), a0, Math.max(c0, c1), a1);
}

/** World point (local x, z) at distance d out from the wall, position a along it. */
function pointAt(w: Wall, d: number, a: number): [number, number] {
  const c = w.face + w.out * d;
  return w.alongX ? [a, c] : [c, a];
}

const inLot = (r: Rect) => r.x0 >= LOT0 && r.z0 >= LOT0 && r.x1 <= LOT1 && r.z1 <= LOT1;
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

function noSolid(ctx: GenContext, r: Rect): boolean {
  const c = 0.5;
  const n = 128;
  for (let z = Math.max(0, Math.floor(r.z0 / c)); z <= Math.min(n - 1, Math.ceil(r.z1 / c) - 1); z++) {
    for (let x = Math.max(0, Math.floor(r.x0 / c)); x <= Math.min(n - 1, Math.ceil(r.x1 / c) - 1); x++) {
      if (ctx.occ.cells[z * n + x] === Occ.Solid) return false;
    }
  }
  return true;
}

function shuffled<T>(r: Rand, a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** Record a ladder nav link: `d` meters out at the bottom, `inward` meters in at the top. */
function ladderLink(ctx: GenContext, w: Wall, a: number, y0: number, y1: number, face: number, out: number, inward: number): void {
  const ww = { ...w, face };
  const [bx, bz] = pointAt(ww, out, a);
  const [tx, tz] = pointAt(ww, -inward, a);
  ctx.ladders.push(bx, y0, bz, tx, y1, tz, w.alongX ? 0 : w.out, w.alongX ? w.out : 0);
}

/**
 * Fire escape on a wall: a landing strip against the wall at every floor, flights of open
 * stairs in the outer strip climbing from each landing to the next, a roof-level landing (a
 * short step onto the parapet cap), and a ladder from the ground to the first landing.
 */
function fireEscape(ctx: GenContext, r: Rand, b: BuildingInfo, aerial: Rect[]): boolean {
  const { w, lotY } = ctx;
  const depth = LANDING_D + FLIGHT_D;
  for (const wall of shuffled(r, walls(b.fp))) {
    if (wall.a1 - wall.a0 < ESCAPE_LEN + 0.6) continue;
    const a0 = wall.a0 + 0.3 + Math.round(r() * (wall.a1 - wall.a0 - ESCAPE_LEN - 0.6) * 2) / 2;
    const a1 = a0 + ESCAPE_LEN;
    const over = front(wall, 0, depth + 0.5, a0, a1);
    const foot = front(wall, depth, depth + 1.6, a0 - 0.1, a0 + ENTRY + 0.1);
    if (!inLot(over) || !inLot(foot) || !noSolid(ctx, over) || !ctx.occ.free(foot)) continue;
    if (aerial.some((q) => overlaps(q, over))) continue;

    // Landing heights: one per floor, the last one just under the roof cap.
    const ys: number[] = [];
    for (let f = 1; f < b.floors; f++) ys.push(lotY + f * FLOOR_H);
    ys.push(b.roofY - 0.3);
    const dir = wall.alongX ? Ramp.PosX : Ramp.PosZ;
    const put = (d0: number, d1: number, p0: number, p1: number, yb: number, yt: number, contents: number, tint = 5) => {
      const q = front(wall, d0, d1, p0, p1);
      w.box(q.x0, yb, q.z0, q.x1, yt, q.z1, Material.Metal, contents, tint);
    };
    const fl0 = a0 + ENTRY;
    const fl1 = fl0 + FLIGHT_RUN;
    ys.forEach((y, i) => {
      put(0, LANDING_D, a0, a1, y - 0.12, y, GRATE);
      // Full-depth platforms: the entry bay each flight leaves from, and where the flight
      // from below arrives.
      put(LANDING_D, depth, a0, fl0, y - 0.12, y, GRATE);
      if (i > 0) put(LANDING_D, depth, fl1, a1, y - 0.12, y, GRATE);
      // Rails (player clip plus a visible bar) around the open edges. Level one's entry bay is
      // where the drop ladder comes up.
      const rail = (d0: number, d1: number, p0: number, p1: number) => {
        put(d0, d1, p0, p1, y, y + 1, Contents.SOLID_PLAYER);
        put(d0, d1, p0, p1, y + 0.95, y + 1, Contents.VISIBLE);
      };
      rail(0, depth, a1 - 0.05, a1);
      rail(0, depth, a0, a0 + 0.05);
      if (i > 0) {
        rail(depth - 0.05, depth, fl1, a1);
        rail(depth - 0.05, depth, a0, fl0);
      }
      if (i + 1 < ys.length) {
        const q = front(wall, LANDING_D, depth, fl0, fl1);
        w.openStairs(q.x0, y, q.z0, q.x1, ys[i + 1], q.z1, dir, Material.Metal, 5);
        // Outer rail along the flight: an invisible panel, posts and a top bar.
        put(depth - 0.05, depth, fl0, fl1, y, ys[i + 1] + 1, Contents.SOLID_PLAYER);
        for (let p = fl0; p <= fl1 + 0.01; p += FLIGHT_RUN / 3) {
          const t = (p - fl0) / FLIGHT_RUN;
          const top = y + (ys[i + 1] - y) * t + 1;
          put(depth - 0.05, depth, p - 0.03, p + 0.03, y + (ys[i + 1] - y) * t - 0.1, top, Contents.VISIBLE);
        }
      }
    });
    // The drop ladder hangs from level one's entry bay.
    const la = a0 + 0.9;
    const edge = wall.face + wall.out * depth;
    w.ladder(wall.side, edge, la, lotY, ys[0]);
    ladderLink(ctx, wall, la, lotY, ys[0], edge, 1.1, 0.7);
    ctx.occ.mark(foot, Occ.Reserved);
    aerial.push(over);
    return true;
  }
  return false;
}

/** A plain wall ladder from the ground to the roof, on a side without a door. */
function wallLadder(ctx: GenContext, r: Rand, b: BuildingInfo, aerial: Rect[]): boolean {
  for (const wall of shuffled(r, walls(b.fp))) {
    if (b.doorSides.includes(wall.side) || wall.a1 - wall.a0 < 3) continue;
    const a = wall.a0 + 1 + Math.round(r() * (wall.a1 - wall.a0 - 2) * 2) / 2;
    const foot = front(wall, 0, 1.6, a - 0.7, a + 0.7);
    if (!inLot(foot) || !ctx.occ.free(foot) || aerial.some((q) => overlaps(q, foot))) continue;
    ctx.w.ladder(wall.side, wall.face, a, ctx.lotY, b.roofY);
    ladderLink(ctx, wall, a, ctx.lotY, b.roofY, wall.face, 1.1, 1.1);
    ctx.occ.mark(foot, Occ.Reserved);
    aerial.push(front(wall, 0, 0.5, a - 0.5, a + 0.5));
    return true;
  }
  return false;
}

/**
 * Plank (or sloped) bridges across the gaps between neighboring roofs. Returns the pairs of
 * buildings each bridge joins.
 */
function bridges(ctx: GenContext, r: Rand, aerial: Rect[]): [number, number][] {
  const out: [number, number][] = [];
  const bs = ctx.buildings;
  for (let i = 0; i < bs.length && out.length < 3; i++) {
    for (let j = i + 1; j < bs.length && out.length < 3; j++) {
      for (const alongX of [true, false]) {
        // alongX: the roofs sit side by side in X and the bridge spans X.
        const A = bs[i].cap;
        const B = bs[j].cap;
        const aFirst = alongX ? A.x1 <= B.x0 : A.z1 <= B.z0;
        const near = aFirst ? A : B;
        const far = aFirst ? B : A;
        const gap = alongX ? far.x0 - near.x1 : far.z0 - near.z1;
        if (gap < 0.3 || gap > MAX_BRIDGE_GAP) continue;
        const o0 = alongX ? Math.max(A.z0, B.z0) : Math.max(A.x0, B.x0);
        const o1 = alongX ? Math.min(A.z1, B.z1) : Math.min(A.x1, B.x1);
        if (o1 - o0 < 2.5) continue;
        // Height change from the near roof to the far one, at most a gentle slope.
        const dy = bs[aFirst ? j : i].roofY - bs[aFirst ? i : j].roofY;
        if (Math.abs(dy) > Math.min(1.2, gap * 0.8) || r() < 0.3) continue;
        const c = o0 + 1.2 + r() * (o1 - o0 - 2.4);
        const span = alongX ? rect(near.x1 - 0.05, c - 0.6, far.x0 + 0.05, c + 0.6) : rect(c - 0.6, near.z1 - 0.05, c + 0.6, far.z0 + 0.05);
        if (aerial.some((q) => overlaps(q, span))) continue;
        if (bs.some((b, k) => k !== i && k !== j && overlaps(b.cap, span))) continue;
        const flat = Math.abs(dy) < 0.02;
        const y0 = Math.min(bs[i].roofY, bs[j].roofY);
        const y1 = Math.max(bs[i].roofY, bs[j].roofY);
        const ramp = flat ? Ramp.None : alongX ? (dy > 0 ? Ramp.PosX : Ramp.NegX) : dy > 0 ? Ramp.PosZ : Ramp.NegZ;
        ctx.w.box(span.x0, flat ? y0 - 0.15 : y0, span.z0, span.x1, y1, span.z1, Material.Wood, GRATE, 120, ramp);
        aerial.push(span);
        out.push([i, j]);
      }
    }
  }
  return out;
}

export function buildRooftops(ctx: GenContext, r: Rand): void {
  const bs = ctx.buildings;
  if (!bs.length) return;
  const aerial: Rect[] = [];
  const links = bridges(ctx, r, aerial);
  const access = bs.map((b) => {
    if (b.kind === 'landmark') return true;
    const want = b.kind === 'block' ? 0.9 : b.kind === 'warehouse' ? 0.7 : 0.55;
    if (r() >= want) return false;
    if (b.kind === 'block' && b.floors >= 2 && fireEscape(ctx, r, b, aerial)) return true;
    return wallLadder(ctx, r, b, aerial);
  });
  // Bridges share access between roofs.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [i, j] of links) {
      if (access[i] !== access[j]) {
        access[i] = access[j] = true;
        changed = true;
      }
    }
  }
  bs.forEach((b, i) => {
    if (!access[i]) return;
    ctx.w.addContents(b.capBrush, Contents.FLOOR);
    // Overwatch spots near two edges of the roof.
    const y = b.roofY + 0.02;
    const cx = (b.fp.x0 + b.fp.x1) / 2;
    const cz = (b.fp.z0 + b.fp.z1) / 2;
    ctx.perches.push(cx, y, r() < 0.5 ? b.fp.z0 + 1 : b.fp.z1 - 1);
    ctx.perches.push(r() < 0.5 ? b.fp.x0 + 1 : b.fp.x1 - 1, y, cz);
  });
}
