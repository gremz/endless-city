import { describe, expect, it } from 'vitest';
import { TICK } from '../../core/config';
import { parseParams } from '../../core/urlParams';
import { Buttons, makeCmd, type UserCmd } from '../../input/UserCmd';
import { Contents, MASK_PLAYER, SOLID } from '../../physics/brush';
import { makeTrace } from '../../physics/trace';
import { FLOOR, worldFrom } from '../../physics/testUtil';
import { STAND_MAXS, STAND_MINS } from '../../player/movementConfig';
import { brushesFromPacked } from '../../world/chunkBrushes';
import { chunkKey } from '../../world/chunkMath';
import { BrushWriter } from '../../world/gen/BrushWriter';
import { Material, VEHICLE_STRIDE, type ChunkData } from '../../world/gen/ChunkData';
import { makeActor, Team, teleport } from '../Actor';
import { applyWorldSave, captureSave } from '../save';
import { PickupManager } from '../Pickups';
import { Simulation } from '../Simulation';
import { CAR, carSpeed, copyCarState, forwardSpeed, makeCarState, stepCar, type CarInput, type CarState } from './carPhysics';
import { enterableVehicle, EXIT_MAX_SPEED, VEHICLE_HEALTH } from './Vehicle';
import { Vehicles } from './Vehicles';

const drive = (throttle: number, steer = 0, handbrake = false): CarInput => ({ throttle, steer, handbrake });

function run(c: CarState, world: ReturnType<typeof worldFrom>, seconds: number, input: CarInput): number {
  let impact = 0;
  for (let i = 0; i < Math.round(seconds / TICK); i++) impact = Math.max(impact, stepCar(c, input, world, TICK, 99));
  return impact;
}

describe('car handling', () => {
  it('accelerates to a top speed along its heading', () => {
    const world = worldFrom([{ min: [-1000, -1, -1000], max: [1000, 0, 1000] }]);
    const c = makeCarState(0, 0, 0, 0);
    run(c, world, 1, drive(1));
    const after1 = forwardSpeed(c);
    expect(after1).toBeGreaterThan(5);
    run(c, world, 12, drive(1));
    // About 85 km/h flat out.
    expect(forwardSpeed(c)).toBeGreaterThan(22);
    expect(forwardSpeed(c)).toBeLessThan(25);
    // Yaw 0 faces -Z.
    expect(c.pos.z).toBeLessThan(-100);
    expect(Math.abs(c.pos.x)).toBeLessThan(0.01);
    expect(c.pos.y).toBeCloseTo(0, 2);
  });

  it('brakes, then reverses slowly', () => {
    const world = worldFrom([FLOOR]);
    const c = makeCarState(0, 0, 0, 0);
    run(c, world, 3, drive(1));
    run(c, world, 1.5, drive(-1));
    expect(forwardSpeed(c)).toBeLessThanOrEqual(0.5);
    run(c, world, 6, drive(-1));
    expect(forwardSpeed(c)).toBeLessThan(-4);
    expect(forwardSpeed(c)).toBeGreaterThanOrEqual(-CAR.maxReverse);
  });

  it('turns right with D and left with A, and only while rolling', () => {
    const world = worldFrom([FLOOR]);
    const still = makeCarState(0, 0, 0, 0);
    run(still, world, 1, drive(0, 1));
    expect(still.yaw).toBe(0);
    const right = makeCarState(0, 0, 0, 0);
    run(right, world, 2, drive(1, 1));
    // Positive yaw turns left (counter-clockwise from above).
    expect(right.yaw).toBeLessThan(-0.3);
    expect(right.pos.x).toBeGreaterThan(0.5);
    const left = makeCarState(0, 0, 0, 0);
    run(left, world, 2, drive(1, -1));
    expect(left.yaw).toBeCloseTo(-right.yaw, 5);
  });

  it('slides sideways with the handbrake', () => {
    const world = worldFrom([FLOOR]);
    const grip = makeCarState(0, 0, 0, 0);
    const drift = makeCarState(0, 0, 0, 0);
    run(grip, world, 3, drive(1));
    copyCarState(grip, drift);
    run(grip, world, 0.6, drive(0, 1));
    run(drift, world, 0.6, drive(0, 1, true));
    const side = (c: CarState) => Math.abs(Math.cos(c.yaw) * c.vel.x - Math.sin(c.yaw) * c.vel.z);
    expect(side(drift)).toBeGreaterThan(side(grip) * 2);
  });

  it('stops at a wall without going through it, and reports the crash', () => {
    const world = worldFrom([FLOOR, { min: [-10, 0, -31], max: [10, 3, -30] }]);
    const c = makeCarState(0, 0, 0, 0);
    let hardest = 0;
    for (let i = 0; i < 6 * 64; i++) {
      hardest = Math.max(hardest, stepCar(c, drive(1), world, TICK, 99));
      // Front bumper never past the wall face.
      expect(c.pos.z - 2.15).toBeGreaterThan(-30.01);
    }
    expect(hardest).toBeGreaterThan(CAR.crashSpeed);
  });

  it('rolls over a curb but not up a knee-high step', () => {
    const curb = worldFrom([FLOOR, { min: [-10, 0, -60], max: [10, 0.15, -10] }]);
    const c = makeCarState(0, 0, 0, 0);
    run(c, curb, 4, drive(1));
    expect(c.pos.z).toBeLessThan(-15);
    expect(c.pos.y).toBeCloseTo(0.15, 2);
    const step = worldFrom([FLOOR, { min: [-10, 0, -60], max: [10, 0.5, -10] }]);
    const d = makeCarState(0, 0, 0, 0);
    run(d, step, 4, drive(1));
    expect(d.pos.z).toBeGreaterThan(-10 + 2.1);
    expect(d.pos.y).toBeCloseTo(0, 2);
  });

  it('drives off a ledge and lands on the ground below', () => {
    const world = worldFrom([
      { min: [-20, -1, -10], max: [20, 0, 20] },
      { min: [-20, -3, -80], max: [20, -2, -10] },
    ]);
    const c = makeCarState(0, 0, 0, 0);
    let wasAirborne = false;
    for (let i = 0; i < 4 * 64; i++) {
      stepCar(c, drive(1), world, TICK, 99);
      if (!c.onGround) wasAirborne = true;
    }
    expect(wasAirborne).toBe(true);
    expect(c.onGround).toBe(true);
    expect(c.pos.y).toBeCloseTo(-2, 2);
  });

  it('is deterministic for the same inputs', () => {
    const world = worldFrom([FLOOR, { min: [-3, 0, -40], max: [3, 2, -38] }]);
    const inputs = Array.from({ length: 400 }, (_, i) => drive(i % 90 < 60 ? 1 : -0.5, Math.sin(i / 17), i % 150 > 130));
    const a = makeCarState(1, 0, 2, 0.3);
    const b = makeCarState(1, 0, 2, 0.3);
    for (const inp of inputs) stepCar(a, inp, world, TICK, 99);
    for (const inp of inputs) stepCar(b, inp, world, TICK, 99);
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------- the vehicle system

/** A flat chunk with a driveable car at (20, 20) facing -Z, a sim, and the vehicle system. */
function setup() {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  const brushes = w.finish();
  const vehicles = new Float32Array(VEHICLE_STRIDE);
  vehicles.set([20, 0, 20, 0, 3, 0]);
  const data = {
    cx: 0,
    cz: 0,
    key: chunkKey(0, 0),
    seed: 1,
    brushes,
    meshes: [],
    district: 0,
    level: 0,
    navCol: new Uint16Array(0),
    navFloor: new Int16Array(0),
    navFlags: new Uint8Array(0),
    navCover: new Uint8Array(0),
    navLinks: new Float32Array(0),
    spawns: new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    pickups: new Float32Array(0),
    vehicles,
    doors: new Float32Array(0),
    glass: new Int32Array(0),
    hasEncounter: false,
    genMs: 0,
  } satisfies ChunkData;
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(data.key, brushesFromPacked(brushes, 0, 0, data.key));
  const system = new Vehicles(sim);
  sim.systems.push(system);
  system.onChunkLoaded(data);
  // Beside the driver's door.
  teleport(sim.player, 18.6, 0.05, 20);
  return { sim, data, system, car: sim.vehicles[0] };
}

function step(sim: Simulation, seconds: number, cmd: UserCmd = makeCmd()): void {
  for (let i = 0; i < Math.round(seconds / sim.dt); i++) sim.step(cmd);
}

function press(sim: Simulation, button: number, cmd: UserCmd = makeCmd()): void {
  sim.step({ ...cmd, buttons: cmd.buttons | button, pressed: button });
}

const gas = (forward = 1, side = 0): UserCmd => ({ ...makeCmd(), forward, side });

describe('driving', () => {
  it('spawns the chunk’s car and lets a player get in with E', () => {
    const { sim, car } = setup();
    expect(sim.vehicles).toHaveLength(1);
    expect(car.health).toBe(VEHICLE_HEALTH);
    expect(enterableVehicle(sim, sim.player)).toBe(car);
    press(sim, Buttons.USE);
    expect(sim.player.vehicle).toBe(car.id);
    expect(car.driver).toBe(sim.player.id);
    expect(enterableVehicle(sim, sim.player)).toBe(null);
    expect(sim.events.drain().some((e) => e.type === 'car_door' && e.enter)).toBe(true);
  });

  it('is out of reach a few meters away', () => {
    const { sim } = setup();
    teleport(sim.player, 15, 0.05, 20);
    press(sim, Buttons.USE);
    expect(sim.player.vehicle).toBe(-1);
  });

  it('drives the car and carries the driver along, then lets them out beside it', () => {
    const { sim, car } = setup();
    press(sim, Buttons.USE);
    step(sim, 1.5, gas(1));
    expect(car.car.pos.z).toBeLessThan(15);
    const p = sim.player.move.pos;
    expect(Math.hypot(p.x - car.car.pos.x, p.z - car.car.pos.z)).toBeLessThan(1);
    // Too fast to jump out.
    press(sim, Buttons.USE, gas(1));
    expect(sim.player.vehicle).toBe(car.id);
    step(sim, 3, gas(-1));
    expect(carSpeed(car.car)).toBeLessThan(EXIT_MAX_SPEED);
    press(sim, Buttons.USE);
    expect(sim.player.vehicle).toBe(-1);
    expect(car.driver).toBe(-1);
    const tr = makeTrace();
    expect(sim.world.testBox(tr, sim.player.move.pos, STAND_MINS, STAND_MAXS, MASK_PLAYER)).toBe(false);
    // Driver's (left) side.
    const right = Math.cos(car.car.yaw) * (p.x - car.car.pos.x) - Math.sin(car.car.yaw) * (p.z - car.car.pos.z);
    expect(right).toBeLessThan(-1);
  });

  it('gets out on the other side when a wall is against the driver’s door', () => {
    const { sim, car } = setup();
    press(sim, Buttons.USE);
    sim.world.addChunk(chunkKey(5, 5), brushesFromPacked(wallAt(18.9), 0, 0, chunkKey(5, 5)));
    press(sim, Buttons.USE);
    expect(sim.player.vehicle).toBe(-1);
    expect(sim.player.move.pos.x).toBeGreaterThan(car.car.pos.x + 1);
  });

  it('blocks walking through a parked car and stops shots at its body', () => {
    const { sim, car } = setup();
    teleport(sim.player, 16, 0.05, 20.3);
    step(sim, 1.5, { ...gas(0, 1), yaw: 0 });
    // Walked right (+X) into the car's side and stopped there.
    expect(sim.player.move.pos.x).toBeLessThan(car.car.pos.x - 0.9);
    const tr = makeTrace();
    sim.world.traceRay(tr, { x: 15, y: 0.6, z: 20 }, { x: 25, y: 0.6, z: 20 }, Contents.SOLID_BULLET);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.brush?.owner).toBe(car.id);
    // The windows let bullets through (to the driver).
    sim.world.traceRay(tr, { x: 15, y: 1.2, z: 20 }, { x: 25, y: 1.2, z: 20 }, Contents.SOLID_BULLET);
    expect(tr.fraction).toBe(1);
  });

  it('runs over a bot: kills it at speed, credited to the driver', () => {
    const { sim, car } = setup();
    const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 20, 0.05, -5);
    sim.addActor(bot);
    press(sim, Buttons.USE);
    step(sim, 4, gas(1));
    expect(bot.alive).toBe(false);
    const kill = sim.events.drain().find((e) => e.type === 'kill');
    expect(kill).toMatchObject({ attackerId: sim.player.id, victimId: bot.id, weapon: 'car' });
    expect(car.driver).toBe(sim.player.id);
  });

  it('only pushes a teammate aside', () => {
    const { sim } = setup();
    const mate = sim.addPlayer('Mate');
    teleport(mate, 20, 0.05, -5);
    press(sim, Buttons.USE);
    step(sim, 4, gas(1));
    expect(mate.alive).toBe(true);
    expect(mate.health).toBe(100);
  });

  it('takes damage from gunfire and burns out, throwing the driver clear', () => {
    const { sim, car } = setup();
    const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 40, 0.05, 20);
    sim.addActor(bot);
    press(sim, Buttons.USE);
    sim.onVehicleHit(bot, car.id, 200);
    expect(car.health).toBe(VEHICLE_HEALTH - 200);
    expect(car.moved).toBe(true);
    sim.onVehicleHit(bot, car.id, 400);
    expect(car.destroyed).toBe(true);
    expect(sim.player.vehicle).toBe(-1);
    expect(sim.player.health).toBeLessThan(100);
    expect(sim.grenades.fires).toHaveLength(1);
    expect(sim.events.drain().some((e) => e.type === 'car_destroyed')).toBe(true);
    // A wreck can't be driven.
    teleport(sim.player, 18.6, 0.05, 20);
    press(sim, Buttons.USE);
    expect(sim.player.vehicle).toBe(-1);
  });

  it('keeps a moved car where it was left across chunk reloads, and doesn’t respawn its spot', () => {
    const { sim, data, system, car } = setup();
    press(sim, Buttons.USE);
    step(sim, 1, gas(1));
    step(sim, 3, gas(-1));
    press(sim, Buttons.USE);
    step(sim, 1);
    const z = car.car.pos.z;
    system.onChunkUnloaded(data.key);
    expect(sim.vehicles).toHaveLength(0);
    expect(sim.world.hasDynamic(car.id)).toBe(false);
    system.onChunkLoaded(data);
    expect(sim.vehicles).toHaveLength(1);
    expect(sim.vehicles[0].car.pos.z).toBeCloseTo(z, 5);
  });

  it('respawns an untouched car when its chunk comes back', () => {
    const { sim, data, system } = setup();
    system.onChunkUnloaded(data.key);
    system.onChunkLoaded(data);
    expect(sim.vehicles).toHaveLength(1);
    expect(sim.vehicles[0].car.pos.z).toBe(20);
  });

  it('saves moved and wrecked cars', () => {
    const { sim, data, system, car } = setup();
    press(sim, Buttons.USE);
    step(sim, 1, gas(1));
    step(sim, 3, gas(-1));
    press(sim, Buttons.USE);
    step(sim, 1);
    car.health = 123;
    const save = JSON.parse(JSON.stringify(captureSave(sim, sim.player, new PickupManager(sim), null, system, []))) as ReturnType<typeof captureSave>;
    expect(save.vehicles?.cars).toHaveLength(1);

    const again = setup();
    again.system.onChunkUnloaded(data.key);
    applyWorldSave(save, again.sim, new PickupManager(again.sim), null, again.system, again.sim.player.id);
    again.system.onChunkLoaded(data);
    expect(again.sim.vehicles).toHaveLength(1);
    expect(again.sim.vehicles[0].car.pos.z).toBeCloseTo(car.car.pos.z, 4);
    expect(again.sim.vehicles[0].health).toBe(123);
  });
});

/** A wall along Z at x (1 m tall is enough to block a door), as packed brushes in chunk (0, 0). */
function wallAt(x: number): Int32Array {
  const w = new BrushWriter();
  w.box(x - 0.3, 0, 10, x, 3, 30, Material.Concrete, SOLID);
  return w.finish();
}
