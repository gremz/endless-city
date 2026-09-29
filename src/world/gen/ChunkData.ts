/**
 * Transferable chunk description produced by generation (in a worker or on the main thread).
 * Everything is typed arrays so it can be posted with zero copies.
 */

/** Brush record: x0 y0 z0 x1 y1 z1 (cm, x/z chunk-local, y absolute), packed, tint. */
export const BRUSH_STRIDE = 8;

/** Fountain record: x, z, basin inner half-size, water y, bowl inner half-size, bowl water y, spout top y. */
export const FOUNTAIN_STRIDE = 7;

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
  /** Window panes (drawn by the glass renderer, not baked into chunk meshes). */
  Glass: 15,
  /** Water surfaces (transparent, drifting). */
  Water: 16,
  Grass: 17,
  /** Ashlar stone: plinths, quoins, cornices, sills. */
  Stone: 18,
  /** Flat-roof membrane (a thin visual skin over the roof cap). */
  RoofTar: 19,
  /** Facade atlas (tint = FacadeCell): window panels, shopfronts, signs, awnings, rooftop kit. */
  Facade: 20,
  /** Tower glazing: tiled along the wall, stretched over the brush height. */
  CurtainWall: 21,
} as const;
export type MaterialId = (typeof Material)[keyof typeof Material];
export const MATERIAL_COUNT = 22;

/** Cells of the facade atlas, chosen by the tint of a Material.Facade brush. */
export const FacadeCell = {
  Window: 0,
  WindowBlinds: 1,
  WindowCurtains: 2,
  WindowShutters: 3,
  WindowLitWarm: 4,
  WindowLitCool: 5,
  Shop: 6,
  ShopLit: 7,
  /** Four shop signs (authored for a 5:1 board), 8..11. */
  Sign: 8,
  AwningRed: 12,
  AwningGreen: 13,
  Grille: 14,
  Shutter: 15,
} as const;

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
  /** Piece meshes only: brush index, first index and index count of each piece in `indices`. */
  pieces?: Int32Array;
}

export const Landmark = { None: 0, Apartment: 1, Office: 2, Garage: 3, Park: 4, Plaza: 5, River: 6 } as const;
export const LANDMARK_NAMES = ['', 'Apartments', 'Offices', 'Parking garage', 'Park', 'Plaza', 'River'] as const;

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
  /** Under water (wading: slow, so bots avoid it). */
  Water: 128,
} as const;

export interface ChunkData {
  cx: number;
  cz: number;
  key: number;
  seed: number;
  brushes: Int32Array;
  meshes: MeshData[];
  /** Meshes of pieces that can vanish (breachable plugs), drawn apart from `meshes`. */
  pieceMeshes?: MeshData[];
  district: number;
  /** Landmark building in this chunk (Landmark), 0 for none. */
  landmark: number;
  level: number;
  /**
   * Layered nav (see navBake.ts): first span id per column (NAV_RES² + 1 entries), or empty
   * if not baked. The other nav arrays are per span.
   */
  navCol: Uint16Array;
  /** Floor height per nav span in cm. */
  navFloor: Int16Array;
  navFlags: Uint8Array;
  /** 8-direction cover bitmask per span (bit i = cover towards direction i*45°). */
  navCover: Uint8Array;
  /** Off-grid nav links (ladders), NAV_LINK_STRIDE floats each: see navBake.ts. */
  navLinks: Float32Array;
  /** Spawn slots / perches / patrol points: x, y, z triples in world meters. */
  spawns: Float32Array;
  perches: Float32Array;
  patrol: Float32Array;
  /** Health pack spots: x, y, z triples in world meters. */
  pickups: Float32Array;
  /** Driveable cars, VEHICLE_STRIDE floats each. */
  vehicles: Float32Array;
  /** Doors, DOOR_STRIDE floats each. */
  doors: Float32Array;
  /** Fountains, FOUNTAIN_STRIDE floats each (world meters; see cityFeatures.fountain). */
  fountains?: Float32Array;
  /** Breakable pieces, PIECE_STRIDE ints each (see PieceKind). */
  pieces: Int32Array;
  /** Nav changes when breach pieces open, NAV_PATCH_STRIDE ints each (see generateChunk). */
  navPatch: Int32Array;
  hasEncounter: boolean;
  /** The scripted opening ambush, in view of the spawn drop-in point (see encounters.ts). */
  opening?: boolean;
  genMs: number;
}

/**
 * Driveable car spawn record in ChunkData.vehicles: world x, y (ground), z of the footprint
 * center, heading yaw, paint index, hatchback (0/1).
 */
export const VEHICLE_STRIDE = 6;

/**
 * Door record in ChunkData.doors (world meters): x, y (floor), z of the doorway's center, 1 if
 * the door spans X (else Z), width, height, flags (DoorFlag), and the inward direction (+1 or
 * -1 along the axis the door faces).
 */
export const DOOR_STRIDE = 8;
export const DoorFlag = { Metal: 1, Locked: 2 } as const;

/**
 * Chunk pieces: parts of the city that can be destroyed for good (see sim/Pieces.ts). A piece is
 * one brush, identified by its index in the chunk's brushes, so a save can name it.
 */
export const PieceKind = {
  /** A window pane: shot or blasted out, rendered by the glass renderer. */
  Glass: 0,
  /** A door-sized plug in a wall that a breaching charge (or a point-blank HE) blows out. */
  Breach: 1,
} as const;
export type PieceKindId = (typeof PieceKind)[keyof typeof PieceKind];

/**
 * Piece record in ChunkData.pieces: kind, brush index, and the range of its nav patch records
 * [patchStart, patchEnd) in ChunkData.navPatch (empty when it doesn't change the nav).
 */
export const PIECE_STRIDE = 4;

/**
 * Nav patch record in ChunkData.navPatch: span id, then the span's flags and cover with the piece
 * standing and with it gone.
 */
export const NAV_PATCH_STRIDE = 5;

/** Piece records for window panes (brush indices), with no nav patches. */
export function glassPieces(panes: readonly number[] | Int32Array): Int32Array {
  const out = new Int32Array(panes.length * PIECE_STRIDE);
  for (let k = 0; k < panes.length; k++) out.set([PieceKind.Glass, panes[k], 0, 0], k * PIECE_STRIDE);
  return out;
}

/** Brush indices of the pieces of one kind. */
export function piecesOfKind(d: Pick<ChunkData, 'pieces'>, kind: number): number[] {
  const out: number[] = [];
  for (let o = 0; o < d.pieces.length; o += PIECE_STRIDE) if (d.pieces[o] === kind) out.push(d.pieces[o + 1]);
  return out;
}

export function transferList(d: ChunkData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [
    d.brushes.buffer as ArrayBuffer,
    d.navCol.buffer as ArrayBuffer,
    d.navFloor.buffer as ArrayBuffer,
    d.navFlags.buffer as ArrayBuffer,
    d.navCover.buffer as ArrayBuffer,
    d.navLinks.buffer as ArrayBuffer,
    d.spawns.buffer as ArrayBuffer,
    d.perches.buffer as ArrayBuffer,
    d.patrol.buffer as ArrayBuffer,
    d.pickups.buffer as ArrayBuffer,
    d.vehicles.buffer as ArrayBuffer,
    d.doors.buffer as ArrayBuffer,
    d.pieces.buffer as ArrayBuffer,
    d.navPatch.buffer as ArrayBuffer,
  ];
  for (const m of [...d.meshes, ...(d.pieceMeshes ?? [])]) {
    if (m.pieces) out.push(m.pieces.buffer as ArrayBuffer);
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
