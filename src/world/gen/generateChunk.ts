import { worldNoise } from '../../core/noise';
import { hash3, Salt, sfc32 } from '../../core/rng';
import { chunkKey } from '../chunkMath';
import { BrushWriter } from './BrushWriter';
import { buildBuilding, buildCourtyard } from './buildings';
import { District, type ChunkData } from './ChunkData';
import { districtFor, levelFor } from './district';
import { placeEncounters } from './encounters';
import { Occupancy, rect, rd, rw, type GenContext, type Rect } from './genContext';
import { splitLot, typeParcels } from './lots';
import { bakeMeshes } from './meshBake';
import { bakeNav } from './navBake';
import { lowWalls, scatterProps } from './props';
import { buildLot, buildStreets, CURB, LOT0, LOT1 } from './streets';

/** Lot floor height from district and terrace noise. */
function lotHeight(seed: number, cx: number, cz: number, district: number): number {
  const t = worldNoise(seed).terraceAt(cx, cz);
  switch (district) {
    case District.Oldtown:
      return t > 0.5 ? 2 : t > 0.2 ? 1 : CURB;
    case District.Industrial:
      return t < -0.35 ? -1.5 : CURB;
    case District.Downtown:
      return t > 0.55 ? 1 : CURB;
    default:
      return CURB;
  }
}

/**
 * Generate one city chunk: pure and deterministic in (seed, cx, cz). Runs in a worker or on
 * the main thread; returns transferable typed arrays.
 */
export function generateChunk(seed: number, cx: number, cz: number): ChunkData {
  const t0 = performance.now();
  const district = districtFor(seed, cx, cz);
  const level = levelFor(cx, cz);
  const ctx: GenContext = {
    seed,
    cx,
    cz,
    w: new BrushWriter(1024),
    r: sfc32(hash3(seed, cx, cz, Salt.Layout)),
    rp: sfc32(hash3(seed, cx, cz, Salt.Props)),
    district,
    level,
    lotY: lotHeight(seed, cx, cz, district.id),
    occ: new Occupancy(),
    doors: [],
    open: [],
    interiors: [],
    perches: [],
  };

  buildStreets(ctx);
  const keep = buildLot(ctx);
  const lot = rect(LOT0, LOT0, LOT1, LOT1);

  if (district.id === District.Spawn) {
    buildSpawnPlaza(ctx, lot);
  } else {
    const { parcels, alleys } = splitLot(ctx, lot);
    typeParcels(ctx, parcels, alleys, keep, rw(lot) * rd(lot));
    // Pass 1: structures (so props never land inside a neighbor's walls).
    const propAreas: [Rect, number, Parameters<typeof scatterProps>[3]][] = [];
    for (const p of parcels) {
      switch (p.kind) {
        case 'building':
          if (!buildBuilding(ctx, p)) {
            ctx.open.push(p);
            propAreas.push([p, 1.2, undefined]);
          }
          break;
        case 'courtyard': {
          const inner = buildCourtyard(ctx, p);
          ctx.open.push(inner);
          propAreas.push([inner, 2.2, ['crates', 'sandbags', 'barriers', 'dumpsters']]);
          break;
        }
        case 'yard':
          ctx.open.push(p);
          propAreas.push([p, 2.6, ['containers', 'crates', 'dumpsters', 'barriers']]);
          break;
        case 'lot':
          ctx.open.push(p);
          propAreas.push([p, 1.6, ['crates', 'barriers', 'sandbags', 'cars', 'dumpsters']]);
          break;
      }
    }
    // Pass 2: props.
    for (const [area, density, allowed] of propAreas) {
      if (allowed?.includes('sandbags') && ctx.rp() < 0.5) lowWalls(ctx, area, 1 + Math.floor(ctx.rp() * 2));
      scatterProps(ctx, area, density, allowed);
    }
    for (const a of alleys) scatterProps(ctx, a, 0.8, ['crates', 'dumpsters']);
    for (const i of ctx.interiors) scatterProps(ctx, i, 1.5, ['crates']);
  }

  const brushes = ctx.w.finish();
  const meshes = bakeMeshes(brushes);
  const nav = bakeNav(brushes);
  const enc = placeEncounters(sfc32(hash3(seed, cx, cz, Salt.Encounter)), nav, cx, cz, level, ctx.perches);

  return {
    cx,
    cz,
    key: chunkKey(cx, cz),
    seed,
    brushes,
    meshes,
    district: district.id,
    level,
    navFloor: nav.floor,
    navFlags: nav.flags,
    navCover: nav.cover,
    spawns: enc.spawns,
    perches: enc.perches,
    patrol: enc.patrol,
    hasEncounter: enc.hasEncounter,
    genMs: performance.now() - t0,
  };
}

/** Spawn chunk: an open plaza with a fountain, a couple of small buildings and light cover. */
function buildSpawnPlaza(ctx: GenContext, lot: Rect): void {
  const { w, lotY } = ctx;
  const mx = (lot.x0 + lot.x1) / 2;
  const mz = (lot.z0 + lot.z1) / 2;
  // Fountain.
  w.box(mx - 3, lotY, mz - 3, mx + 3, lotY + 0.6, mz + 3, 0, undefined, 170);
  w.box(mx - 0.6, lotY + 0.6, mz - 0.6, mx + 0.6, lotY + 2.2, mz + 0.6, 0, undefined, 200);
  ctx.occ.mark(rect(mx - 4, mz - 4, mx + 4, mz + 4), 3);
  // Two small houses in opposite corners.
  buildBuilding(ctx, rect(lot.x0, lot.z0, lot.x0 + 14, lot.z0 + 12));
  buildBuilding(ctx, rect(lot.x1 - 14, lot.z1 - 12, lot.x1, lot.z1));
  ctx.open.push(lot);
  lowWalls(ctx, lot, 3);
  scatterProps(ctx, lot, 0.35, ['crates', 'barriers']);
}
