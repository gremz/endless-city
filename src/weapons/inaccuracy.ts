import { clamp01 } from '../core/math';
import type { Rand } from '../core/rng';
import type { WeaponDef } from './weaponDefs';

export interface InaccuracyInput {
  /** Horizontal speed in m/s. */
  speed: number;
  onGround: boolean;
  ducked: boolean;
  scoped: boolean;
  /** Accumulated firing penalty (mrad). */
  fireInacc: number;
}

/** Fraction of full movement inaccuracy: zero below 34% of max speed, linear to 1 at max speed. */
export function moveFraction(def: WeaponDef, speed: number): number {
  const max = def.maxSpeed;
  return clamp01((speed - 0.34 * max) / (0.66 * max));
}

/** Current inaccuracy in milliradians (excluding the constant spread). */
export function inaccuracy(def: WeaponDef, s: InaccuracyInput): number {
  let base: number;
  if (s.scoped && def.inaccStandScoped !== undefined) {
    base = s.ducked ? (def.inaccCrouchScoped ?? def.inaccStandScoped) : def.inaccStandScoped;
  } else {
    base = s.ducked && s.onGround ? def.inaccCrouch : def.inaccStand;
  }
  let v = base + moveFraction(def, s.speed) * def.inaccMove + s.fireInacc;
  if (!s.onGround) v += def.inaccAir;
  return v;
}

/** Decay the fire penalty: it falls by 10x every recoveryTime seconds. */
export function decayFireInacc(def: WeaponDef, fireInacc: number, dt: number): number {
  if (fireInacc <= 0) return 0;
  const v = fireInacc * Math.pow(0.1, dt / def.recoveryTime);
  return v < 0.01 ? 0 : v;
}

/**
 * CS-style spread sample: two independent (angle, radius) pairs for inaccuracy and spread.
 * Radius is uniform (not sqrt), which biases shots towards the center like CS.
 * Returns offsets in radians along the view's right and up axes.
 */
export function sampleSpread(r: Rand, inaccMrad: number, spreadMrad: number, out: { x: number; y: number }): void {
  const a1 = r() * Math.PI * 2;
  const r1 = r();
  const a2 = r() * Math.PI * 2;
  const r2 = r();
  const inacc = inaccMrad * 0.001;
  const spread = spreadMrad * 0.001;
  out.x = Math.cos(a1) * r1 * inacc + Math.cos(a2) * r2 * spread;
  out.y = Math.sin(a1) * r1 * inacc + Math.sin(a2) * r2 * spread;
}
