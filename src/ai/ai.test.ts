import { describe, expect, it } from 'vitest';
import { TICK } from '../core/config';
import { vec3 } from '../core/math';
import { parseParams } from '../core/urlParams';
import { makeCmd } from '../input/UserCmd';
import { Contents, SOLID } from '../physics/brush';
import { makeActor, Team, teleport } from '../sim/Actor';
import { Simulation } from '../sim/Simulation';
import { makeInventory } from '../weapons/Inventory';
import { brushesFromPacked } from '../world/chunkBrushes';
import { chunkKey } from '../world/chunkMath';
import { BrushWriter } from '../world/gen/BrushWriter';
import { Material, type ChunkData } from '../world/gen/ChunkData';
import { bakeNav } from '../world/gen/navBake';
import { Bot, TargetHistory, type BotContext, type Squad } from './Bot';
import { skillFor } from './difficulty';
import { AStar, smooth } from './nav/astar';
import { NavGrid } from './nav/NavGrid';

/** A flat 64 m chunk at (0, 0) with optional extra boxes, loaded into a sim (collision + nav). */
function flatWorld(boxes: [number, number, number, number, number, number][] = []) {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  for (const b of boxes) w.box(b[0], b[1], b[2], b[3], b[4], b[5], Material.Concrete, SOLID);
  const brushes = w.finish();
  const nav = bakeNav(brushes);
  const data = {
    cx: 0,
    cz: 0,
    key: chunkKey(0, 0),
    seed: 1,
    brushes,
    meshes: [],
    district: 0,
    level: 0,
    navFloor: nav.floor,
    navFlags: nav.flags,
    navCover: nav.cover,
    spawns: new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    hasEncounter: false,
    genMs: 0,
  } satisfies ChunkData;
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(data.key, brushesFromPacked(brushes, 0, 0, data.key));
  sim.nav.onChunkLoaded(data);
  return { sim, data };
}

describe('A*', () => {
  it('finds a straight path on open ground', () => {
    const { sim } = flatWorld();
    const astar = new AStar(sim.nav);
    const res = astar.find(10, 10, 100, 100, 0, 0)!;
    expect(res.complete).toBe(true);
    // Smoothed to (nearly) a straight line.
    expect(res.points.length).toBeLessThanOrEqual(3);
  });

  it('routes around a wall, and smoothing never crosses blocked cells', () => {
    const { sim } = flatWorld([[30, 0, 5, 30.5, 3, 59]]);
    const astar = new AStar(sim.nav);
    const res = astar.find(20, 32, 80, 64, 0, 0)!;
    expect(res.complete).toBe(true);
    const pts = res.points;
    expect(pts.length).toBeGreaterThan(2);
    // Walk the polyline in small steps: it must never enter the wall.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1);
      for (let k = 0; k <= n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const z = a.z + ((b.z - a.z) * k) / n;
        expect(x > 29.7 && x < 30.8 && z > 4.7 && z < 59.3).toBe(false);
      }
    }
  });

  it('returns a partial path when the goal is sealed off', () => {
    const { sim } = flatWorld([
      [40, 0, 40, 50, 3, 40.5],
      [40, 0, 49.5, 50, 3, 50],
      [40, 0, 40, 40.5, 3, 50],
      [49.5, 0, 40, 50, 3, 50],
    ]);
    const astar = new AStar(sim.nav);
    const res = astar.find(10, 10, 90, 90, 0, 0, { maxExpansions: 20000 });
    expect(res).not.toBeNull();
    expect(res!.complete).toBe(false);
  });

  it('does not climb steps higher than 0.45 m', () => {
    const { sim } = flatWorld([[20, 0, 0, 64, 0.6, 64]]);
    const astar = new AStar(sim.nav);
    const res = astar.find(10, 32, 80, 64, 0, 0, { maxExpansions: 30000 });
    expect(res!.complete).toBe(false);
  });

  it('smooth() keeps endpoints', () => {
    const nav = new NavGrid();
    expect(smooth(nav, [[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });
});

describe('difficulty', () => {
  it('scales monotonically with level', () => {
    let prev = skillFor(0);
    for (let l = 1; l <= 10; l++) {
      const s = skillFor(l);
      expect(s.reaction).toBeLessThan(prev.reaction);
      expect(s.aimError).toBeLessThan(prev.aimError);
      expect(s.headChance).toBeGreaterThan(prev.headChance);
      expect(s.visionRange).toBeGreaterThan(prev.visionRange);
      expect(s.squadSize).toBeGreaterThanOrEqual(prev.squadSize);
      prev = s;
    }
  });
});

function makeBot(sim: Simulation, x: number, z: number, yaw: number, level = 5) {
  const squad: Squad = {
    id: 1,
    chunkKey: chunkKey(0, 0),
    homeCx: 0,
    homeCz: 0,
    members: [],
    lastKnown: null,
    lastKnownTime: -100,
    calloutAt: Infinity,
    lastSeen: 0,
  };
  const a = makeActor(sim.newActorId(), 'Bot', Team.Bots, x, 0.02, z);
  a.inv = makeInventory('glock', 'ak47');
  a.yaw = yaw;
  teleport(a, x, 0.02, z);
  sim.addActor(a);
  const bot = new Bot(a, skillFor(level), squad, 'anchor', vec3(x, 0, z), [], 1);
  squad.members.push(bot);
  return bot;
}

function runBots(sim: Simulation, bots: Bot[], seconds: number) {
  const ctx: BotContext = { sim, astar: new AStar(sim.nav), history: new TargetHistory(), pathBudget: 2 };
  const idle = makeCmd();
  for (let i = 0; i < seconds * 64; i++) {
    ctx.pathBudget = 2;
    sim.step(idle);
    ctx.history.record(sim.player, sim.tick);
    for (const b of bots) b.update(ctx);
  }
}

describe('bots', () => {
  it('spot, react to and shoot a visible player', () => {
    const { sim } = flatWorld();
    teleport(sim.player, 32, 0.02, 20);
    // Bot 18 m away, facing the player.
    const bot = makeBot(sim, 32, 38, 0);
    runBots(sim, [bot], 0.8);
    expect(bot.awareness).toBeGreaterThanOrEqual(1);
    runBots(sim, [bot], 3);
    expect(bot.actor.wpn.shotCounter).toBeGreaterThan(0);
    expect(sim.player.health).toBeLessThan(100);
  });

  it('never shoot through walls', () => {
    const { sim } = flatWorld([[10, 0, 28, 54, 4, 29]]);
    teleport(sim.player, 32, 0.02, 20);
    const bot = makeBot(sim, 32, 38, 0);
    runBots(sim, [bot], 3);
    expect(bot.visible).toBe(false);
    expect(bot.actor.wpn.shotCounter).toBe(0);
    expect(sim.player.health).toBe(100);
  });

  it('investigate gunshots they hear', () => {
    const { sim } = flatWorld([[10, 0, 28, 54, 4, 29]]);
    teleport(sim.player, 32, 0.02, 20);
    const bot = makeBot(sim, 32, 38, Math.PI);
    bot.hear(vec3(32, 0, 20), 70, 0);
    runBots(sim, [bot], 0.5);
    expect(bot.state).toBe('alert');
    expect(bot.lastKnown).not.toBeNull();
    const start = { ...bot.actor.move.pos };
    runBots(sim, [bot], 4);
    expect(Math.hypot(bot.actor.move.pos.x - start.x, bot.actor.move.pos.z - start.z)).toBeGreaterThan(3);
  });
});
