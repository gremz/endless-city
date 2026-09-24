/**
 * Transferable chunk description produced by generation (in a worker or on the main thread).
 * Everything is typed arrays so it can be posted with zero copies.
 */

/** Brush record: x0 y0 z0 x1 y1 z1 (cm, x/z chunk-local, y absolute), packed, tint. */
export const BRUSH_STRIDE = 8;

export const Material = {
  Concrete: 0,
  Plaster: 1,
  Brick: 2,
  Asphalt: 3,
  Sidewalk: 4,
  Crate: 5,
  Metal: 6,
  Dev: 7,
  Wood: 8,
  Paint: 9,
  CarPaint: 10,
  CarGlass: 11,
  CarWheel: 12,
  CarTrim: 13,
  /** Street lamp glass: glows at night. */
  LampGlow: 14,
} as const;
export type MaterialId = (typeof Material)[keyof typeof Material];
export const MATERIAL_COUNT = 15;

/** Packed word layout: bits 0-2 ramp, 3-7 material, 8-15 contents. */
export const packBrushWord = (ramp: number, material: number, contents: number) =>
  (ramp & 7) | ((material & 31) << 3) | ((contents & 255) << 8);
export const wordRamp = (w: number) => w & 7;
export const wordMaterial = (w: number) => (w >>> 3) & 31;
export const wordContents = (w: number) => (w >>> 8) & 255;

export interface MeshData {
  material: number;
  positions: Float32Array;
  normals: Int8Array;
  uvs: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
}

export const District = { Spawn: 0, Industrial: 1, Oldtown: 2, Downtown: 3, Gym: 4 } as const;
export type DistrictId = (typeof District)[keyof typeof District];
export const DISTRICT_NAMES = ['Spawn', 'Industrial', 'Old Town', 'Downtown', 'Gym'] as const;

/** Nav grid: NAV_RES x NAV_RES cells of NAV_CELL meters per chunk. */
export const NAV_CELL = 0.5;
export const NAV_RES = 128;

export const NavFlag = {
  Walkable: 1,
  Reachable: 2,
  NearWall: 4,
  CoverHalf: 8,
  CoverFull: 16,
  Indoor: 32,
  Street: 64,
} as const;

export interface ChunkData {
  cx: number;
  cz: number;
  key: number;
  seed: number;
  brushes: Int32Array;
  meshes: MeshData[];
  district: number;
  level: number;
  /** Floor height per nav cell in cm (NAV_RES²), or empty if not baked. */
  navFloor: Int16Array;
  navFlags: Uint8Array;
  /** 8-direction cover bitmask per cell (bit i = cover towards direction i*45°). */
  navCover: Uint8Array;
  /** Spawn slots / perches / patrol points: x, y, z triples in world meters. */
  spawns: Float32Array;
  perches: Float32Array;
  patrol: Float32Array;
  /** Health pack spots: x, y, z triples in world meters. */
  pickups: Float32Array;
  hasEncounter: boolean;
  genMs: number;
}

export function transferList(d: ChunkData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [
    d.brushes.buffer as ArrayBuffer,
    d.navFloor.buffer as ArrayBuffer,
    d.navFlags.buffer as ArrayBuffer,
    d.navCover.buffer as ArrayBuffer,
    d.spawns.buffer as ArrayBuffer,
    d.perches.buffer as ArrayBuffer,
    d.patrol.buffer as ArrayBuffer,
    d.pickups.buffer as ArrayBuffer,
  ];
  for (const m of d.meshes) {
    out.push(
      m.positions.buffer as ArrayBuffer,
      m.normals.buffer as ArrayBuffer,
      m.uvs.buffer as ArrayBuffer,
      m.colors.buffer as ArrayBuffer,
      m.indices.buffer as ArrayBuffer,
    );
  }
  return out;
}
