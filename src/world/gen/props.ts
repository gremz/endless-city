import { HU } from '../../core/config';
import { randRange, weighted, type Rand } from '../../core/rng';
import { Contents, Ramp, SOLID } from '../../physics/brush';
import { Material } from './ChunkData';
import { Occ, rd, rect, rw, type GenContext, type Rect } from './genContext';
import { car } from './streets';

const CRATE = 64 * HU;
const SMALL = 32 * HU;
const CRATE_CONTENTS = SOLID | Contents.PENETRABLE;
/** Walkway kept free around every prop so props never seal off an area. */
const MARGIN = 0.9;

type PropKind = 'crates' | 'containers' | 'barriers' | 'sandbags' | 'cars' | 'dumpsters';

/** Try to reserve a footprint (plus margin) in the occupancy grid. */
function claim(ctx: GenContext, fp: Rect): boolean {
  const withMargin = rect(fp.x0 - MARGIN, fp.z0 - MARGIN, fp.x1 + MARGIN, fp.z1 + MARGIN);
  if (!ctx.occ.free(withMargin)) return false;
  ctx.occ.mark(withMargin, Occ.Reserved);
  ctx.occ.mark(fp, Occ.Prop);
  return true;
}

function crateStack(ctx: GenContext, r: Rand, x: number, z: number): boolean {
  const { w, lotY } = ctx;
  const big = r() < 0.7;
  const s = big ? CRATE : SMALL;
  const wide = r() < 0.35;
  const fp = rect(x, z, x + s * (wide ? 2 : 1), z + s);
  if (!claim(ctx, rect(fp.x0, fp.z0, fp.x1 + (r() < 0.4 ? SMALL : 0), fp.z1))) return false;
  const tint = 90 + Math.floor(r() * 100);
  w.box(x, lotY, z, x + s, lotY + s, z + s, Material.Crate, CRATE_CONTENTS, tint);
  if (wide) w.box(x + s, lotY, z, x + 2 * s, lotY + s, z + s, Material.Crate, CRATE_CONTENTS, tint + 30);
  if (big && r() < 0.45) {
    // Second crate on top (a 2-high stack, full cover and a perch).
    w.box(x, lotY + s, z, x + s, lotY + 2 * s, z + s, Material.Crate, CRATE_CONTENTS, tint + 50);
    ctx.perches.push(x + s / 2, lotY + 2 * s + 0.02, z + s / 2);
  } else if (big && r() < 0.5) {
    // Small step crate beside, so the stack can be climbed.
    w.box(x + s * (wide ? 2 : 1), lotY, z, x + s * (wide ? 2 : 1) + SMALL, lotY + SMALL, z + SMALL, Material.Crate, CRATE_CONTENTS, tint - 20);
  }
  return true;
}

function container(ctx: GenContext, r: Rand, x: number, z: number): boolean {
  const { w, lotY } = ctx;
  const alongX = r() < 0.5;
  const L = 6.06;
  const W = 2.44;
  const H = 2.6;
  const withRamp = r() < 0.3;
  const fp = alongX ? rect(x, z, x + L + (withRamp ? 4.5 : 0), z + W) : rect(x, z, x + W, z + L + (withRamp ? 4.5 : 0));
  if (!claim(ctx, fp)) return false;
  const tint = Math.floor(r() * 6);
  if (alongX) w.box(x, lotY, z, x + L, lotY + H, z + W, Material.Metal, SOLID, tint);
  else w.box(x, lotY, z, x + W, lotY + H, z + L, Material.Metal, SOLID, tint);
  let top = lotY + H;
  if (r() < 0.3) {
    // Stacked container, shifted a little.
    const t2 = Math.floor(r() * 6);
    if (alongX) w.box(x + 0.5, lotY + H, z, x + L - 0.5, lotY + 2 * H, z + W, Material.Metal, SOLID, t2);
    else w.box(x, lotY + H, z + 0.5, x + W, lotY + 2 * H, z + L - 0.5, Material.Metal, SOLID, t2);
    top += H;
  } else if (withRamp) {
    // Ramp onto the roof: a vantage point you can run up.
    if (alongX) w.ramp(x + L, lotY, z, x + L + 4.5, lotY + H, z + W, Ramp.NegX, Material.Metal, SOLID, 4);
    else w.ramp(x, lotY, z + L, x + W, lotY + H, z + L + 4.5, Ramp.NegZ, Material.Metal, SOLID, 4);
  }
  if (alongX) ctx.perches.push(x + L / 2, top + 0.02, z + W / 2);
  else ctx.perches.push(x + W / 2, top + 0.02, z + L / 2);
  return true;
}

function barrier(ctx: GenContext, r: Rand, x: number, z: number): boolean {
  const alongX = r() < 0.5;
  const len = 3 + Math.floor(r() * 2) * 1.5;
  const fp = alongX ? rect(x, z, x + len, z + 0.6) : rect(x, z, x + 0.6, z + len);
  if (!claim(ctx, fp)) return false;
  ctx.w.box(fp.x0, ctx.lotY, fp.z0, fp.x1, ctx.lotY + 0.81, fp.z1, Material.Concrete, SOLID, 200);
  return true;
}

function sandbags(ctx: GenContext, r: Rand, x: number, z: number): boolean {
  const alongX = r() < 0.5;
  const fp = alongX ? rect(x, z, x + 2.4, z + 0.7) : rect(x, z, x + 0.7, z + 2.4);
  if (!claim(ctx, fp)) return false;
  ctx.w.box(fp.x0, ctx.lotY, fp.z0, fp.x1, ctx.lotY + 1.05, fp.z1, Material.Plaster, SOLID, 70);
  return true;
}

function dumpster(ctx: GenContext, r: Rand, x: number, z: number): boolean {
  const alongX = r() < 0.5;
  const fp = alongX ? rect(x, z, x + 1.9, z + 1.2) : rect(x, z, x + 1.2, z + 1.9);
  if (!claim(ctx, fp)) return false;
  ctx.w.box(fp.x0, ctx.lotY, fp.z0, fp.x1, ctx.lotY + 1.3, fp.z1, Material.Metal, SOLID, 2);
  return true;
}

function parkedCar(ctx: GenContext, r: Rand, x: number, z: number): boolean {
  const alongX = r() < 0.5;
  const fp = alongX ? rect(x, z, x + 4.3, z + 1.8) : rect(x, z, x + 1.8, z + 4.3);
  if (!claim(ctx, fp)) return false;
  car(ctx.w, r, alongX, alongX ? z : x, alongX ? x : z, ctx.lotY);
  return true;
}

const BUILDERS: Record<PropKind, (ctx: GenContext, r: Rand, x: number, z: number) => boolean> = {
  crates: crateStack,
  containers: container,
  barriers: barrier,
  sandbags,
  cars: parkedCar,
  dumpsters: dumpster,
};

/** Scatter props over an open area. `density` is props per 100 m². */
export function scatterProps(ctx: GenContext, area: Rect, density: number, allowed?: PropKind[]): void {
  const r = ctx.rp;
  const p = ctx.district.props;
  const kinds: [PropKind, number][] = (
    [
      ['crates', p.crates],
      ['containers', p.containers],
      ['barriers', p.barriers],
      ['sandbags', p.sandbags],
      ['cars', p.cars],
      ['dumpsters', p.dumpsters],
    ] as [PropKind, number][]
  ).filter(([k, wgt]) => wgt > 0 && (!allowed || allowed.includes(k)));
  if (!kinds.length || rw(area) < 2 || rd(area) < 2) return;
  const target = Math.round(((rw(area) * rd(area)) / 100) * density);
  let placed = 0;
  for (let attempt = 0; attempt < target * 6 && placed < target; attempt++) {
    const kind = weighted(r, kinds);
    const x = Math.round(randRange(r, area.x0 + 0.5, area.x1 - 2) * 4) / 4;
    const z = Math.round(randRange(r, area.z0 + 0.5, area.z1 - 2) * 4) / 4;
    if (BUILDERS[kind](ctx, r, x, z)) placed++;
  }
}

/** Low wall segments and planters that give a plaza some cover. */
export function lowWalls(ctx: GenContext, area: Rect, count: number): void {
  const r = ctx.rp;
  for (let i = 0; i < count * 4 && count > 0; i++) {
    const alongX = r() < 0.5;
    const len = 3 + Math.floor(r() * 4);
    const x = Math.round(randRange(r, area.x0 + 1, area.x1 - len - 1));
    const z = Math.round(randRange(r, area.z0 + 1, area.z1 - len - 1));
    const fp = alongX ? rect(x, z, x + len, z + 0.4) : rect(x, z, x + 0.4, z + len);
    if (!claim(ctx, fp)) continue;
    ctx.w.box(fp.x0, ctx.lotY, fp.z0, fp.x1, ctx.lotY + 1.0, fp.z1, Material.Concrete, SOLID, 150);
    count--;
  }
}
