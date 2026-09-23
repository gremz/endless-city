import { worldNoise } from '../../core/noise';
import { District, Material, type DistrictId } from './ChunkData';

export interface DistrictParams {
  id: DistrictId;
  /** Largest parcel side before splitting further (m). */
  maxParcel: number;
  minParcel: number;
  alleyChance: number;
  /** Parcel type weights. */
  weights: { building: number; courtyard: number; yard: number; lot: number };
  /** Chance a building is enterable. */
  enterable: number;
  floorsMin: number;
  floorsMax: number;
  setback: number;
  wallMaterial: number;
  altWallMaterial: number;
  groundMaterial: number;
  /** Relative prop weights. */
  props: { crates: number; containers: number; barriers: number; sandbags: number; cars: number; dumpsters: number };
}

const OLDTOWN: Omit<DistrictParams, 'id'> = {
  maxParcel: 16,
  minParcel: 8,
  alleyChance: 0.45,
  weights: { building: 0.55, courtyard: 0.25, yard: 0.05, lot: 0.15 },
  enterable: 0.6,
  floorsMin: 1,
  floorsMax: 3,
  setback: 1,
  wallMaterial: Material.Plaster,
  altWallMaterial: Material.Brick,
  groundMaterial: Material.Sidewalk,
  props: { crates: 4, containers: 0, barriers: 1, sandbags: 2, cars: 1, dumpsters: 1 },
};

const INDUSTRIAL: Omit<DistrictParams, 'id'> = {
  maxParcel: 26,
  minParcel: 10,
  alleyChance: 0.3,
  weights: { building: 0.4, courtyard: 0.05, yard: 0.4, lot: 0.15 },
  enterable: 0.55,
  floorsMin: 1,
  floorsMax: 1,
  setback: 1.5,
  wallMaterial: Material.Metal,
  altWallMaterial: Material.Concrete,
  groundMaterial: Material.Concrete,
  props: { crates: 3, containers: 4, barriers: 2, sandbags: 0.5, cars: 0.5, dumpsters: 1 },
};

const DOWNTOWN: Omit<DistrictParams, 'id'> = {
  maxParcel: 26,
  minParcel: 10,
  alleyChance: 0.35,
  weights: { building: 0.55, courtyard: 0.1, yard: 0.05, lot: 0.3 },
  enterable: 0.35,
  floorsMin: 3,
  floorsMax: 8,
  setback: 1,
  wallMaterial: Material.Concrete,
  altWallMaterial: Material.Brick,
  groundMaterial: Material.Sidewalk,
  props: { crates: 1.5, containers: 0.3, barriers: 3, sandbags: 1, cars: 2, dumpsters: 1 },
};

export function districtFor(seed: number, cx: number, cz: number): DistrictParams {
  if (Math.max(Math.abs(cx), Math.abs(cz)) === 0) return { id: District.Spawn, ...OLDTOWN };
  const n = worldNoise(seed);
  const d = n.districtAt(cx, cz);
  const dens = n.densityAt(cx, cz);
  const base = d < -0.3 ? INDUSTRIAL : d > 0.3 ? DOWNTOWN : OLDTOWN;
  const id = d < -0.3 ? District.Industrial : d > 0.3 ? District.Downtown : District.Oldtown;
  // Density shifts building vs open weights a little.
  const w = { ...base.weights };
  w.building *= 0.75 + dens * 0.5;
  w.lot *= 1.25 - dens * 0.5;
  return { id, ...base, weights: w };
}

/** Difficulty level from distance to spawn. */
export function levelFor(cx: number, cz: number): number {
  return Math.min(10, Math.floor(Math.hypot(cx, cz) / 2));
}
