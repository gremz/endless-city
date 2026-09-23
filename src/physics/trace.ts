import { HU } from '../core/config';
import type { Vec3 } from '../core/math';
import type { Brush } from './brush';

/** Distance kept between a hull and the surface it hits (Source DIST_EPSILON). */
export const DIST_EPSILON = HU / 32;

export interface TraceResult {
  /** 0..1 along start→end at which the hull first touches solid. 1 = no hit. */
  fraction: number;
  endX: number;
  endY: number;
  endZ: number;
  normal: Vec3;
  /** Plane distance of the hit plane. */
  planeD: number;
  /** Trace started inside a solid. */
  startSolid: boolean;
  /** Trace never left solid. */
  allSolid: boolean;
  brush: Brush | null;
}

export function makeTrace(): TraceResult {
  return {
    fraction: 1,
    endX: 0,
    endY: 0,
    endZ: 0,
    normal: { x: 0, y: 0, z: 0 },
    planeD: 0,
    startSolid: false,
    allSolid: false,
    brush: null,
  };
}

export function resetTrace(tr: TraceResult): void {
  tr.fraction = 1;
  tr.normal.x = tr.normal.y = tr.normal.z = 0;
  tr.planeD = 0;
  tr.startSolid = false;
  tr.allSolid = false;
  tr.brush = null;
}

/**
 * Sweep an AABB hull (mins/maxs relative to the origin) from start to end against one convex
 * brush, updating tr if this brush is hit earlier. Port of Quake 3 CM_TraceThroughBrush:
 * each plane is pushed out by the hull's support offset (Minkowski sum).
 * With mins = maxs = 0 it is a ray test; with start = end it is an overlap test.
 */
export function traceBrush(
  tr: TraceResult,
  b: Brush,
  sx: number,
  sy: number,
  sz: number,
  ex: number,
  ey: number,
  ez: number,
  mins: Vec3,
  maxs: Vec3,
): void {
  let enterFrac = -1;
  let leaveFrac = 1;
  let hitPlane = -1;
  let startOut = false;
  let endOut = false;
  const p = b.planes;
  for (let i = 0, n = b.numPlanes * 4; i < n; i += 4) {
    const nx = p[i];
    const ny = p[i + 1];
    const nz = p[i + 2];
    // Offset the plane by the hull corner furthest behind it.
    const ox = nx < 0 ? maxs.x : mins.x;
    const oy = ny < 0 ? maxs.y : mins.y;
    const oz = nz < 0 ? maxs.z : mins.z;
    const dist = p[i + 3] - (nx * ox + ny * oy + nz * oz);
    const d1 = nx * sx + ny * sy + nz * sz - dist;
    const d2 = nx * ex + ny * ey + nz * ez - dist;
    if (d2 > 0) endOut = true;
    if (d1 > 0) startOut = true;
    // Completely in front of this plane: no intersection with the brush.
    if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return;
    // Completely behind this plane: keep checking other planes.
    if (d1 <= 0 && d2 <= 0) continue;
    if (d1 > d2) {
      // Entering the brush.
      let f = (d1 - DIST_EPSILON) / (d1 - d2);
      if (f < 0) f = 0;
      if (f > enterFrac) {
        enterFrac = f;
        hitPlane = i;
      }
    } else {
      // Leaving the brush.
      let f = (d1 + DIST_EPSILON) / (d1 - d2);
      if (f > 1) f = 1;
      if (f < leaveFrac) leaveFrac = f;
    }
  }

  if (!startOut) {
    tr.startSolid = true;
    if (!endOut) {
      tr.allSolid = true;
      tr.fraction = 0;
      tr.brush = b;
    }
    return;
  }

  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tr.fraction && hitPlane >= 0) {
    tr.fraction = enterFrac < 0 ? 0 : enterFrac;
    tr.normal.x = p[hitPlane];
    tr.normal.y = p[hitPlane + 1];
    tr.normal.z = p[hitPlane + 2];
    tr.planeD = p[hitPlane + 3];
    tr.brush = b;
  }
}

/** Fill in the end position from the fraction. */
export function finishTrace(
  tr: TraceResult,
  sx: number,
  sy: number,
  sz: number,
  ex: number,
  ey: number,
  ez: number,
): void {
  if (tr.allSolid) {
    tr.endX = sx;
    tr.endY = sy;
    tr.endZ = sz;
    return;
  }
  const f = tr.fraction;
  tr.endX = sx + (ex - sx) * f;
  tr.endY = sy + (ey - sy) * f;
  tr.endZ = sz + (ez - sz) * f;
}

/**
 * Exit distance of a ray through a single brush (for bullet penetration).
 * Returns the fraction at which the ray leaves the brush, or -1 if it does not intersect.
 */
export function rayExitFraction(
  b: Brush,
  sx: number,
  sy: number,
  sz: number,
  ex: number,
  ey: number,
  ez: number,
): number {
  let enter = -Infinity;
  let leave = Infinity;
  const p = b.planes;
  for (let i = 0, n = b.numPlanes * 4; i < n; i += 4) {
    const nx = p[i];
    const ny = p[i + 1];
    const nz = p[i + 2];
    const d1 = nx * sx + ny * sy + nz * sz - p[i + 3];
    const d2 = nx * ex + ny * ey + nz * ez - p[i + 3];
    if (d1 > 0 && d2 > 0) return -1;
    if (d1 <= 0 && d2 <= 0) continue;
    const f = d1 / (d1 - d2);
    if (d1 > d2) {
      if (f > enter) enter = f;
    } else if (f < leave) {
      leave = f;
    }
  }
  if (enter > leave) return -1;
  return leave === Infinity ? 1 : leave;
}
