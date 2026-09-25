import { CHUNK } from '../../core/config';
import { worldNoise } from '../../core/noise';
import { hash3, Salt, sfc32, type Rand } from '../../core/rng';
import { chunkKey } from '../chunkMath';
import { BrushWriter } from './BrushWriter';
import { buildBuilding, buildCourtyard } from './buildings';
import { buildRooftops } from './facades';
import { dressBuildings } from './buildingDetail';
import { buildHighway, buildPark, buildPlaza, buildRiver, rampSite } from './cityFeatures';
import { chunkPlan } from './cityPlan';
import { buildLandmark, LANDMARK_IDS, LANDMARK_SIZE, pickLandmark, type LandmarkKind } from './landmarks';
import { District, DOOR_STRIDE, Landmark, VEHICLE_STRIDE, type ChunkData } from './ChunkData';
import { districtFor, levelFor } from './district';
import { placeEncounters } from './encounters';
import { Occ, Occupancy, rect, rd, rw, subtractRects, type GenContext, type Rect, type VehicleSpot } from './genContext';
import { splitLot, typeParcels, type Parcel } from './lots';
import { bakeMeshes } from './meshBake';
import { bakeNav } from './navBake';
import { placePickups } from './pickups';
import { lowWalls, scatterProps } from './props';
import { buildLot, buildStreets, carBrushes, carYaw, CAR_L, CAR_W, CURB, LOT0, LOT1 } from './streets';

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
export function generateChunk(seed: number, cx: number, cz: number, opts: { dress?: boolean } = {}): ChunkData {
  const t0 = performance.now();
  const district = districtFor(seed, cx, cz);
  const plan = chunkPlan(seed, cx, cz);
  const level = levelFor(cx, cz);
  const ctx: GenContext = {
    seed,
    cx,
    cz,
    w: new BrushWriter(1024),
    r: sfc32(hash3(seed, cx, cz, Salt.Layout)),
    rp: sfc32(hash3(seed, cx, cz, Salt.Props)),
    rb: sfc32(hash3(seed, cx, cz, Salt.Breakables)),
    district,
    level,
    // Rivers, parks and plazas sit at street level.
    lotY: plan.river || plan.feature ? CURB : lotHeight(seed, cx, cz, district.id),
    occ: new Occupancy(),
    doors: [],
    open: [],
    interiors: [],
    perches: [],
    vehicles: [],
    buildings: [],
    ladders: [],
    doorLeaves: [],
    glass: [],
    trims: [],
  };

  const lot = rect(LOT0, LOT0, LOT1, LOT1);
  const cr = sfc32(hash3(seed, cx, cz, Salt.City));

  let kind: LandmarkKind | null = null;
  let placed: { site: Rect; front: 0 | 1 } | null = null;
  if (plan.river) {
    buildRiver(ctx, plan, cr);
  } else if (district.id === District.Spawn) {
    buildStreets(ctx);
    buildLot(ctx);
    buildSpawnPlaza(ctx, lot);
  } else if (plan.feature) {
    buildStreets(ctx);
    if (plan.feature === 'park') buildPark(ctx, lot, cr);
    else buildPlaza(ctx, lot, cr);
    buildRooftops(ctx, sfc32(hash3(seed, cx, cz, Salt.Facades)));
    if (plan.feature === 'plaza') scatterProps(ctx, lot, 0.35, ['barriers', 'sandbags']);
  } else {
    buildStreets(ctx);
    const keep = buildLot(ctx);
    // A highway on-ramp, then a landmark building, get their sites before the lot is split.
    const ramp = rampSite(plan);
    if (ramp) {
      keep.push(ramp);
      ctx.occ.mark(ramp, Occ.Reserved);
    }
    const lr = sfc32(hash3(seed, cx, cz, Salt.Landmark));
    kind = ramp ? null : pickLandmark(district.id, lr());
    placed = kind ? placeLandmark(lr, kind, lot, keep) : null;
    const regions = subtractRects(lot, [...(placed ? [placed.site] : []), ...(ramp ? [ramp] : [])]);
    const parcels: Parcel[] = [];
    const alleys: Rect[] = [];
    for (const reg of regions) {
      const split = splitLot(ctx, reg);
      parcels.push(...split.parcels);
      alleys.push(...split.alleys);
    }
    typeParcels(ctx, parcels, alleys, keep, regions.reduce((a, q) => a + rw(q) * rd(q), 0));
    if (kind && placed) buildLandmark(ctx, kind, placed.site, placed.front, lr);
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
    // Fire escapes, ladders and rooftop bridges, now that every structure is in place.
    buildRooftops(ctx, sfc32(hash3(seed, cx, cz, Salt.Facades)));
    // Pass 2: props.
    for (const [area, density, allowed] of propAreas) {
      if (allowed?.includes('sandbags') && ctx.rp() < 0.5) lowWalls(ctx, area, 1 + Math.floor(ctx.rp() * 2));
      scatterProps(ctx, area, density, allowed);
    }
    for (const a of alleys) scatterProps(ctx, a, 0.8, ['crates', 'dumpsters']);
    for (const i of ctx.interiors) scatterProps(ctx, i, 1.5, ['crates']);
  }
  if (plan.highwayWest || plan.highwayEast) buildHighway(ctx, plan, cr);

  // Facade dressing and roof clutter last, so it can fit around everything else.
  if (!plan.river && opts.dress !== false) dressBuildings(ctx, sfc32(hash3(seed, cx, cz, Salt.Detail)));
  const brushes = ctx.w.finish();
  const meshes = bakeMeshes(brushes);
  // Bots path around the parked driveable cars as if they were part of the city.
  const navWriter = new BrushWriter(64);
  for (const v of ctx.vehicles) carBrushes(navWriter, v.style, v.alongX, v.lane, v.at, v.y);
  const nav = bakeNav(ctx.vehicles.length ? concatBrushes(brushes, navWriter.finish()) : brushes, ctx.ladders);
  const enc = placeEncounters(sfc32(hash3(seed, cx, cz, Salt.Encounter)), nav, cx, cz, level, ctx.perches);
  const pickups = placePickups(sfc32(hash3(seed, cx, cz, Salt.Pickups)), nav, cx, cz, enc.hasEncounter, district.id === District.Spawn);

  return {
    cx,
    cz,
    key: chunkKey(cx, cz),
    seed,
    brushes,
    meshes,
    district: district.id,
    landmark: placed && kind ? LANDMARK_IDS[kind] : plan.river ? Landmark.River : plan.feature === 'park' ? Landmark.Park : plan.feature === 'plaza' ? Landmark.Plaza : Landmark.None,
    level,
    navCol: nav.col,
    navFloor: nav.floor,
    navFlags: nav.flags,
    navCover: nav.cover,
    navLinks: nav.links,
    spawns: enc.spawns,
    perches: enc.perches,
    patrol: enc.patrol,
    pickups,
    vehicles: vehicleSpawns(ctx.vehicles, cx, cz),
    doors: doorRecords(ctx.doorLeaves, cx, cz),
    glass: new Int32Array(ctx.glass),
    hasEncounter: enc.hasEncounter,
    genMs: performance.now() - t0,
  };
}

/**
 * A site for a landmark along one of the lot's street edges (its long side facing the street),
 * clear of the lot's stairs and ramps. `front` is which of its long sides faces the street.
 */
function placeLandmark(r: Rand, kind: LandmarkKind, lot: Rect, keep: Rect[]): { site: Rect; front: 0 | 1 } | null {
  const [len, dep] = LANDMARK_SIZE[kind];
  const A = len + 2;
  const B = dep + 2;
  const edges = [0, 1, 2, 3];
  for (let i = edges.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [edges[i], edges[j]] = [edges[j], edges[i]];
  }
  for (const e of edges) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const at = e < 2 ? Math.round((lot.x0 + r() * (rw(lot) - A)) * 2) / 2 : Math.round((lot.z0 + r() * (rd(lot) - A)) * 2) / 2;
      const site =
        e === 0
          ? rect(at, lot.z0, at + A, lot.z0 + B)
          : e === 1
            ? rect(at, lot.z1 - B, at + A, lot.z1)
            : e === 2
              ? rect(lot.x0, at, lot.x0 + B, at + A)
              : rect(lot.x1 - B, at, lot.x1, at + A);
      if (keep.some((k) => k.x0 < site.x1 && site.x0 < k.x1 && k.z0 < site.z1 && site.z0 < k.z1)) continue;
      return { site, front: e === 0 || e === 2 ? 0 : 1 };
    }
  }
  return null;
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
  buildRooftops(ctx, sfc32(hash3(ctx.seed, ctx.cx, ctx.cz, Salt.Facades)));
  ctx.open.push(lot);
  lowWalls(ctx, lot, 3);
  scatterProps(ctx, lot, 0.35, ['crates', 'barriers']);
}

function concatBrushes(a: Int32Array, b: Int32Array): Int32Array {
  const out = new Int32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Door leaves as ChunkData.doors records (world coordinates). */
function doorRecords(leaves: readonly number[], cx: number, cz: number): Float32Array {
  const out = new Float32Array(leaves);
  for (let o = 0; o < out.length; o += DOOR_STRIDE) {
    out[o] += cx * CHUNK;
    out[o + 2] += cz * CHUNK;
  }
  return out;
}

/** Driveable car spots as ChunkData.vehicles records (world coordinates). */
export function vehicleSpawns(spots: readonly VehicleSpot[], cx: number, cz: number): Float32Array {
  const out = new Float32Array(spots.length * VEHICLE_STRIDE);
  spots.forEach((v, i) => {
    // Footprint center: `at` runs along the length, `lane` is the near side.
    const along = v.at + CAR_L / 2;
    const across = v.lane + CAR_W / 2;
    const x = v.alongX ? along : across;
    const z = v.alongX ? across : along;
    out.set([cx * CHUNK + x, v.y, cz * CHUNK + z, carYaw(v.alongX, v.style.flip), v.style.paint, v.style.hatch ? 1 : 0], i * VEHICLE_STRIDE);
  });
  return out;
}
