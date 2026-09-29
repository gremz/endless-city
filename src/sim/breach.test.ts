import { describe, expect, it } from 'vitest';
import { AStar } from '../ai/nav/astar';
import { TICK } from '../core/config';
import { vec3 } from '../core/math';
import { parseParams } from '../core/urlParams';
import { Buttons, makeCmd, type UserCmd } from '../input/UserCmd';
import { Contents, MASK_PLAYER, SOLID } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { STAND_MAXS, STAND_MINS } from '../player/movementConfig';
import { brushesFromPacked } from '../world/chunkBrushes';
import { chunkKey } from '../world/chunkMath';
import { BrushWriter } from '../world/gen/BrushWriter';
import { breachOpening, wall } from '../world/gen/buildings';
import { Material, NAV_CELL, NAV_PATCH_STRIDE, NAV_RES, NavFlag, PieceKind, type ChunkData } from '../world/gen/ChunkData';
import { pieceRecords } from '../world/gen/generateChunk';
import { bakeNavWithPieces } from '../world/gen/navBake';
import { teleport } from './Actor';
import { BREACH_FUSE, BREACH_MAX, BREACH_RADIUS, breachTarget, PLANT_TIME } from './breach';
import { buy } from './buy';
import { HE_BREACH_RADIUS } from './Pieces';
import { Simulation } from './Simulation';

/**
 * A brick wall along X at z 30..30.3 (x 20..40, 3 m high) with a bricked-up doorway (the
 * breachable plug) at x 29.25..30.75, on a flat 64 m chunk with nav.
 */
function setup() {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  const plugs: number[] = [];
  wall(w, true, 20, 40, 30, 30.3, 0, 3, [breachOpening(() => 0.5, 29.25, Material.Brick)], Material.Brick, 120, SOLID, null, null, plugs);
  const brushes = w.finish();
  const baked = bakeNavWithPieces(brushes, plugs);
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
    navCol: baked.nav.col,
    navFloor: baked.nav.floor,
    navFlags: baked.nav.flags,
    navCover: baked.nav.cover,
    navLinks: baked.nav.links,
    spawns: new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    pickups: new Float32Array(0),
    vehicles: new Float32Array(0),
    doors: new Float32Array(0),
    pieces: pieceRecords([], plugs, baked.ranges),
    navPatch: baked.records,
    hasEncounter: false,
    genMs: 0,
  } satisfies ChunkData;
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(data.key, brushesFromPacked(brushes, 0, 0, data.key));
  sim.nav.onChunkLoaded(data);
  sim.pieces.onChunkLoaded(data);
  const plug = plugs[0];
  const p = sim.player;
  teleport(p, 30, 0.02, 28.8);
  return { sim, data, plug, p, baked };
}

const tr = makeTrace();
/** Can a standing player fit in the plug's doorway? */
const open = (sim: Simulation) => !sim.world.testBox(tr, vec3(30, 0.05, 30.15), STAND_MINS, STAND_MAXS, MASK_PLAYER);

/** Facing the wall (+Z). */
function facing(): UserCmd {
  const cmd = makeCmd();
  cmd.yaw = cmd.attackYaw = Math.PI;
  return cmd;
}

function run(sim: Simulation, cmd: UserCmd, seconds: number): void {
  for (let t = 0; t < seconds; t += sim.dt) {
    sim.step(cmd);
    cmd.pressed = 0;
  }
}

/** Press E and keep holding it for `seconds`. */
function holdE(sim: Simulation, cmd: UserCmd, seconds: number): void {
  cmd.buttons |= Buttons.USE;
  cmd.pressed = Buttons.USE;
  run(sim, cmd, seconds);
}

describe('breaching charges', () => {
  it('are bought as gear, up to a carry limit', () => {
    const { sim, p } = setup();
    p.money = 5000;
    for (let i = 0; i < BREACH_MAX; i++) expect(buy(sim, p, 'breach', false)).toBe(true);
    expect(p.breachCharges).toBe(BREACH_MAX);
    expect(buy(sim, p, 'breach', false)).toBe(false);
    expect(sim.events.drain().some((e) => e.type === 'buy' && !e.ok && e.reason?.startsWith('Carrying'))).toBe(true);
  });

  it('go on the wall with E held, then blow the plug out and hurt whoever is near', () => {
    const { sim, data, plug, p } = setup();
    p.breachCharges = 1;
    const near = sim.spawnDummy(30, 0.05, 32, 0);
    const far = sim.spawnDummy(30, 0.05, 30 + BREACH_RADIUS + 2.5, 0);
    const cmd = facing();
    run(sim, cmd, 0.2);
    holdE(sim, cmd, PLANT_TIME + 0.1);
    expect(p.breachCharges).toBe(0);
    expect(sim.charges.active).toHaveLength(1);
    expect(sim.events.drain().some((e) => e.type === 'plant' && e.phase === 'done')).toBe(true);
    expect(open(sim)).toBe(false);

    cmd.buttons = 0;
    run(sim, cmd, BREACH_FUSE + 0.1);
    const events = sim.events.drain();
    expect(events.filter((e) => e.type === 'breach_beep').length).toBeGreaterThan(4);
    expect(events.some((e) => e.type === 'breach_detonate')).toBe(true);
    expect(events.some((e) => e.type === 'piece_break' && e.kind === PieceKind.Breach && e.index === plug)).toBe(true);
    expect(sim.charges.active).toHaveLength(0);
    expect(sim.pieces.isBroken(data.key, plug)).toBe(true);
    expect(open(sim)).toBe(true);
    expect(near.health).toBeLessThan(100);
    expect(far.health).toBe(100);
    // Like an HE, it never hurts the one who set it.
    expect(p.health).toBe(100);
  });

  it('are kept when you let go of E before the charge is on', () => {
    const { sim, p } = setup();
    p.breachCharges = 1;
    const cmd = facing();
    run(sim, cmd, 0.2);
    holdE(sim, cmd, PLANT_TIME / 2);
    expect(p.plantEnd).toBeGreaterThan(0);
    cmd.buttons = 0;
    run(sim, cmd, 0.1);
    expect(p.plantEnd).toBe(-1);
    expect(p.breachCharges).toBe(1);
    expect(sim.charges.active).toHaveLength(0);
    expect(sim.events.drain().some((e) => e.type === 'plant' && e.phase === 'cancel')).toBe(true);
  });

  it('say so when you have none', () => {
    const { sim } = setup();
    const cmd = facing();
    run(sim, cmd, 0.2);
    holdE(sim, cmd, 0.1);
    expect(sim.events.drain().some((e) => e.type === 'message' && e.text.includes('breaching'))).toBe(true);
    expect(sim.charges.active).toHaveLength(0);
  });

  it('go on a plug only once, even when two finish planting on it together', () => {
    const { sim, p } = setup();
    p.breachCharges = 1;
    const other = sim.spawnDummy(31, 0.05, 28.8, 0);
    const cmd = facing();
    run(sim, cmd, 0.2);
    holdE(sim, cmd, PLANT_TIME / 2);
    // Someone else gets theirs on first.
    sim.charges.plant(other, breachTarget(sim, p)!);
    run(sim, cmd, PLANT_TIME);
    expect(sim.charges.active).toHaveLength(1);
    expect(p.plantEnd).toBe(-1);
    expect(p.breachCharges).toBe(1);
  });

  it('open a way for bots: nav through the hole only once it is blown', () => {
    const { sim, data, plug } = setup();
    const astar = new AStar(sim.nav);
    const detour = (from: number, to: number) => {
      const res = astar.find(30, 0, from, 30, 0, to, 0, 0, { maxExpansions: 30000 })!;
      expect(res.complete).toBe(true);
      return Math.max(...res.points.map((q) => Math.abs(q.x - 30)));
    };
    // Around the end of the wall...
    expect(detour(26, 34)).toBeGreaterThan(9);
    sim.pieces.breakPiece(data.key, plug, true);
    // ...then straight through.
    expect(detour(26, 34)).toBeLessThan(1.5);
    // Standing again for a new game.
    sim.pieces.reset();
    expect(detour(26, 34)).toBeGreaterThan(9);
  });

  it('are matched by a point-blank HE, but not one a couple of meters off', () => {
    for (const [z, breaks] of [
      [30 - HE_BREACH_RADIUS + 0.3, true],
      [28, false],
    ] as const) {
      const { sim, data, plug, p } = setup();
      teleport(p, 30, 0.02, 20);
      const g = sim.grenades.throw(p, 'hegrenade', 1, 0, 0);
      g.pos.x = 30;
      g.pos.y = 0.05;
      g.pos.z = z;
      g.vel.x = g.vel.y = g.vel.z = 0;
      run(sim, makeCmd(), 2);
      expect(sim.pieces.isBroken(data.key, plug)).toBe(breaks);
    }
  });

  it('open only their own hole in the nav, never a nearby plug still standing', () => {
    // Two parallel walls 1.7 m apart, each with a plug at the same x: well within each other's patch.
    const w = new BrushWriter();
    w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
    const plugs: number[] = [];
    for (const z of [30, 32]) wall(w, true, 20, 40, z, z + 0.3, 0, 3, [breachOpening(() => 0.5, 29.25, Material.Brick)], Material.Brick, 120, SOLID, null, null, plugs);
    const baked = bakeNavWithPieces(w.finish(), plugs);
    /** Walkable flag at the floor under (x, z) once the patch of plug `k` is applied (or none). */
    const walkable = (x: number, z: number, k: number | null) => {
      const c = Math.floor(z / NAV_CELL) * NAV_RES + Math.floor(x / NAV_CELL);
      const s = baked.nav.col[c];
      expect(baked.nav.col[c + 1]).toBe(s + 1);
      let f = baked.nav.flags[s];
      if (k !== null) {
        for (let r = baked.ranges[k][0]; r < baked.ranges[k][1]; r++) if (baked.records[r * NAV_PATCH_STRIDE] === s) f = baked.records[r * NAV_PATCH_STRIDE + 3];
      }
      return (f & NavFlag.Walkable) !== 0;
    };
    const under = [30.15, 32.15];
    for (const k of [0, 1]) {
      expect(walkable(30, under[k], null)).toBe(false);
      expect(walkable(30, under[k], k)).toBe(true);
      expect(walkable(30, under[1 - k], k)).toBe(false);
    }
  });
});
