/**
 * Brushes are convex solids (axis-aligned boxes, or wedges that ramp up along one axis).
 * Each brush stores outward planes n·p = d; a point is inside when n·p - d <= 0 for every plane.
 * Boxes keep all 6 axis planes; ramps keep the axis planes plus one slope plane, which is
 * exactly the bevel set needed for exact swept-AABB tests.
 */

export const Contents = {
  /** Blocks player/bot movement. */
  SOLID_PLAYER: 1,
  /** Blocks bullets and line of sight. */
  SOLID_BULLET: 2,
  /** Rendered. */
  VISIBLE: 4,
  /** Thin enough for bullets to penetrate (crates, doors, thin walls). */
  PENETRABLE: 8,
  /** Ground-class surface used by the nav bake (slabs, floors, ramps). */
  FLOOR: 16,
  /**
   * Climbable volume in front of a ladder (not solid). Ladder volumes are thin along the axis
   * that faces away from the wall.
   */
  LADDER: 32,
  /** Water volume (not solid): wading slows you down. */
  WATER: 64,
  /**
   * Breakable glass: blocks movement (it's in MASK_PLAYER) but not sight. Bullets and grenades
   * break it and fly on.
   */
  GLASS: 128,
} as const;

export const SOLID = Contents.SOLID_PLAYER | Contents.SOLID_BULLET | Contents.VISIBLE;
export const MASK_PLAYER = Contents.SOLID_PLAYER | Contents.GLASS;
export const MASK_SHOT = Contents.SOLID_BULLET;
export const MASK_LADDER = Contents.LADDER;
export const MASK_WATER = Contents.WATER;
export const MASK_SHOT_GLASS = Contents.SOLID_BULLET | Contents.GLASS;

/** Dynamic brush owners from here up are doors (below are vehicles). */
export const DOOR_OWNER = 1 << 20;
export const isDoorOwner = (owner: number) => owner >= DOOR_OWNER;

/** Ramp directions: which horizontal direction the slope rises towards. */
export const Ramp = { None: 0, PosX: 1, NegX: 2, PosZ: 3, NegZ: 4 } as const;
export type RampDir = (typeof Ramp)[keyof typeof Ramp];

export interface Brush {
  /** Planes as [nx, ny, nz, d] * numPlanes, world space. */
  planes: Float64Array;
  numPlanes: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  contents: number;
  material: number;
  ramp: RampDir;
  /** Trace dedupe stamp, owned by CollisionWorld. */
  stamp: number;
  chunkKey: number;
  /** 0 for the static city; a vehicle id for the moving boxes of that car. */
  owner: number;
}

export function makeBrush(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  contents: number,
  material = 0,
  ramp: RampDir = Ramp.None,
  chunkKey = 0,
): Brush {
  const hasSlope = ramp !== Ramp.None;
  const planes = new Float64Array((hasSlope ? 7 : 6) * 4);
  let i = 0;
  const push = (nx: number, ny: number, nz: number, d: number) => {
    planes[i++] = nx;
    planes[i++] = ny;
    planes[i++] = nz;
    planes[i++] = d;
  };
  push(1, 0, 0, maxX);
  push(-1, 0, 0, -minX);
  push(0, 1, 0, maxY);
  push(0, -1, 0, -minY);
  push(0, 0, 1, maxZ);
  push(0, 0, -1, -minZ);
  if (hasSlope) {
    // Slope passes through the low edge at minY and the high edge at maxY.
    const h = maxY - minY;
    let nx = 0;
    let nz = 0;
    let run: number;
    let px: number;
    let pz: number;
    switch (ramp) {
      case Ramp.PosX:
        run = maxX - minX;
        nx = -h;
        px = minX;
        pz = minZ;
        break;
      case Ramp.NegX:
        run = maxX - minX;
        nx = h;
        px = maxX;
        pz = minZ;
        break;
      case Ramp.PosZ:
        run = maxZ - minZ;
        nz = -h;
        px = minX;
        pz = minZ;
        break;
      default:
        run = maxZ - minZ;
        nz = h;
        px = minX;
        pz = maxZ;
        break;
    }
    const ny = run;
    const len = Math.hypot(nx, ny, nz);
    nx /= len;
    const nny = ny / len;
    nz /= len;
    push(nx, nny, nz, nx * px + nny * minY + nz * pz);
  }
  return {
    planes,
    numPlanes: hasSlope ? 7 : 6,
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    contents,
    material,
    ramp,
    stamp: 0,
    chunkKey,
    owner: 0,
  };
}

/** Move and resize a box brush (no ramp) in place. */
export function setBox(b: Brush, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
  const p = b.planes;
  p[3] = maxX;
  p[7] = -minX;
  p[11] = maxY;
  p[15] = -minY;
  p[19] = maxZ;
  p[23] = -minZ;
  b.minX = minX;
  b.minY = minY;
  b.minZ = minZ;
  b.maxX = maxX;
  b.maxY = maxY;
  b.maxZ = maxZ;
}

/** Height of the brush's top surface at (x, z) (slope-aware). */
export function brushTopAt(b: Brush, x: number, z: number): number {
  if (b.ramp === Ramp.None) return b.maxY;
  const h = b.maxY - b.minY;
  let t: number;
  switch (b.ramp) {
    case Ramp.PosX:
      t = (x - b.minX) / (b.maxX - b.minX);
      break;
    case Ramp.NegX:
      t = (b.maxX - x) / (b.maxX - b.minX);
      break;
    case Ramp.PosZ:
      t = (z - b.minZ) / (b.maxZ - b.minZ);
      break;
    default:
      t = (b.maxZ - z) / (b.maxZ - b.minZ);
      break;
  }
  return b.minY + h * Math.min(1, Math.max(0, t));
}
