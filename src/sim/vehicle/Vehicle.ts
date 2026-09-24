/**
 * Driveable cars: the vehicle record, getting in and out, driving (run inside the player's
 * command, so clients predict it), damage and destruction. The lifecycle (spawning from chunks,
 * run-over, saving) lives in Vehicles.
 */
import { HitGroup } from '../../ai/hitboxes';
import { vec3, type Vec3 } from '../../core/math';
import { Buttons, type UserCmd } from '../../input/UserCmd';
import { Contents, makeBrush, MASK_PLAYER, setBox, SOLID, type Brush } from '../../physics/brush';
import type { CollisionWorld } from '../../physics/CollisionWorld';
import { makeTrace } from '../../physics/trace';
import { STAND_MAXS, STAND_MINS } from '../../player/movementConfig';
import { equipSlot } from '../../weapons/WeaponSystem';
import { CAR_HIT } from '../../weapons/weaponDefs';
import { Material } from '../../world/gen/ChunkData';
import { storePrev, type Actor } from '../Actor';
import type { Simulation } from '../Simulation';
import { CAR, carPoint, carSpeed, footprintDistance, makeCarState, stepCar, type CarInput, type CarState } from './carPhysics';

export const VEHICLE_HEALTH = 500;
/** How close (m, from the car's footprint) you have to be to get in. */
export const ENTER_REACH = 1.2;
/** Fastest a car can be going for its driver to get out (m/s). */
export const EXIT_MAX_SPEED = 6;
/** Below this health a car smokes. */
export const SMOKE_HEALTH = VEHICLE_HEALTH * 0.3;
/** Seconds a destroyed car burns. */
export const BURN_TIME = 10;
/** Damage to the driver when their car is destroyed under them. */
const WRECK_INJURY = 30;

export interface Vehicle {
  id: number;
  /** Parking slot it came from ("chunkKey:slot"), or '' for one restored from a save. */
  home: string;
  /** Intact paint color index and body type. */
  paint: number;
  hatch: boolean;
  car: CarState;
  /** Pose at the previous tick, for render interpolation. */
  prevPos: Vec3;
  prevYaw: number;
  health: number;
  destroyed: boolean;
  /** Sim time a destroyed car stops burning. */
  burnUntil: number;
  /** Actor id of the driver, or -1. */
  driver: number;
  /** Last actor to drive it (credited when it rolls into someone on its own). */
  lastDriver: number;
  lastAttacker: number;
  /** Driven or damaged: it stays where it is left and its parking slot stays empty. */
  moved: boolean;
  /** Collision boxes (owner = id), and the pose they were last placed at. */
  brushes: Brush[];
  brushPose: [number, number, number, number];
  /** Actor id → sim time until which this car can't hurt them again. */
  hitCooldown: Map<number, number>;
  /** Sim time of the next engine noise the bots can hear. */
  noiseAt: number;
}

export function makeVehicle(id: number, x: number, y: number, z: number, yaw: number, paint: number, hatch: boolean, home = ''): Vehicle {
  return {
    id,
    home,
    paint,
    hatch,
    car: makeCarState(x, y, z, yaw),
    prevPos: vec3(x, y, z),
    prevYaw: yaw,
    health: VEHICLE_HEALTH,
    destroyed: false,
    burnUntil: -1,
    driver: -1,
    lastDriver: -1,
    lastAttacker: -1,
    moved: false,
    brushes: [],
    brushPose: [NaN, NaN, NaN, NaN],
    hitCooldown: new Map(),
    noiseAt: 0,
  };
}

export function storeVehiclePrev(v: Vehicle): void {
  v.prevPos.x = v.car.pos.x;
  v.prevPos.y = v.car.pos.y;
  v.prevPos.z = v.car.pos.z;
  v.prevYaw = v.car.yaw;
}

// ---------------------------------------------------------------- collision boxes

/**
 * Collision is four axis-aligned boxes that follow the car: the body in three lengthwise
 * segments (blocks movement and bullets), and the cabin above the beltline, which blocks
 * movement only, so bullets and eyes pass through the windows to the driver.
 */
const BODY_SEGMENTS: readonly (readonly [number, number])[] = [
  [0.72, 2.15],
  [-0.72, 0.72],
  [-2.15, -0.72],
];
const BODY_Y: readonly [number, number] = [0.05, 0.95];
const CABIN_S: readonly [number, number] = [-1.5, 0.9];
const CABIN_Y: readonly [number, number] = [0.95, 1.45];
const HALF_W = 0.9;
const CABIN_HALF_W = 0.82;

/** Put the car's collision boxes where it is now (cheap no-op if it hasn't moved). */
export function syncVehicleBrushes(world: CollisionWorld, v: Vehicle): void {
  const c = v.car;
  const pose = v.brushPose;
  if (pose[0] === c.pos.x && pose[1] === c.pos.y && pose[2] === c.pos.z && pose[3] === c.yaw && world.hasDynamic(v.id)) return;
  pose[0] = c.pos.x;
  pose[1] = c.pos.y;
  pose[2] = c.pos.z;
  pose[3] = c.yaw;
  if (!v.brushes.length) {
    for (let i = 0; i < 3; i++) v.brushes.push(makeBrush(0, 0, 0, 1, 1, 1, SOLID, Material.Metal));
    v.brushes.push(makeBrush(0, 0, 0, 1, 1, 1, Contents.SOLID_PLAYER, Material.Metal));
  }
  const fx = -Math.sin(c.yaw);
  const fz = -Math.cos(c.yaw);
  const rx = -fz;
  const rz = fx;
  const place = (b: Brush, s0: number, s1: number, hw: number, y0: number, y1: number) => {
    const sm = (s0 + s1) / 2;
    const hs = (s1 - s0) / 2;
    const cx = c.pos.x + fx * sm;
    const cz = c.pos.z + fz * sm;
    const hx = Math.abs(fx) * hs + Math.abs(rx) * hw;
    const hz = Math.abs(fz) * hs + Math.abs(rz) * hw;
    setBox(b, cx - hx, c.pos.y + y0, cz - hz, cx + hx, c.pos.y + y1, cz + hz);
  };
  BODY_SEGMENTS.forEach(([s0, s1], i) => place(v.brushes[i], s0, s1, HALF_W, BODY_Y[0], BODY_Y[1]));
  place(v.brushes[3], CABIN_S[0], CABIN_S[1], CABIN_HALF_W, CABIN_Y[0], CABIN_Y[1]);
  world.setDynamic(v.id, v.brushes);
}

// ---------------------------------------------------------------- getting in and out

/** The car `p` would get into with E right now, if any. */
export function enterableVehicle(sim: Simulation, p: Actor): Vehicle | null {
  if (!p.alive || p.vehicle >= 0) return null;
  let best: Vehicle | null = null;
  let bestD = ENTER_REACH;
  const pos = p.move.pos;
  for (const v of sim.vehicles) {
    if (v.destroyed || v.driver >= 0) continue;
    const dy = pos.y - v.car.pos.y;
    if (dy < -0.8 || dy > 1.6) continue;
    const d = footprintDistance(v.car, pos.x, pos.z);
    if (d < bestD && carSpeed(v.car) < 3) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

/** E: get into the nearest car, or out of the one you're driving. */
export function useVehicle(sim: Simulation, p: Actor): void {
  const cur = p.vehicle >= 0 ? sim.getVehicle(p.vehicle) : undefined;
  if (cur) {
    exitVehicle(sim, p, cur, false);
    return;
  }
  const v = enterableVehicle(sim, p);
  if (v) enterVehicle(sim, p, v);
}

export function enterVehicle(sim: Simulation, p: Actor, v: Vehicle): void {
  p.vehicle = v.id;
  v.driver = p.id;
  v.lastDriver = p.id;
  v.moved = true;
  // Hands on the wheel: no healing, reloading, scoping or grenade in hand.
  if (p.healEnd >= 0) {
    p.healEnd = -1;
    if (!sim.predicting) sim.events.push({ type: 'heal', actorId: p.id, phase: 'cancel', amount: 0 });
  }
  const w = p.wpn;
  w.reloadEnd = -1;
  w.scope = 0;
  w.rescopeAt = -1;
  w.pinPulled = false;
  seatActor(p, v);
  storePrev(p);
  sim.events.push({ type: 'car_door', actorId: p.id, vehicleId: v.id, pos: vec3(v.car.pos.x, v.car.pos.y + 0.8, v.car.pos.z), enter: true });
}

/** Where to try putting someone who gets out: car-space s, t and height above the car's ground. */
const EXITS: readonly (readonly [number, number, number])[] = [
  [-0.15, -1.45, 0.05],
  [-0.15, 1.45, 0.05],
  [-2.8, 0, 0.05],
  [2.8, 0, 0.05],
  [0, 0, 1.5],
];

const tr = makeTrace();
const spot = vec3();
const below = vec3();

/**
 * Get out beside the car (driver's side first). Refused above EXIT_MAX_SPEED or with no room,
 * unless `force` (the driver died or the car blew up), which falls back to the roof.
 */
export function exitVehicle(sim: Simulation, p: Actor, v: Vehicle, force: boolean): boolean {
  const c = v.car;
  if (!force && carSpeed(c) > EXIT_MAX_SPEED) {
    // (Messages come from the host only, so a predicting client doesn't show them twice.)
    if (!sim.predicting) sim.events.push({ type: 'message', actorId: p.id, text: 'Slow down to get out' });
    return false;
  }
  // The car's own boxes count: nobody gets out inside the door.
  syncVehicleBrushes(sim.world, v);
  let found = false;
  for (const [s, t, y] of EXITS) {
    carPoint(c, s, t, y, spot);
    if (sim.world.testBox(tr, spot, STAND_MINS, STAND_MAXS, MASK_PLAYER)) continue;
    found = true;
    break;
  }
  if (!found) {
    if (!force) {
      if (!sim.predicting) sim.events.push({ type: 'message', actorId: p.id, text: 'No room to get out' });
      return false;
    }
    carPoint(c, 0, 0, 1.5, spot);
  }
  // Drop onto the ground there.
  below.x = spot.x;
  below.y = spot.y - 3;
  below.z = spot.z;
  sim.world.traceBox(tr, spot, below, STAND_MINS, STAND_MAXS, MASK_PLAYER);
  const m = p.move;
  m.pos.x = spot.x;
  m.pos.y = tr.fraction < 1 && !tr.startSolid ? tr.endY : spot.y;
  m.pos.z = spot.z;
  m.vel.x = m.vel.y = m.vel.z = 0;
  m.ducked = false;
  m.duckAmount = 0;
  m.onGround = false;
  storePrev(p);
  p.vehicle = -1;
  v.driver = -1;
  if (p.alive) equipSlot(p, p.inv.active, sim);
  sim.events.push({ type: 'car_door', actorId: p.id, vehicleId: v.id, pos: vec3(c.pos.x, c.pos.y + 0.8, c.pos.z), enter: false });
  return true;
}

/** Driver's seat (left front) in car space, and how high the seated hull's feet are. */
const SEAT_S = -0.15;
const SEAT_T = -0.42;
const SEAT_Y = 0.1;

/**
 * Pin the driver to the seat. They're crouched there, so their head sits at the side window
 * where it can be seen and shot.
 */
export function seatActor(p: Actor, v: Vehicle): void {
  const m = p.move;
  carPoint(v.car, SEAT_S, SEAT_T, SEAT_Y, m.pos);
  m.vel.x = v.car.vel.x;
  m.vel.y = v.car.vel.y;
  m.vel.z = v.car.vel.z;
  m.ducked = true;
  m.duckAmount = 1;
  m.onGround = true;
  m.landed = false;
  m.jumped = false;
}

// ---------------------------------------------------------------- driving

const input: CarInput = { throttle: 0, steer: 0, handbrake: false };

/** One tick of driving from the driver's command (W/S throttle and brake, A/D steer, Space handbrake). */
export function driveVehicle(sim: Simulation, p: Actor, v: Vehicle, cmd: UserCmd): void {
  input.throttle = v.destroyed ? 0 : cmd.forward;
  input.steer = v.destroyed ? 0 : cmd.side;
  input.handbrake = v.destroyed || (cmd.buttons & Buttons.JUMP) !== 0;
  const impact = stepCar(v.car, input, sim.world, sim.dt, v.id);
  if (impact > 0) crashed(sim, v, impact, p.id);
  seatActor(p, v);
  const speed = carSpeed(v.car);
  if (speed > 1 && sim.time >= v.noiseAt) {
    v.noiseAt = sim.time + 0.4;
    sim.events.push({ type: 'sound', pos: vec3(v.car.pos.x, v.car.pos.y + 0.6, v.car.pos.z), radius: 22 + speed * 1.6, kind: 'vehicle', sourceId: p.id });
  }
}

/** A driverless car rolling to a stop (or falling). */
export function coastVehicle(sim: Simulation, v: Vehicle): void {
  input.throttle = 0;
  input.steer = 0;
  input.handbrake = true;
  const impact = stepCar(v.car, input, sim.world, sim.dt, v.id);
  if (impact > 0) crashed(sim, v, impact, -1);
}

/** A car at rest on the ground needs no simulating. */
export function vehicleAtRest(v: Vehicle): boolean {
  const c = v.car;
  return c.onGround && c.vel.x === 0 && c.vel.z === 0 && c.vel.y === 0 && c.yawRate === 0;
}

function crashed(sim: Simulation, v: Vehicle, impact: number, driverId: number): void {
  if (impact < CAR.crashSpeed * 0.5) return;
  const c = v.car;
  sim.events.push({ type: 'car_crash', actorId: driverId, vehicleId: v.id, pos: vec3(c.pos.x, c.pos.y + 0.6, c.pos.z), speed: impact });
  if (impact > CAR.crashSpeed) damageVehicle(sim, v, (impact - CAR.crashSpeed) * 14, driverId >= 0 ? driverId : v.lastAttacker);
}

// ---------------------------------------------------------------- damage

/** Damage a car (the host decides; predicting clients skip it). */
export function damageVehicle(sim: Simulation, v: Vehicle, amount: number, attackerId: number): void {
  if (sim.predicting || v.destroyed || amount <= 0) return;
  v.health -= amount;
  v.moved = true;
  if (attackerId >= 0) v.lastAttacker = attackerId;
  if (v.health <= 0) destroyVehicle(sim, v);
}

/** Burn a car out: the driver is thrown clear and hurt, and the wreck burns for a while. */
export function destroyVehicle(sim: Simulation, v: Vehicle): void {
  v.health = 0;
  v.destroyed = true;
  v.burnUntil = sim.time + BURN_TIME;
  const c = v.car;
  c.vel.x *= 0.3;
  c.vel.z *= 0.3;
  const pos = vec3(c.pos.x, c.pos.y + 0.5, c.pos.z);
  const attacker = sim.getActor(v.lastAttacker) ?? null;
  const driver = v.driver >= 0 ? sim.getActor(v.driver) : undefined;
  if (driver) {
    exitVehicle(sim, driver, v, true);
    const by = attacker && attacker !== driver && sim.canHit(attacker, driver) ? attacker : driver;
    sim.onHit({
      attacker: by,
      victim: driver,
      def: { ...CAR_HIT, damage: WRECK_INJURY },
      group: HitGroup.Chest,
      distance: 0,
      damageScale: 1,
      penetrated: false,
      pos: vec3(driver.move.pos.x, driver.move.pos.y + 1, driver.move.pos.z),
    });
  }
  const owner = attacker ?? driver ?? sim.getActor(v.lastDriver) ?? null;
  if (owner) sim.grenades.ignite(vec3(c.pos.x, c.pos.y + 0.05, c.pos.z), owner, BURN_TIME, 2.6);
  sim.events.push({ type: 'nade_detonate', kind: 'hegrenade', pos, airburst: false, normal: null, chunkKey: -1 });
  sim.events.push({ type: 'sound', pos, radius: 80, kind: 'grenade', sourceId: owner?.id ?? -1 });
  sim.events.push({ type: 'car_destroyed', vehicleId: v.id, pos });
}

/** Speed at which getting hit by a car starts to hurt (m/s). */
export const RUN_OVER_SPEED = 4;

/** Run-over damage for a car hitting someone at `speed` m/s. */
export function runOverDamage(speed: number): number {
  return speed < RUN_OVER_SPEED ? 0 : (speed - 3) * 12;
}

