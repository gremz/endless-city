import { describe, expect, it } from 'vitest';
import { TICK } from '../core/config';
import { vec3 } from '../core/math';
import { parseParams } from '../core/urlParams';
import { makeCmd } from '../input/UserCmd';
import { Contents, MASK_SHOT, Ramp, SOLID } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { makeActor, Team, teleport } from '../sim/Actor';
import { PickupManager } from '../sim/Pickups';
import { Simulation } from '../sim/Simulation';
import { addGrenades, makeInventory } from '../weapons/Inventory';
import { brushesFromPacked } from '../world/chunkBrushes';
import { chunkKey } from '../world/chunkMath';
import type { WorldStreamer } from '../world/WorldStreamer';
import { WEAPONS } from '../weapons/weaponDefs';
import { BrushWriter } from '../world/gen/BrushWriter';
import { Material, NAV_RES, type ChunkData } from '../world/gen/ChunkData';
import { bakeNav } from '../world/gen/navBake';
import { OPENING_CHUNK } from '../world/gen/encounters';
import { generateChunk } from '../world/gen/generateChunk';
import { SPAWN_DROP } from '../world/gen/pickups';
import { Bot, TargetHistory, type BotContext, type Squad } from './Bot';
import { skillFor } from './difficulty';
import { EncounterManager, hearingRadius } from './EncounterManager';
import { BARK_RANGE, bark } from './barks';
import { VOICE_BY_ID } from './voiceLines';
import { AStar, smooth } from './nav/astar';
import { NavGrid, toCell } from './nav/NavGrid';

/** A flat 64 m chunk at (0, 0) with optional extra boxes, loaded into a sim (collision + nav). */
function flatWorld(boxes: [number, number, number, number, number, number][] = [], build?: (w: BrushWriter) => void, ladders: number[] = []) {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  for (const b of boxes) w.box(b[0], b[1], b[2], b[3], b[4], b[5], Material.Concrete, SOLID);
  build?.(w);
  const brushes = w.finish();
  const nav = bakeNav(brushes, ladders);
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
    navCol: nav.col,
    navFloor: nav.floor,
    navFlags: nav.flags,
    navCover: nav.cover,
    navLinks: nav.links,
    spawns: new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    pickups: new Float32Array(0),
    vehicles: new Float32Array(0),
    doors: new Float32Array(0),
    glass: new Int32Array(0),
    hasEncounter: false as boolean,
    genMs: 0,
  } satisfies ChunkData;
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(data.key, brushesFromPacked(brushes, 0, 0, data.key));
  sim.nav.onChunkLoaded(data);
  return { sim, data };
}

/** Stairs (x 20..24.2 at z 30..31.5) up to a 3.5 m slab (x 24.2..40, z 26..38). */
function upperFloor(w: BrushWriter): void {
  w.stairs(20, 0, 30, 24.2, 3.5, 31.5, Ramp.PosX, Material.Wood);
  w.box(24.2, 3.25, 26, 40, 3.5, 38, Material.Wood, SOLID | Contents.FLOOR);
}

describe('A*', () => {
  it('finds a straight path on open ground', () => {
    const { sim } = flatWorld();
    const astar = new AStar(sim.nav);
    const res = astar.find(10, 0, 10, 50, 0, 50, 0, 0)!;
    expect(res.complete).toBe(true);
    // Smoothed to (nearly) a straight line.
    expect(res.points.length).toBeLessThanOrEqual(3);
  });

  it('routes around a wall, and smoothing never crosses blocked cells', () => {
    const { sim } = flatWorld([[30, 0, 5, 30.5, 3, 59]]);
    const astar = new AStar(sim.nav);
    const res = astar.find(20, 0, 32, 40, 0, 32, 0, 0)!;
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
    const res = astar.find(10, 0, 10, 45, 0, 45, 0, 0, { maxExpansions: 20000 });
    expect(res).not.toBeNull();
    expect(res!.complete).toBe(false);
  });

  it('does not climb steps higher than 0.45 m', () => {
    const { sim } = flatWorld([[20, 0, 0, 64, 0.6, 64]]);
    const astar = new AStar(sim.nav);
    const res = astar.find(10, 0, 32, 40, 0, 32, 0, 0, { maxExpansions: 30000 });
    expect(res!.complete).toBe(false);
  });

  it('paths up stairs to an upper floor, keeping the floor underneath walkable', () => {
    const { sim } = flatWorld([], upperFloor);
    // Two floors in one column under the slab.
    expect(sim.nav.near(toCell(32), toCell(32), 0, 0.1)).toBe(true);
    expect(sim.nav.near(toCell(32), toCell(32), 3.5, 0.1)).toBe(true);
    const astar = new AStar(sim.nav);
    const res = astar.find(10, 0, 31, 32, 3.5, 32, 0, 0, { maxExpansions: 30000 })!;
    expect(res.complete).toBe(true);
    const last = res.points[res.points.length - 1];
    expect(last.y).toBeCloseTo(3.5, 1);
    // It goes up the stairs: the polyline crosses x = 22 within the stairs' width.
    const pts = res.points;
    const k = pts.findIndex((p, i) => i > 0 && pts[i - 1].x < 22 && p.x >= 22);
    expect(k).toBeGreaterThan(0);
    const t = (22 - pts[k - 1].x) / (pts[k].x - pts[k - 1].x);
    const z = pts[k - 1].z + (pts[k].z - pts[k - 1].z) * t;
    expect(z).toBeGreaterThan(30);
    expect(z).toBeLessThan(31.5);
    // And a path that stays downstairs stays on the ground floor.
    const down = astar.find(10, 0, 31, 32, 0, 32, 0, 0, { maxExpansions: 30000 })!;
    expect(down.complete).toBe(true);
    expect(Math.max(...down.points.map((p) => p.y))).toBeLessThan(0.5);
  });

  it('smooth() keeps endpoints', () => {
    const nav = new NavGrid();
    expect(smooth(nav, [[0, 0, 0], [1, 1, 0]])).toEqual([[0, 0, 0], [1, 1, 0]]);
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

function makeBot(sim: Simulation, x: number, z: number, yaw: number, level = 5, shared?: Squad) {
  const squad: Squad = shared ?? {
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
  a.armor = skillFor(level).armor;
  a.yaw = yaw;
  teleport(a, x, 0.02, z);
  sim.addActor(a);
  const bot = new Bot(a, skillFor(level), squad, 'anchor', vec3(x, 0, z), [], 1);
  squad.members.push(bot);
  return bot;
}

function runBots(sim: Simulation, bots: Bot[], seconds: number) {
  const histories = new Map(sim.players.map((p) => [p.id, new TargetHistory()]));
  const ctx: BotContext = { sim, astar: new AStar(sim.nav), histories, pathBudget: 2 };
  const idle = makeCmd();
  for (let i = 0; i < seconds * 64; i++) {
    ctx.pathBudget = 2;
    sim.step(idle);
    for (const p of sim.players) histories.get(p.id)!.record(p, sim.tick);
    for (const b of bots) b.update(ctx);
  }
}

describe('barks', () => {
  /** Run the bots, collecting every line they say. */
  function listen(sim: Simulation, bots: Bot[], seconds: number, heard: { actorId: number; line: string }[]) {
    const histories = new Map(sim.players.map((p) => [p.id, new TargetHistory()]));
    const ctx: BotContext = { sim, astar: new AStar(sim.nav), histories, pathBudget: 2 };
    const idle = makeCmd();
    for (let i = 0; i < seconds * 64; i++) {
      ctx.pathBudget = 2;
      sim.step(idle);
      for (const p of sim.players) histories.get(p.id)!.record(p, sim.tick);
      for (const b of bots) b.update(ctx);
      for (const e of sim.events.drain()) if (e.type === 'voice') heard.push({ actorId: e.actorId, line: e.line });
    }
  }

  it('armoured bots sound like the cell, the rest like the gang', () => {
    const { sim } = flatWorld();
    expect(makeBot(sim, 10, 10, 0, 1).barks.voice).toMatch(/^gang/);
    expect(makeBot(sim, 12, 10, 0, 5).barks.voice).toMatch(/^cell/);
  });

  it('a squad shouts once on spotting the player', () => {
    const { sim } = flatWorld();
    teleport(sim.player, 32, 0.02, 20);
    const a = makeBot(sim, 30, 38, 0);
    const b = makeBot(sim, 34, 38, 0, 5, a.squad);
    a.squad.members.push(b);
    const heard: { actorId: number; line: string }[] = [];
    listen(sim, [a, b], 2, heard);
    const spotted = heard.filter((h) => VOICE_BY_ID.get(h.line)?.cue === 'spotted');
    expect(spotted).toHaveLength(1);
    const speaker = [a, b].find((x) => x.actor.id === spotted[0].actorId)!;
    expect(VOICE_BY_ID.get(spotted[0].line)!.voice).toBe(speaker.barks.voice);
  });

  it('one at a time, unless something more urgent cuts in', () => {
    const { sim } = flatWorld();
    teleport(sim.player, 32, 0.02, 20);
    const a = makeBot(sim, 30, 30, 0);
    const b = makeBot(sim, 34, 30, 0, 5, a.squad);
    a.squad.members.push(b);
    expect(bark(sim, a, 'spotted')).toBe(true);
    expect(bark(sim, b, 'blinded')).toBe(false);
    expect(bark(sim, b, 'incoming')).toBe(true);
    // Once they're done, the next line goes round to the next one.
    sim.time += 10;
    expect(bark(sim, a, 'manDown')).toBe(true);
    expect(sim.events.drain().filter((e) => e.type === 'voice').map((e) => (e as { line: string }).line)).toEqual([
      `${a.barks.voice}_spotted_1`,
      `${b.barks.voice}_incoming_1`,
      `${a.barks.voice}_manDown_1`,
    ]);
  });

  it('nobody barks with no player in earshot', () => {
    const { sim } = flatWorld();
    teleport(sim.player, 2, 0.02, 2);
    const a = makeBot(sim, 2 + BARK_RANGE + 1, 2, 0);
    expect(bark(sim, a, 'manDown')).toBe(false);
  });
});

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

describe('bots on several floors', () => {
  it('climb the stairs to investigate a noise upstairs', () => {
    // The player waits behind a wall, out of sight.
    const { sim } = flatWorld([[0, 0, 50, 64, 5, 51]], upperFloor);
    teleport(sim.player, 32, 0.02, 58);
    const bot = makeBot(sim, 10, 31, 0);
    bot.hear({ x: 34, y: 3.5, z: 32 }, 70, 0);
    runBots(sim, [bot], 10);
    expect(bot.actor.move.pos.y).toBeGreaterThan(3.3);
    expect(bot.actor.move.pos.x).toBeGreaterThan(25);
  });

  it('nav spans exist only where there is headroom', () => {
    const { data } = flatWorld([], upperFloor);
    // Right under the slab edge a bot has room (3.25 m ceiling); on the slab too.
    const c = toCell(30) * NAV_RES + toCell(30);
    expect(data.navCol[c + 1] - data.navCol[c]).toBe(2);
  });
});

/** A 6 m block (x 30..40, z 20..44) with a ladder up its -X wall at z = 32. */
function ladderBlock(w: BrushWriter): void {
  w.box(30, 0, 20, 40, 6, 44, Material.Concrete, SOLID | Contents.FLOOR);
  w.ladder(2, 30, 32, 0, 6);
}
const LADDER_LINK = [28.9, 0, 32, 31.1, 6, 32, -1, 0];

describe('bots and ladders', () => {
  it('path over a ladder link', () => {
    const { sim } = flatWorld([], ladderBlock, LADDER_LINK);
    const res = new AStar(sim.nav).find(10, 0, 32, 36, 6, 32, 0, 0, { maxExpansions: 30000 })!;
    expect(res.complete).toBe(true);
    const top = res.points.find((p) => p.ladder);
    expect(top).toBeDefined();
    expect(top!.y).toBeCloseTo(6, 1);
  });

  it('climb a ladder to investigate a noise on the roof', () => {
    const { sim } = flatWorld([[0, 0, 50, 64, 5, 51]], ladderBlock, LADDER_LINK);
    teleport(sim.player, 32, 0.02, 58);
    const bot = makeBot(sim, 10, 32, 0);
    bot.hear({ x: 36, y: 6, z: 32 }, 70, 0);
    runBots(sim, [bot], 12);
    expect(bot.actor.move.pos.y).toBeGreaterThan(5.9);
    expect(bot.actor.move.pos.x).toBeGreaterThan(30.5);
  });

  it('climb back down instead of jumping', () => {
    const { sim } = flatWorld([[0, 0, 50, 64, 5, 51]], ladderBlock, LADDER_LINK);
    teleport(sim.player, 32, 0.02, 58);
    const bot = makeBot(sim, 36, 32, Math.PI);
    teleport(bot.actor, 36, 6.02, 32);
    bot.hear({ x: 10, y: 0, z: 32 }, 70, 0);
    runBots(sim, [bot], 12);
    expect(bot.actor.move.pos.y).toBeLessThan(0.5);
    expect(bot.actor.move.pos.x).toBeLessThan(28);
    expect(bot.actor.health).toBe(100);
  });
});

describe('bots in landmark buildings', () => {
  it('climb the stair core of a generated apartment block to its top floor', () => {
    // Chunk (-1, -5) of seed 2024 has a 4-storey apartment block (see landmarks.ts).
    const d = generateChunk(2024, -1, -5);
    const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = dx || dz ? generateChunk(2024, d.cx + dx, d.cz + dz) : d;
        sim.world.addChunk(c.key, brushesFromPacked(c.brushes, c.cx, c.cz, c.key));
        sim.nav.onChunkLoaded(c);
        sim.doors.onChunkLoaded(c);
        sim.glass.onChunkLoaded(c);
      }
    }
    // The top floor's window spot (the roof is higher): only the stairs lead there.
    let top = -Infinity;
    for (let i = 1; i < d.perches.length; i += 3) top = Math.max(top, d.perches[i]);
    let target = { x: 0, y: -Infinity, z: 0 };
    for (let i = 0; i < d.perches.length; i += 3) {
      const y = d.perches[i + 1];
      if (y > target.y && y < top - 1) target = { x: d.perches[i], y, z: d.perches[i + 2] };
    }
    expect(target.y).toBeGreaterThan(7);
    // Nobody to see: the bot only follows the noise.
    teleport(sim.player, d.cx * 64 + 1, 0.02, d.cz * 64 + 1);
    sim.player.alive = false;
    const bot = makeBot(sim, d.cx * 64 + 2, d.cz * 64 + 32, 0);
    bot.squad.homeCx = d.cx;
    bot.squad.homeCz = d.cz;
    bot.hear(target, 200, 0);
    for (let t = 0; t < 60 && bot.actor.move.pos.y < target.y - 0.5; t += 2) {
      runBots(sim, [bot], 2);
      // Keep the noise going (an old one wears off and the bot loses interest).
      bot.hear(target, 200, sim.time);
    }
    expect(bot.actor.move.pos.y).toBeGreaterThan(target.y - 0.5);
  });
});

describe('fall damage', () => {
  function drop(height: number) {
    const { sim } = flatWorld();
    teleport(sim.player, 32, height, 32);
    const idle = makeCmd();
    for (let i = 0; i < 3 * 64; i++) sim.step(idle);
    return sim.player;
  }

  it('is free up to about 5 m, hurts from higher, and kills from about 17 m', () => {
    expect(drop(4.5).health).toBe(100);
    const hurt = drop(10);
    expect(hurt.health).toBeLessThan(70);
    expect(hurt.health).toBeGreaterThan(30);
    expect(drop(20).alive).toBe(false);
  });
});

describe('bots and grenades', () => {
  it('cannot see or shoot through smoke', () => {
    const { sim } = flatWorld();
    teleport(sim.player, 32, 0.02, 20);
    const bot = makeBot(sim, 32, 38, 0);
    sim.grenades.smokes.push({ id: 1, pos: vec3(32, 1.4, 29), start: sim.time - 2, end: sim.time + 60 });
    runBots(sim, [bot], 3);
    expect(bot.visible).toBe(false);
    expect(bot.actor.wpn.shotCounter).toBe(0);
  });

  it('do not fire while flashed, and recover', () => {
    const { sim } = flatWorld();
    teleport(sim.player, 32, 0.02, 20);
    const bot = makeBot(sim, 32, 38, 0);
    const a = bot.actor;
    a.flashStart = sim.time;
    a.flashUntil = sim.time + 4;
    a.flashPeak = 1;
    runBots(sim, [bot], 1.5);
    expect(a.wpn.shotCounter).toBe(0);
    runBots(sim, [bot], 5);
    expect(a.wpn.shotCounter).toBeGreaterThan(0);
  });

  it('walk around a fire instead of through it', () => {
    const { sim } = flatWorld([[10, 0, 10, 54, 4, 11]]);
    teleport(sim.player, 32, 0.02, 5);
    const bot = makeBot(sim, 32, 38, Math.PI);
    sim.grenades.fires.push({ id: 1, pos: vec3(32, 0, 26), radius: 3, start: sim.time, end: sim.time + 60, owner: sim.player, nextTick: Infinity });
    sim.grenades.fireVersion++;
    bot.hear(vec3(32, 0, 14), 70, 0);
    let closest = Infinity;
    for (let i = 0; i < 8 * 4; i++) {
      runBots(sim, [bot], 0.25);
      const p = bot.actor.move.pos;
      closest = Math.min(closest, Math.hypot(p.x - 32, p.z - 26));
    }
    // It got past the fire...
    expect(bot.actor.move.pos.z).toBeLessThan(22);
    // ...without stepping into it.
    expect(closest).toBeGreaterThan(2.9);
  });

  it('throw an HE at a player who ducked behind cover', () => {
    // Wall that hides the player's second spot but not the first.
    const { sim } = flatWorld([[28, 0, 25, 36, 3, 25.5]]);
    sim.player.health = 100000;
    teleport(sim.player, 40, 0.02, 22);
    const bot = makeBot(sim, 32, 38, 0, 8);
    addGrenades(bot.actor.inv, 'hegrenade', 1);
    runBots(sim, [bot], 1.2);
    expect(bot.visible).toBe(true);
    const seen = { ...sim.player.move.pos };
    teleport(sim.player, 32, 0.02, 22);
    sim.events.drain();
    runBots(sim, [bot], 6);
    const booms = sim.events.drain().filter((e) => e.type === 'nade_detonate');
    expect(booms).toHaveLength(1);
    const b = booms[0];
    if (b.type !== 'nade_detonate') throw new Error();
    expect(Math.hypot(b.pos.x - seen.x, b.pos.z - seen.z)).toBeLessThan(4.5);
    // Gun back in hand afterwards.
    expect(bot.actor.inv.active).not.toBe('grenade');
  });
});

describe('bots at night and in the rain', () => {
  // 50 m apart, away from the street lamps.
  function setup(hour: number, flashlight = false) {
    const { sim } = flatWorld();
    sim.envOverride = { hour, weather: 'clear' };
    sim.updateEnv();
    teleport(sim.player, 20, 0.02, 5);
    sim.player.flashlight = flashlight;
    const bot = makeBot(sim, 20, 55, 0, 5);
    runBots(sim, [bot], 2);
    return bot;
  }

  it('spot a far player at noon but not on a dark night', () => {
    expect(setup(12).awareness).toBeGreaterThan(0);
    expect(setup(1).awareness).toBe(0);
  });

  it('see a flashlight in the dark', () => {
    expect(setup(1, true).awareness).toBeGreaterThan(0);
  });

  it('hear footsteps less in the rain, gunfire the same', () => {
    expect(hearingRadius('footstep', 18, 1)).toBe(9);
    expect(hearingRadius('footstep', 18, 0)).toBe(18);
    expect(hearingRadius('gunshot', 70, 1)).toBe(70);
  });
});

describe('co-op', () => {
  it('bots turn on another player when their target dies', () => {
    const { sim } = flatWorld();
    const p1 = sim.player;
    const p2 = sim.addPlayer('Two');
    teleport(p1, 32, 0.02, 20);
    teleport(p2, 27, 0.02, 22);
    const bot = makeBot(sim, 32, 38, 0);
    runBots(sim, [bot], 1);
    const first = bot.target!;
    expect(first).not.toBeNull();
    const other = first === p1 ? p2 : p1;
    other.health = 100000;
    const otherHealth = other.health;
    first.alive = false;
    first.health = 0;
    runBots(sim, [bot], 3);
    expect(bot.target).toBe(other);
    expect(bot.state).not.toBe('idle');
    expect(other.health).toBeLessThan(otherHealth);
  });

  it('an encounter wakes up for any player, pays the shooter per kill and everyone for the clear', () => {
    // Players south of a wall, the encounter's spawn slots north of it.
    const { sim, data } = flatWorld([[0, 0, 20, 64, 4, 20.5]]);
    data.hasEncounter = true;
    data.spawns = new Float32Array([20, 0.02, 45, 30, 0.02, 45, 40, 0.02, 45, 50, 0.02, 45]);
    const streamer = {
      resident: new Map([[data.key, { data, visible: true }]]),
      getChunk: () => data,
    } as unknown as WorldStreamer;
    const enc = new EncounterManager(sim, streamer);
    sim.systems.push(enc);
    const p1 = sim.player;
    const p2 = sim.addPlayer('Two');
    // The first player is far away; the second one is close enough to wake the squad.
    teleport(p1, 500, 0.02, 500);
    p1.alive = false;
    teleport(p2, 32, 0.02, 5);
    const idle = makeCmd();
    for (let i = 0; i < 32; i++) sim.step(idle);
    expect(enc.aliveCount).toBeGreaterThan(0);

    const start1 = p1.money;
    const start2 = p2.money;
    const def = WEAPONS.ak47;
    let kills = 0;
    for (const b of [...enc.bots]) {
      b.actor.health = 1;
      b.actor.armor = 0;
      sim.onHit({ attacker: p2, victim: b.actor, def, group: 0, distance: 5, damageScale: 1, penetrated: false, pos: b.actor.move.pos });
      kills++;
    }
    expect(enc.isCleared(data.key)).toBe(true);
    const bonus = 500 + 200 * data.level;
    expect(p1.money - start1).toBe(bonus);
    expect(p2.money - start2).toBe(Math.min(bonus + kills * def.killReward, 16000 - start2));
  });

  it('an area whose remaining bots have nowhere hidden to appear counts as cleared', () => {
    // A wall hides one slot from the player; the other is in plain sight. Two bots, one wave of one.
    const { sim, data } = flatWorld([[0, 0, 20, 30, 4, 20.5]]);
    data.hasEncounter = true;
    data.spawns = new Float32Array([10, 0.02, 45, 60, 0.02, 30]);
    const streamer = { resident: new Map([[data.key, { data, visible: true }]]), getChunk: () => data } as unknown as WorldStreamer;
    const enc = new EncounterManager(sim, streamer);
    sim.systems.push(enc);
    const p = sim.player;
    teleport(p, 10, 0.02, 5);
    const idle = makeCmd();
    for (let i = 0; i < 32; i++) sim.step(idle);
    expect(enc.aliveCount).toBe(1);
    const bot = enc.bots[0];
    bot.actor.health = 1;
    bot.actor.armor = 0;
    sim.onHit({ attacker: p, victim: bot.actor, def: WEAPONS.ak47, group: 0, distance: 5, damageScale: 1, penetrated: false, pos: bot.actor.move.pos });
    expect(enc.isCleared(data.key)).toBe(false);
    // Standing in the open where both slots are in sight: the second bot can never come in.
    teleport(p, 50, 0.02, 40);
    p.health = 100000;
    const until = (t: number) => {
      while (sim.time < t) sim.step(idle);
    };
    until(sim.time + 5);
    expect(enc.aliveCount).toBe(0);
    expect(enc.isCleared(data.key)).toBe(false);
    until(sim.time + 12);
    expect(enc.isCleared(data.key)).toBe(true);
    expect(enc.summaries().find((e) => e.key === data.key)?.cleared).toBe(true);
  });

  it('squads only forget and heal once every player is down', () => {
    const { sim, data } = flatWorld([[0, 0, 20, 64, 4, 20.5]]);
    data.hasEncounter = true;
    data.spawns = new Float32Array([20, 0.02, 45, 30, 0.02, 45, 40, 0.02, 45]);
    const streamer = { resident: new Map([[data.key, { data, visible: true }]]), getChunk: () => data } as unknown as WorldStreamer;
    const enc = new EncounterManager(sim, streamer);
    sim.systems.push(enc);
    const p1 = sim.player;
    const p2 = sim.addPlayer('Two');
    teleport(p1, 30, 0.02, 5);
    teleport(p2, 34, 0.02, 5);
    const idle = makeCmd();
    for (let i = 0; i < 32; i++) sim.step(idle);
    const bot = enc.bots[0];
    bot.actor.health = 40;
    bot.awareness = 1;
    bot.target = p1;
    const kill = (victim: typeof p1) => {
      victim.health = 1;
      victim.armor = 0;
      sim.onHit({ attacker: bot.actor, victim, def: WEAPONS.ak47, group: 0, distance: 5, damageScale: 1, penetrated: false, pos: victim.move.pos });
    };
    kill(p1);
    expect(bot.target).toBeNull();
    expect(bot.awareness).toBe(1);
    expect(bot.actor.health).toBe(40);
    kill(p2);
    expect(bot.awareness).toBe(0);
    expect(bot.actor.health).toBe(100);
  });
});

describe('opening ambush', () => {
  /** The 3×3 chunks around spawn plus the row beyond the opening chunk, generated and loaded. */
  function openingCity(seed: number) {
    const sim = new Simulation(parseParams(`?seed=${seed}`, seed), { autoBhop: false }, TICK);
    const resident = new Map<number, { data: ChunkData; visible: boolean }>();
    for (let cz = -1; cz <= 2; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        const c = generateChunk(sim.params.seed, cx, cz);
        sim.world.addChunk(c.key, brushesFromPacked(c.brushes, c.cx, c.cz, c.key));
        sim.nav.onChunkLoaded(c);
        sim.doors.onChunkLoaded(c);
        sim.glass.onChunkLoaded(c);
        resident.set(c.key, { data: c, visible: true });
      }
    }
    const streamer = {
      resident,
      getChunk: (cx: number, cz: number) => resident.get(chunkKey(cx, cz))?.data,
    } as unknown as WorldStreamer;
    const enc = new EncounterManager(sim, streamer);
    const pickups = new PickupManager(sim);
    sim.systems.push(enc, pickups);
    const p = sim.player;
    teleport(p, SPAWN_DROP.x, sim.findFloor(SPAWN_DROP.x, SPAWN_DROP.z, 20), SPAWN_DROP.z);
    p.yaw = Math.PI;
    return { sim, enc, pickups, p, opening: resident.get(chunkKey(OPENING_CHUNK.cx, OPENING_CHUNK.cz))!.data };
  }

  for (const seed of [1, 7, 1337, 2024, 90210]) {
    it(`puts an unaware pair (one MP9, one knife) in view of the drop-in point (seed ${seed})`, () => {
      const { sim, enc, pickups, p, opening } = openingCity(seed);
      expect(opening.opening && opening.hasEncounter).toBe(true);
      const idle = makeCmd();
      for (let i = 0; i < 32; i++) sim.step(idle);
      expect(enc.bots.length).toBe(2);
      const eye = vec3(p.move.pos.x, p.move.pos.y + 1.6, p.move.pos.z);
      const tr = makeTrace();
      expect(enc.bots.map((b) => b.actor.inv.primary?.def.id ?? 'knife').sort()).toEqual(['knife', 'mp9']);
      for (const b of enc.bots) {
        const a = b.actor;
        expect(a.inv.secondary).toBeNull();
        expect(b.skill.reaction).toBeGreaterThan(skillFor(0).reaction);
        expect(b.state).toBe('idle');
        expect(b.awareness).toBe(0);
        const dx = a.move.pos.x - eye.x;
        const dz = a.move.pos.z - eye.z;
        expect(Math.hypot(dx, dz)).toBeGreaterThan(20);
        // Looking away from the plaza, or at the hostage (the shover, from the side).
        if (b.scene?.role === 'shover') continue;
        const away = Math.atan2(-dx, -dz);
        let off = a.yaw - away;
        while (off > Math.PI) off -= Math.PI * 2;
        while (off < -Math.PI) off += Math.PI * 2;
        // The gunman may stand side-on to the hostage, but never facing the plaza.
        expect(Math.abs(off)).toBeLessThan(b.scene ? (110 * Math.PI) / 180 : Math.PI / 3);
        sim.world.traceRay(tr, eye, vec3(a.move.pos.x, a.move.pos.y + 1.2, a.move.pos.z), MASK_SHOT);
        expect(tr.fraction).toBeGreaterThan(0.999);
      }
      // A captured officer kneels between them, in view, on the players' side but not a player.
      const h = enc.hostage!;
      expect(h).toBeTruthy();
      expect(h.actor.captive && h.actor.team === Team.Player).toBe(true);
      expect(sim.players).not.toContain(h.actor);
      expect(h.actor.move.ducked).toBe(true);
      sim.world.traceRay(tr, eye, vec3(h.actor.move.pos.x, h.actor.move.pos.y + 0.9, h.actor.move.pos.z), MASK_SHOT);
      expect(tr.fraction).toBeGreaterThan(0.999);
      expect(enc.bots.map((b) => b.scene?.role).sort()).toEqual(['gunman', 'shover']);
      expect(enc.bots.find((b) => b.scene?.role === 'gunman')!.actor.inv.primary?.def.id).toBe('mp9');
      // The fuse is lit: the player is in range.
      expect(h.executeAt).toBeGreaterThan(0);
      // Standing still at the drop-in for a while doesn't give you away.
      for (let i = 0; i < 64 * 5; i++) sim.step(idle);
      for (const b of enc.bots) expect(b.state).toBe('idle');
      // Nobody but his executioner can hurt him: not the player, not the shover's swings.
      expect(h.actor.health).toBe(100);
      expect(sim.canHit(p, h.actor)).toBe(false);
      expect(sim.canHit(enc.bots[0].actor, h.actor)).toBe(false);
      // Taking the pair out frees him (below), paying a rescue reward.
      const money = p.money;

      // The MP9 stays on the ground; nothing else drops.
      for (const b of [...enc.bots]) {
        b.actor.health = 1;
        sim.onHit({ attacker: p, victim: b.actor, def: WEAPONS.glock, group: 0, distance: 30, damageScale: 1, penetrated: false, pos: b.actor.move.pos });
      }
      expect(enc.isCleared(opening.key)).toBe(true);
      sim.step(idle);
      expect(h.phase).toBe('freed');
      expect(h.actor.alive).toBe(true);
      expect(p.money).toBeGreaterThan(money);
      sim.events.drain();
      for (let i = 0; i < 128; i++) sim.step(idle);
      expect(sim.events.drain().some((e) => e.type === 'voice' && e.line === 'officer_thanks_1' && e.actorId === h.actor.id)).toBe(true);
      expect(h.actor.move.ducked).toBe(false);
      const guns = pickups.items.filter((it) => it.item.kind === 'weapon');
      expect(guns.map((it) => it.item.kind === 'weapon' && it.item.weapon)).toEqual(['mp9']);
      expect(guns[0].expiresAt).toBe(Infinity);
    });
  }

  for (const seed of [1, 7, 1337, 2024, 90210]) {
    it(`shoots the hostage when the fuse runs out, and the pair stay unaware (seed ${seed})`, () => {
      const { sim, enc } = openingCity(seed);
      const idle = makeCmd();
      const kinds: string[] = [];
      const lines: string[] = [];
      const hear = () => {
        for (const e of sim.events.drain()) {
          kinds.push(e.type === 'captive' ? `captive:${e.phase}` : e.type);
          if (e.type === 'voice') lines.push(e.line);
        }
      };
      for (let i = 0; i < 32; i++) sim.step(idle);
      const h = enc.hostage!;
      const due = h.executeAt;
      while (sim.time < due - 0.5) {
        sim.step(idle);
        hear();
      }
      expect(h.actor.alive).toBe(true);
      // The scene talks: taunts and pleas, the gunman's warning and his last words, in that order.
      expect(lines.some((l) => l.startsWith('shover_taunt'))).toBe(true);
      expect(lines.some((l) => l.startsWith('officer_plead'))).toBe(true);
      expect(lines.slice(-2)).toEqual(['gunman_warn_1', 'gunman_execute_1']);
      for (const l of lines) expect(VOICE_BY_ID.has(l)).toBe(true);
      while (sim.time < due + 3) {
        sim.step(idle);
        hear();
      }
      // And the shover gloats.
      expect(lines.at(-1)).toBe('shover_after_1');
      expect(h.actor.alive).toBe(false);
      expect(h.phase).toBe('executed');
      expect(kinds).toContain('captive:executed');
      expect(kinds).toContain('kill');
      for (const b of enc.bots) {
        expect(b.state).toBe('idle');
        expect(b.scene).toBeNull();
      }
      // The body's cleared away with nothing dropped.
      while (sim.time < due + 16) sim.step(idle);
      expect(enc.hostage).toBeNull();
      expect(sim.actors.some((a) => a.captive)).toBe(false);
    });
  }

  it('a bot that notices the player drops its part in the scene, and the hostage stays safe', () => {
    const { sim, enc, p } = openingCity(7);
    const idle = makeCmd();
    for (let i = 0; i < 32; i++) sim.step(idle);
    const h = enc.hostage!;
    const gunman = enc.bots.find((b) => b.scene?.role === 'gunman')!;
    sim.events.drain();
    gunman.onDamaged(p, sim.time);
    for (let i = 0; i < 8; i++) sim.step(idle);
    expect(gunman.scene).toBeNull();
    // He shouts, even if someone else was talking.
    expect(sim.events.drain().some((e) => e.type === 'voice' && e.line === 'gunman_spotted_1')).toBe(true);
    // Long past the fuse: the gunman went after the player instead.
    h.executeAt = sim.time;
    for (let i = 0; i < 64 * 2; i++) sim.step(idle);
    expect(h.actor.alive).toBe(true);
  });

  it('only the opening chunk near spawn has bots', () => {
    for (const seed of [1, 7, 1337]) {
      for (let cz = -1; cz <= 1; cz++) {
        for (let cx = -1; cx <= 1; cx++) {
          const d = generateChunk(seed, cx, cz);
          expect(d.hasEncounter).toBe(cx === OPENING_CHUNK.cx && cz === OPENING_CHUNK.cz);
        }
      }
    }
  });
});

describe('bots with only a knife', () => {
  it('run at the player and stab once in reach', () => {
    const { sim } = flatWorld();
    teleport(sim.player, 32, 0.02, 20);
    const bot = makeBot(sim, 32, 34, 0, 0);
    bot.actor.inv = makeInventory(null);
    runBots(sim, [bot], 6);
    const d = Math.hypot(bot.actor.move.pos.x - 32, bot.actor.move.pos.z - 20);
    expect(d).toBeLessThan(2.5);
    expect(sim.player.health).toBeLessThan(100);
  });
});
