import { describe, expect, it } from 'vitest';
import { TICK } from '../core/config';
import { vec3 } from '../core/math';
import { parseParams } from '../core/urlParams';
import { Buttons, makeCmd } from '../input/UserCmd';
import { Contents, MASK_PLAYER, MASK_SHOT, SOLID } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { STAND_MAXS, STAND_MINS } from '../player/movementConfig';
import { makeInventory } from '../weapons/Inventory';
import { brushesFromPacked } from '../world/chunkBrushes';
import { chunkKey } from '../world/chunkMath';
import { BrushWriter } from '../world/gen/BrushWriter';
import { DoorFlag, glassPieces, Material, PieceKind, type ChunkData } from '../world/gen/ChunkData';
import { makeActor, Team, teleport } from './Actor';
import { DoorState, WOOD_HP } from './Doors';
import { Simulation } from './Simulation';

/**
 * A wall along X at z = 30 (x 20..40) with a 1.6 m doorway at x = 30 holding a door (building
 * on the +Z side), and a free-standing window pane at z = 20 (x 10..12, y 0.5..2.5).
 */
function setup(flags = 0) {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  w.box(20, 0, 29.85, 29.2, 3, 30.15, Material.Brick);
  w.box(30.8, 0, 29.85, 40, 3, 30.15, Material.Brick);
  w.box(29.2, 2.4, 29.85, 30.8, 3, 30.15, Material.Brick);
  w.box(10, 0.5, 19.98, 12, 2.5, 20.02, Material.Glass, Contents.GLASS);
  const pane = w.count - 1;
  const brushes = w.finish();
  const data = {
    cx: 0,
    cz: 0,
    key: chunkKey(0, 0),
    seed: 1,
    brushes,
    meshes: [],
    district: 0,
    landmark: 0,
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
    vehicles: new Float32Array(0),
    doors: new Float32Array([30, 0, 30, 1, 1.6, 2.4, flags, 1]),
    pieces: glassPieces([pane]),
    navPatch: new Int32Array(0),
    hasEncounter: false,
    genMs: 0,
  } satisfies ChunkData;
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(data.key, brushesFromPacked(brushes, 0, 0, data.key));
  sim.doors.onChunkLoaded(data);
  sim.pieces.onChunkLoaded(data);
  const door = sim.doors.find(data.key, 0)!;
  return { sim, data, door };
}

/** Stand south of the door, facing it (+Z). */
function faceDoor(sim: Simulation, z = 28.8) {
  const p = sim.player;
  teleport(p, 30, 0.02, z);
  const cmd = makeCmd();
  cmd.yaw = Math.PI;
  for (let i = 0; i < 8; i++) sim.step(cmd);
  return cmd;
}

function pressE(sim: Simulation, cmd = makeCmd()) {
  cmd.pressed = Buttons.USE;
  sim.step(cmd);
  cmd.pressed = 0;
}

const tr = makeTrace();
const doorwayBlocked = (sim: Simulation) => sim.world.testBox(tr, vec3(30, 0.05, 30), STAND_MINS, STAND_MAXS, MASK_PLAYER);

describe('doors', () => {
  it('open and close with E, and block the doorway only while closed', () => {
    const { sim, door } = setup();
    expect(doorwayBlocked(sim)).toBe(true);
    const cmd = faceDoor(sim);
    pressE(sim, cmd);
    expect(door.state).toBe(DoorState.Open);
    // Pushed from outside, it swings in.
    expect(door.side).toBe(1);
    expect(doorwayBlocked(sim)).toBe(false);
    pressE(sim, cmd);
    expect(door.state).toBe(DoorState.Closed);
    expect(doorwayBlocked(sim)).toBe(true);
    const events = sim.events.drain().filter((e) => e.type === 'door');
    expect(events.map((e) => e.type === 'door' && e.action)).toEqual(['open', 'close']);
  });

  it('stay locked until kicked in', () => {
    const { sim, door } = setup(DoorFlag.Locked);
    const cmd = faceDoor(sim);
    pressE(sim, cmd);
    expect(door.state).toBe(DoorState.Closed);
    expect(sim.events.drain().some((e) => e.type === 'door' && e.action === 'locked')).toBe(true);
    // Running at it: a kick. A locked wooden door takes two.
    for (let k = 0; k < 2; k++) {
      faceDoor(sim, 27);
      sim.player.move.vel.z = 6;
      sim.doors.kick(door, sim.player);
    }
    expect(door.state).toBe(DoorState.Broken);
    expect(doorwayBlocked(sim)).toBe(false);
  });

  it('a kicked door knocks whoever stands behind it', () => {
    const { sim, door } = setup();
    // Just out of reach, so it doesn't open the door itself.
    const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 30, 0.02, 31.3);
    sim.addActor(bot);
    faceDoor(sim, 27);
    sim.doors.kick(door, sim.player);
    expect(door.state).toBe(DoorState.Open);
    expect(bot.health).toBeLessThan(100);
  });

  it('break under gunfire, and wood lets bullets through', () => {
    const { sim, door } = setup();
    const dummy = sim.spawnDummy(30, 0.05, 33, 0);
    const p = sim.player;
    p.inv = makeInventory('glock', 'ak47');
    teleport(p, 30, 0.02, 25);
    const cmd = makeCmd();
    cmd.yaw = cmd.attackYaw = Math.PI;
    cmd.pitch = cmd.attackPitch = -0.05;
    for (let i = 0; i < 64; i++) sim.step(cmd);
    cmd.buttons = Buttons.ATTACK;
    cmd.pressed = Buttons.ATTACK;
    for (let i = 0; i < 128 && door.state !== DoorState.Broken; i++) {
      sim.step(cmd);
      cmd.pressed = 0;
    }
    expect(door.state).toBe(DoorState.Broken);
    expect(dummy.health < 100 || !dummy.alive || dummy.diedAt >= 0).toBe(true);
  });

  it('break in an HE blast', () => {
    const { sim, door } = setup();
    sim.doors.blast(vec3(30, 0.2, 29), 8.9);
    expect(door.state).toBe(DoorState.Broken);
  });

  it('open for bots walking into them, which kick in locked ones', () => {
    const open = setup();
    const bot = makeActor(open.sim.newActorId(), 'Bot', Team.Bots, 30, 0.02, 29.2);
    open.sim.addActor(bot);
    for (let i = 0; i < 8; i++) open.sim.step(makeCmd());
    expect(open.door.state).toBe(DoorState.Open);

    const locked = setup(DoorFlag.Locked);
    const bot2 = makeActor(locked.sim.newActorId(), 'Bot', Team.Bots, 30, 0.02, 29.2);
    locked.sim.addActor(bot2);
    for (let i = 0; i < 64 * 3; i++) locked.sim.step(makeCmd());
    expect(locked.door.state).toBe(DoorState.Broken);
  });

  it('come back as they were when their chunk reloads', () => {
    const { sim, data, door } = setup();
    const cmd = faceDoor(sim);
    pressE(sim, cmd);
    sim.doors.damage(door.owner, 30);
    sim.doors.onChunkUnloaded(data.key);
    sim.doors.onChunkLoaded(data);
    const again = sim.doors.find(data.key, 0)!;
    expect(again.state).toBe(DoorState.Open);
    expect(again.hp).toBe(WOOD_HP - 30);
  });

  it('are left to the host on an online client', () => {
    const { sim, door } = setup();
    sim.replica = true;
    const cmd = faceDoor(sim);
    pressE(sim, cmd);
    expect(door.state).toBe(DoorState.Closed);
    sim.doors.apply([door.chunkKey, door.index, DoorState.Open, 1, WOOD_HP, 0]);
    expect(door.state).toBe(DoorState.Open);
    expect(doorwayBlocked(sim)).toBe(false);
  });
});

describe('glass', () => {
  it('blocks walking but not sight', () => {
    const { sim } = setup();
    expect(sim.world.testBox(tr, vec3(11, 0.05, 20), STAND_MINS, STAND_MAXS, MASK_PLAYER)).toBe(true);
    sim.world.traceRay(tr, vec3(11, 1.5, 15), vec3(11, 1.5, 25), MASK_SHOT);
    expect(tr.fraction).toBe(1);
  });

  it('shatters when shot, and the bullet flies on', () => {
    const { sim, data } = setup();
    const dummy = sim.spawnDummy(11, 0.05, 24, 0);
    const p = sim.player;
    p.inv = makeInventory('glock', 'ak47');
    teleport(p, 11, 0.02, 16);
    const cmd = makeCmd();
    cmd.yaw = cmd.attackYaw = Math.PI;
    cmd.pitch = cmd.attackPitch = -0.08;
    for (let i = 0; i < 64; i++) sim.step(cmd);
    cmd.buttons = Buttons.ATTACK;
    cmd.pressed = Buttons.ATTACK;
    sim.step(cmd);
    expect(sim.pieces.isBroken(data.key, data.pieces[1])).toBe(true);
    expect(sim.events.drain().some((e) => e.type === 'piece_break')).toBe(true);
    expect(dummy.health).toBeLessThan(100);
    expect(sim.world.testBox(tr, vec3(11, 0.05, 20), STAND_MINS, STAND_MAXS, MASK_PLAYER)).toBe(false);
  });

  it('shatters in a blast and stays broken across reloads and saves', () => {
    const { sim, data } = setup();
    sim.pieces.breakNear(vec3(11, 1, 18), 6, PieceKind.Glass);
    expect(sim.pieces.isBroken(data.key, data.pieces[1])).toBe(true);
    const saved = sim.pieces.list();
    const again = setup().sim;
    again.pieces.restore(saved);
    again.pieces.onChunkUnloaded(data.key);
    again.pieces.onChunkLoaded(data);
    expect(again.world.testBox(tr, vec3(11, 0.05, 20), STAND_MINS, STAND_MAXS, MASK_PLAYER)).toBe(false);
  });
});
