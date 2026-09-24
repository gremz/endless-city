/**
 * Arcade car handling: a bicycle model with lateral grip, a slide move against the world with
 * three box hulls along the car, and four wheel rays for ride height, pitch and roll. Pure and
 * deterministic in (state, input, world), so a client can predict the car it drives exactly as
 * it predicts walking. Allocates nothing per tick.
 */
import { vec3, type Vec3 } from '../../core/math';
import { MASK_PLAYER } from '../../physics/brush';
import type { CollisionWorld } from '../../physics/CollisionWorld';
import { makeTrace } from '../../physics/trace';
import { CAR_L, CAR_W } from '../../world/gen/streets';

export interface CarState {
  /** Center of the footprint at ground level. */
  pos: Vec3;
  vel: Vec3;
  /** Heading (see anglesToForward: yaw 0 faces -Z). */
  yaw: number;
  yawRate: number;
  /** Current steering, -1 (left) .. 1 (right), eased towards the input. */
  steer: number;
  /** Body tilt from the wheels (radians): nose up, and left side up. */
  pitch: number;
  roll: number;
  onGround: boolean;
  /** Throttle applied last tick (-1..1) and whether the brakes were on (sound, brake lights). */
  throttle: number;
  braking: boolean;
}

export interface CarInput {
  /** 1 = full throttle, -1 = brake, then reverse. */
  throttle: number;
  /** -1..1, positive = right. */
  steer: number;
  handbrake: boolean;
}

export const CAR = {
  /** Speed the engine can't push past (drag holds the car to about 85 km/h), and reverse top speed (m/s). */
  maxSpeed: 30,
  maxReverse: 7,
  engine: 8,
  reverse: 4.5,
  brake: 16,
  handbrake: 6,
  /** Rolling resistance and engine braking (m/s²), and air drag per (m/s)². */
  rolling: 0.5,
  engineBrake: 1.6,
  drag: 0.0022,
  /** Lateral grip: sideways speed dies off at this rate (1/s). */
  grip: 11,
  handbrakeGrip: 1.8,
  /** Front-to-rear axle distance and wheel track (m). */
  wheelbase: 2.55,
  track: 1.5,
  maxSteer: 0.62,
  /** Steering speed (full lock per second). */
  steerRate: 3.2,
  gravity: 16,
  /** Body collision starts this far above the ground (so curbs pass under it). */
  clearance: 0.3,
  /** Impacts faster than this (m/s, into the wall) damage the car. */
  crashSpeed: 7,
} as const;

/** Body collision: three square hulls along the length, lifted by the clearance. */
const HALF = CAR_W / 2;
const HULL_S = [-(CAR_L / 2 - HALF), 0, CAR_L / 2 - HALF] as const;
const HULL_MINS = vec3(-HALF, CAR.clearance, -HALF);
const HULL_MAXS = vec3(HALF, 1.4, HALF);
/** Wheel contact points in car space (s forward, t right). */
const WHEELS: readonly (readonly [number, number])[] = [
  [CAR.wheelbase / 2, -CAR.track / 2],
  [CAR.wheelbase / 2, CAR.track / 2],
  [-CAR.wheelbase / 2, -CAR.track / 2],
  [-CAR.wheelbase / 2, CAR.track / 2],
];
/** Highest step a wheel can climb (the hulls stop anything taller first). */
const WHEEL_REACH_UP = 0.6;
const WHEEL_REACH_DOWN = 1.6;

export function makeCarState(x: number, y: number, z: number, yaw: number): CarState {
  return {
    pos: vec3(x, y, z),
    vel: vec3(),
    yaw,
    yawRate: 0,
    steer: 0,
    pitch: 0,
    roll: 0,
    onGround: true,
    throttle: 0,
    braking: false,
  };
}

export function copyCarState(src: CarState, out: CarState): CarState {
  out.pos.x = src.pos.x;
  out.pos.y = src.pos.y;
  out.pos.z = src.pos.z;
  out.vel.x = src.vel.x;
  out.vel.y = src.vel.y;
  out.vel.z = src.vel.z;
  out.yaw = src.yaw;
  out.yawRate = src.yawRate;
  out.steer = src.steer;
  out.pitch = src.pitch;
  out.roll = src.roll;
  out.onGround = src.onGround;
  out.throttle = src.throttle;
  out.braking = src.braking;
  return out;
}

/** Signed speed along the heading (m/s). */
export function forwardSpeed(c: CarState): number {
  return -Math.sin(c.yaw) * c.vel.x - Math.cos(c.yaw) * c.vel.z;
}

export const carSpeed = (c: CarState) => Math.hypot(c.vel.x, c.vel.z);

const tr = makeTrace();
const start = vec3();
const end = vec3();
const hitN = vec3();
const heights = [0, 0, 0, 0];

/**
 * Advance a car one tick. `owner` is the car's own id (its collision boxes are ignored).
 * Returns the speed of the hardest impact into a wall this tick (0 if none).
 */
export function stepCar(c: CarState, input: CarInput, world: CollisionWorld, dt: number, owner: number): number {
  const prevIgnore = world.ignoreOwner;
  world.ignoreOwner = owner;
  const s = Math.sin(c.yaw);
  const co = Math.cos(c.yaw);
  // Forward (-s, -co) and right (co, -s).
  let vf = -s * c.vel.x - co * c.vel.z;
  let vl = co * c.vel.x - s * c.vel.z;
  const throttle = Math.max(-1, Math.min(1, input.throttle));
  const steerIn = Math.max(-1, Math.min(1, input.steer));
  const ds = steerIn - c.steer;
  const maxDs = CAR.steerRate * dt;
  c.steer += ds > maxDs ? maxDs : ds < -maxDs ? -maxDs : ds;
  c.throttle = throttle;
  c.braking = false;

  if (c.onGround) {
    if (throttle > 0) {
      if (vf < -0.5) {
        vf = Math.min(0, vf + CAR.brake * throttle * dt);
        c.braking = true;
      } else vf += CAR.engine * throttle * Math.max(0, 1 - vf / CAR.maxSpeed) * dt;
    } else if (throttle < 0) {
      if (vf > 0.5) {
        vf = Math.max(0, vf + CAR.brake * throttle * dt);
        c.braking = true;
      } else vf += CAR.reverse * throttle * Math.max(0, 1 + vf / CAR.maxReverse) * dt;
    }
    let decel = CAR.rolling + CAR.drag * vf * vf + (throttle === 0 ? CAR.engineBrake : 0);
    if (input.handbrake) decel += CAR.handbrake;
    const drop = Math.min(Math.abs(vf), decel * dt);
    vf -= vf > 0 ? drop : -drop;
    vl *= Math.exp(-(input.handbrake ? CAR.handbrakeGrip : CAR.grip) * dt);
    if (Math.abs(vf) < 0.05 && throttle === 0) vf = 0;
    if (Math.abs(vl) < 0.02) vl = 0;
    const maxSteer = CAR.maxSteer / (1 + Math.abs(vf) / 14);
    c.yawRate = (-vf * Math.tan(c.steer * maxSteer)) / CAR.wheelbase;
    if (input.handbrake) c.yawRate *= 1.35;
  } else {
    c.yawRate *= 0.99;
  }
  c.vel.x = -s * vf + co * vl;
  c.vel.z = -co * vf - s * vl;

  // Turn, unless that would swing the body into something.
  if (c.yawRate !== 0) {
    const yaw = c.yaw + c.yawRate * dt;
    if (hullsClear(c, yaw, world)) c.yaw = yaw;
    else {
      c.yawRate = 0;
      c.vel.x *= 0.97;
      c.vel.z *= 0.97;
    }
  }

  const impact = slide(c, world, dt);
  ground(c, world, dt);
  world.ignoreOwner = prevIgnore;
  return impact;
}

function hullsClear(c: CarState, yaw: number, world: CollisionWorld): boolean {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  for (const hs of HULL_S) {
    start.x = c.pos.x + fx * hs;
    start.y = c.pos.y;
    start.z = c.pos.z + fz * hs;
    if (world.testBox(tr, start, HULL_MINS, HULL_MAXS, MASK_PLAYER)) {
      // Already overlapping here at the old heading too: don't let that lock the steering.
      const ox = c.pos.x - Math.sin(c.yaw) * hs;
      const oz = c.pos.z - Math.cos(c.yaw) * hs;
      start.x = ox;
      start.z = oz;
      if (!world.testBox(tr, start, HULL_MINS, HULL_MAXS, MASK_PLAYER)) return false;
    }
  }
  return true;
}

/** Horizontal slide move of all three hulls together. Returns the hardest impact speed. */
function slide(c: CarState, world: CollisionWorld, dt: number): number {
  let dx = c.vel.x * dt;
  let dz = c.vel.z * dt;
  let impact = 0;
  const fx = -Math.sin(c.yaw);
  const fz = -Math.cos(c.yaw);
  for (let bump = 0; bump < 3; bump++) {
    if (Math.abs(dx) + Math.abs(dz) < 1e-7) break;
    let best = 1;
    for (const hs of HULL_S) {
      start.x = c.pos.x + fx * hs;
      start.y = c.pos.y;
      start.z = c.pos.z + fz * hs;
      end.x = start.x + dx;
      end.y = start.y;
      end.z = start.z + dz;
      world.traceBox(tr, start, end, HULL_MINS, HULL_MAXS, MASK_PLAYER);
      // A hull that starts inside something (another car nosed into it) can't be resolved by
      // this move; ignore it rather than locking the car in place.
      if (tr.startSolid) continue;
      if (tr.fraction < best) {
        best = tr.fraction;
        hitN.x = tr.normal.x;
        hitN.y = tr.normal.y;
        hitN.z = tr.normal.z;
      }
    }
    c.pos.x += dx * best;
    c.pos.z += dz * best;
    if (best >= 1) break;
    const nl = Math.hypot(hitN.x, hitN.z);
    if (nl < 1e-3) break;
    const nx = hitN.x / nl;
    const nz = hitN.z / nl;
    const into = -(c.vel.x * nx + c.vel.z * nz);
    if (into > 0) {
      impact = Math.max(impact, into);
      // Stop the motion into the wall, bounce back a little and scrub some speed along it.
      c.vel.x += nx * into * 1.15;
      c.vel.z += nz * into * 1.15;
      const keep = Math.max(0.3, 1 - into * 0.04);
      c.vel.x *= keep;
      c.vel.z *= keep;
    }
    const rest = 1 - best;
    dx *= rest;
    dz *= rest;
    const dInto = dx * nx + dz * nz;
    if (dInto < 0) {
      dx -= nx * dInto;
      dz -= nz * dInto;
    }
  }
  return impact;
}

/** Ride height, tilt and falling from the four wheel rays. */
function ground(c: CarState, world: CollisionWorld, dt: number): void {
  const s = Math.sin(c.yaw);
  const co = Math.cos(c.yaw);
  let sum = 0;
  let found = 0;
  for (let i = 0; i < 4; i++) {
    const [ws, wt] = WHEELS[i];
    const x = c.pos.x - s * ws + co * wt;
    const z = c.pos.z - co * ws - s * wt;
    start.x = end.x = x;
    start.z = end.z = z;
    start.y = c.pos.y + WHEEL_REACH_UP;
    end.y = c.pos.y - WHEEL_REACH_DOWN;
    world.traceRay(tr, start, end, MASK_PLAYER);
    if (tr.fraction < 1 && !tr.startSolid) {
      heights[i] = tr.endY;
      sum += tr.endY;
      found++;
    } else heights[i] = end.y;
  }
  const target = found ? sum / found : -Infinity;
  const speed = Math.hypot(c.vel.x, c.vel.z);
  // Follow the ground down slopes; a bigger drop than this is a ledge.
  const snapDown = 0.06 + speed * dt * 0.55;
  if (c.onGround && c.vel.y <= 0.5 && target >= c.pos.y - snapDown) {
    c.pos.y = target;
    c.vel.y = 0;
  } else {
    c.onGround = false;
    c.vel.y -= CAR.gravity * dt;
    c.pos.y += c.vel.y * dt;
    if (target > -Infinity && c.pos.y <= target) {
      c.pos.y = target;
      c.vel.y = 0;
      c.onGround = true;
    }
  }
  if (found === 4) {
    const front = (heights[0] + heights[1]) / 2;
    const rear = (heights[2] + heights[3]) / 2;
    const left = (heights[0] + heights[2]) / 2;
    const right = (heights[1] + heights[3]) / 2;
    c.pitch = Math.atan2(front - rear, CAR.wheelbase);
    c.roll = Math.atan2(left - right, CAR.track);
  } else if (!c.onGround) {
    c.pitch *= 0.98;
    c.roll *= 0.98;
  }
}

/** Offsets (car space: s forward, t right) of the four footprint corners. */
export const CAR_HALF_L = CAR_L / 2;
export const CAR_HALF_W = CAR_W / 2;

/**
 * Distance from (x, z) to the car's footprint rectangle (0 inside), and the point's car-space
 * coordinates (s forward, t right) in `out`.
 */
export function footprintDistance(c: CarState, x: number, z: number, out?: { s: number; t: number }): number {
  const dx = x - c.pos.x;
  const dz = z - c.pos.z;
  const sn = Math.sin(c.yaw);
  const co = Math.cos(c.yaw);
  const ls = -sn * dx - co * dz;
  const lt = co * dx - sn * dz;
  if (out) {
    out.s = ls;
    out.t = lt;
  }
  const ex = Math.max(0, Math.abs(ls) - CAR_HALF_L);
  const ez = Math.max(0, Math.abs(lt) - CAR_HALF_W);
  return Math.hypot(ex, ez);
}

/** World point at car-space (s forward, t right, y up from the ground). */
export function carPoint(c: CarState, s: number, t: number, y: number, out: Vec3): Vec3 {
  const sn = Math.sin(c.yaw);
  const co = Math.cos(c.yaw);
  out.x = c.pos.x - sn * s + co * t;
  out.y = c.pos.y + y;
  out.z = c.pos.z - co * s - sn * t;
  return out;
}
