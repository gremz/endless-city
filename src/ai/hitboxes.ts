import { MOVE } from '../player/movementConfig';
import { eyeHeight, type MoveState } from '../player/pmove';

export const HitGroup = { Head: 0, Chest: 1, Stomach: 2, Legs: 3 } as const;
export type HitGroupId = (typeof HitGroup)[keyof typeof HitGroup];
export const HITGROUP_NAMES = ['head', 'chest', 'stomach', 'legs'] as const;
export const HITGROUP_MULT = [4, 1, 1.25, 0.75] as const;

/** Actor-local hitbox (yaw-aligned AABB): center y and half extents. */
export interface HitBox {
  group: HitGroupId;
  cy: number;
  hx: number;
  hy: number;
  hz: number;
}

/**
 * Standing hitboxes in meters. Heights scale with eye height so crouching compresses the body;
 * the bot renderer builds its model from the same numbers so what you see is what you hit.
 */
export const STAND_BOXES: readonly HitBox[] = [
  { group: HitGroup.Head, cy: 1.66, hx: 0.12, hy: 0.13, hz: 0.12 },
  { group: HitGroup.Chest, cy: 1.275, hx: 0.23, hy: 0.225, hz: 0.14 },
  { group: HitGroup.Stomach, cy: 0.925, hx: 0.19, hy: 0.125, hz: 0.13 },
  { group: HitGroup.Legs, cy: 0.4, hx: 0.2, hy: 0.4, hz: 0.14 },
];

/** Height scale for the current crouch amount (1 standing, ~0.72 crouched). */
export function bodyScale(m: MoveState): number {
  return eyeHeight(m) / MOVE.standEye;
}

/** Slab test of a ray (origin o, dir d, both actor-local) against a box. Returns entry t or -1. */
function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cy: number,
  hx: number,
  hy: number,
  hz: number,
  tMax: number,
): number {
  let t0 = 0;
  let t1 = tMax;
  // X
  if (Math.abs(dx) < 1e-9) {
    if (ox < -hx || ox > hx) return -1;
  } else {
    let a = (-hx - ox) / dx;
    let b = (hx - ox) / dx;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  // Y
  const ry = oy - cy;
  if (Math.abs(dy) < 1e-9) {
    if (ry < -hy || ry > hy) return -1;
  } else {
    let a = (-hy - ry) / dy;
    let b = (hy - ry) / dy;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  // Z
  if (Math.abs(dz) < 1e-9) {
    if (oz < -hz || oz > hz) return -1;
  } else {
    let a = (-hz - oz) / dz;
    let b = (hz - oz) / dz;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  return t0;
}

export interface HitboxHit {
  t: number;
  group: HitGroupId;
}

/**
 * Test a world-space ray (unit direction) against an actor's hitboxes at (px, py, pz) with the
 * given yaw. Returns the nearest hit within tMax, or null.
 */
export function rayActor(
  sx: number,
  sy: number,
  sz: number,
  dx: number,
  dy: number,
  dz: number,
  tMax: number,
  px: number,
  py: number,
  pz: number,
  yaw: number,
  scale: number,
  out: HitboxHit,
): boolean {
  // Cheap rejection: distance from the ray to the actor's vertical axis.
  const rx = px - sx;
  const rz = pz - sz;
  const along = rx * dx + rz * dz;
  const h2 = dx * dx + dz * dz;
  if (h2 > 1e-9) {
    const tClosest = along / h2;
    const cx = sx + dx * tClosest - px;
    const cz = sz + dz * tClosest - pz;
    if (cx * cx + cz * cz > 0.6 * 0.6 && Math.abs(dy) < 0.95) return false;
  }
  // Into actor-local space (rotate by -yaw around Y).
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const lx = sx - px;
  const ly = sy - py;
  const lz = sz - pz;
  const ox = c * lx - s * lz;
  const oz = s * lx + c * lz;
  const ldx = c * dx - s * dz;
  const ldz = s * dx + c * dz;
  let best = Infinity;
  let group: HitGroupId = HitGroup.Chest;
  for (const b of STAND_BOXES) {
    const cy = b.cy * scale;
    const hy = b.hy * scale;
    const t = rayBox(ox, ly, oz, ldx, dy, ldz, cy, b.hx, hy, b.hz, tMax);
    if (t >= 0 && t < best) {
      best = t;
      group = b.group;
    }
  }
  if (best === Infinity) return false;
  out.t = best;
  out.group = group;
  return true;
}
