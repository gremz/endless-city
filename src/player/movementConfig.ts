import { HU } from '../core/config';
import type { Vec3 } from '../core/math';

/** CS:GO movement constants, converted to meters. */
export const MOVE = {
  gravity: 800 * HU,
  accelerate: 5.5,
  airAccelerate: 12,
  friction: 5.2,
  stopSpeed: 80 * HU,
  airWishCap: 30 * HU,
  jumpSpeed: 301.993 * HU,
  stepSize: 18 * HU,
  maxVelocity: 3500 * HU,
  walkMul: 0.52,
  duckMul: 0.34,
  /** Minimum ground normal Y for a surface to be standable. */
  minWalkNormal: 0.7,
  /** Upward speed above which the player is never considered grounded. */
  nonJumpVelocity: 140 * HU,
  /** Seconds to fully crouch/uncrouch on the ground. */
  duckTime: 0.2,
  /** Feet tuck when crouching in the air (gives CS:GO's ~66 HU crouch-jump). */
  airDuckLift: 9 * HU,
  standHeight: 72 * HU,
  duckHeight: 54 * HU,
  halfWidth: 16 * HU,
  standEye: 64 * HU,
  duckEye: 46 * HU,
  /** Speed multiplier right after taking damage, recovering over tagRecovery seconds. */
  tagMul: 0.5,
  tagRecovery: 0.5,
  /** Default max speed (knife). */
  defaultMaxSpeed: 250 * HU,
  /** Climbing speed on ladders. */
  ladderSpeed: 200 * HU,
  /** Speed of the push away from a ladder when jumping off it. */
  ladderJumpSpeed: 270 * HU,
  /** Highest ledge above the feet a mantle can grab (from a jump's apex, ~2.2 m walls). */
  mantleReach: 0.8,
  /** How far ahead of the hull a mantle looks for a ledge. */
  mantleProbe: 0.3,
  /** Pull-up speeds: up, then over the edge. */
  mantleUpSpeed: 4.5,
  mantleOverSpeed: 3,
  /** Wading waist-deep: speed and jump multipliers. */
  wadeMul: 0.55,
  wadeJumpMul: 0.6,
  /** Landing speed above which a fall hurts, and the speed that kills (CS: 580 / 1024 HU/s). */
  safeFallSpeed: 580 * HU,
  fatalFallSpeed: 1024 * HU,
} as const;

export const STAND_MINS: Vec3 = { x: -MOVE.halfWidth, y: 0, z: -MOVE.halfWidth };
export const STAND_MAXS: Vec3 = { x: MOVE.halfWidth, y: MOVE.standHeight, z: MOVE.halfWidth };
export const DUCK_MINS: Vec3 = { x: -MOVE.halfWidth, y: 0, z: -MOVE.halfWidth };
export const DUCK_MAXS: Vec3 = { x: MOVE.halfWidth, y: MOVE.duckHeight, z: MOVE.halfWidth };
