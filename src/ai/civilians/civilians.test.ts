import { describe, expect, it } from 'vitest';
import { TICK } from '../../core/config';
import { vec3 } from '../../core/math';
import { parseParams } from '../../core/urlParams';
import { makeCmd } from '../../input/UserCmd';
import { Contents, SOLID } from '../../physics/brush';
import { makeActor, Team, teleport } from '../../sim/Actor';
import { Simulation, type SimSystem } from '../../sim/Simulation';
import { WEAPONS } from '../../weapons/weaponDefs';
import { brushesFromPacked } from '../../world/chunkBrushes';
import { chunkKey } from '../../world/chunkMath';
import { BrushWriter } from '../../world/gen/BrushWriter';
import { Material, type ChunkData } from '../../world/gen/ChunkData';
import { generateChunk } from '../../world/gen/generateChunk';
import { bakeNav } from '../../world/gen/navBake';
import type { WorldStreamer } from '../../world/WorldStreamer';
import { CIV_FINE, MAX_CIVS, Pedestrians } from './Pedestrians';
import { Axis, cornerCoord, probeEdge, WALK_INSET } from './sidewalks';

const SEED = 1337;

/** The city chunks within `r` of (0, 0), loaded into a sim, with pedestrians running. */
function city(r = 2, opts: { opening?: boolean; hot?: (key: number) => boolean; seed?: number } = {}) {
  const sim = new Simulation(parseParams(`?seed=${opts.seed ?? SEED}`, 1), { autoBhop: false }, TICK);
  sim.envOverride = { hour: 13, weather: 'clear' };
  sim.updateEnv();
  const chunks = new Map<number, ChunkData>();
  for (let cz = -r; cz <= r; cz++) {
    for (let cx = -r; cx <= r; cx++) {
      const d = generateChunk(opts.seed ?? SEED, cx, cz);
      if (opts.opening) d.opening = true;
      chunks.set(d.key, d);
      sim.world.addChunk(d.key, brushesFromPacked(d.brushes, cx, cz, d.key));
      sim.nav.onChunkLoaded(d);
    }
  }
  const streamer = {
    resident: new Map([...chunks].map(([k, data]) => [k, { data, visible: true }])),
    getChunk: (cx: number, cz: number) => chunks.get(chunkKey(cx, cz)),
  } as unknown as WorldStreamer;
  const peds = new Pedestrians(sim, streamer, opts.hot);
  sim.systems.push(peds);
  teleport(sim.player, 32, sim.findFloor(32, 32, 30), 32);
  return { sim, peds, chunks };
}

function run(sim: Simulation, seconds: number): void {
  const idle = makeCmd();
  for (let i = 0; i < seconds / TICK; i++) sim.step(idle);
}

/** Distance from a point to the nearest walking line (all run at WALK_INSET in from a chunk edge). */
function offLine(x: number, z: number): number {
  const d = (v: number) => {
    const local = ((v % 64) + 64) % 64;
    return Math.min(Math.abs(local - WALK_INSET), Math.abs(local - (64 - WALK_INSET)));
  };
  return Math.min(d(x), d(z));
}

describe('sidewalk graph', () => {
  it('lays corners WALK_INSET in from each chunk edge', () => {
    expect(cornerCoord(0)).toBe(WALK_INSET);
    expect(cornerCoord(1)).toBe(64 - WALK_INSET);
    expect(cornerCoord(2)).toBe(64 + WALK_INSET);
    expect(cornerCoord(-1)).toBe(-WALK_INSET);
  });

  it('walks the city sidewalks, and not unloaded chunks or blocked ones', () => {
    const { sim } = city(1);
    const loaded = (cx: number, cz: number) => sim.nav.hasChunk(cx, cz);
    let ok = 0;
    for (let i = -2; i <= 2; i++) {
      for (const axis of [Axis.X, Axis.Z]) if (probeEdge(sim.world, loaded, i, i, axis)) ok++;
    }
    expect(ok).toBeGreaterThan(4);
    // Out past the loaded chunks: ask again later.
    expect(probeEdge(sim.world, loaded, 20, 0, Axis.X)).toBeUndefined();

    // A wall across a flat sidewalk line.
    const w = new BrushWriter();
    w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
    w.box(30, 0, 4, 31, 3, 7, Material.Concrete, SOLID);
    const brushes = w.finish();
    const flat = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
    flat.world.addChunk(chunkKey(0, 0), brushesFromPacked(brushes, 0, 0, chunkKey(0, 0)));
    const one = (cx: number, cz: number) => cx === 0 && cz === 0;
    expect(probeEdge(flat.world, one, 0, 0, Axis.X)).toBeNull();
    const clear = probeEdge(flat.world, one, 0, 0, Axis.Z)!;
    expect(clear.len).toBeCloseTo(64 - 2 * WALK_INSET);
    expect(bakeNav(brushes).col.length).toBeGreaterThan(0);
  });
});

describe('pedestrians', () => {
  it('fill the streets around the player up to the budget, and stay on the sidewalks', () => {
    const { sim, peds } = city();
    run(sim, 30);
    const target = peds.target();
    expect(target).toBeGreaterThan(0);
    expect(target).toBeLessThanOrEqual(MAX_CIVS);
    expect(peds.aliveCount).toBeGreaterThan(0);
    expect(peds.aliveCount).toBeLessThanOrEqual(target);
    for (const c of peds.civs) {
      const p = c.actor.move.pos;
      expect(c.actor.team).toBe(Team.Civilian);
      expect(offLine(p.x, p.z)).toBeLessThan(0.9);
      expect(p.y).toBeGreaterThan(-0.5);
      expect(p.y).toBeLessThan(0.7);
    }
    // They move.
    const before = peds.civs.map((c) => ({ c, x: c.actor.move.pos.x, z: c.actor.move.pos.z }));
    run(sim, 5);
    const moved = before.filter(({ c, x, z }) => c.state === 'walk' && Math.hypot(c.actor.move.pos.x - x, c.actor.move.pos.z - z) > 2);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('are the same for the same seed', () => {
    const a = city(1);
    const b = city(1);
    run(a.sim, 20);
    run(b.sim, 20);
    const pos = (p: Pedestrians) => p.civs.map((c) => [c.actor.move.pos.x.toFixed(3), c.actor.move.pos.z.toFixed(3)].join(','));
    expect(pos(a.peds).length).toBeGreaterThan(0);
    expect(pos(a.peds)).toEqual(pos(b.peds));
  });

  it('keep out of a fight and the waiting opening scene, and vanish when turned off', () => {
    expect(
      (() => {
        const { sim, peds } = city(1, { hot: () => true });
        run(sim, 10);
        return peds.aliveCount;
      })(),
    ).toBe(0);
    const { sim, peds } = city(1, { opening: true });
    run(sim, 10);
    expect(peds.aliveCount).toBe(0);
    for (const d of [0, 0.5]) {
      const w = city(1);
      w.peds.density = d;
      run(w.sim, 20);
      if (d === 0) expect(w.peds.aliveCount).toBe(0);
      else expect(w.peds.aliveCount).toBeLessThanOrEqual(Math.ceil(city(1).peds.target() / 2) + 1);
      w.peds.clear();
      expect(w.peds.civs.length).toBe(0);
      expect(w.sim.actors.some((a) => a.team === Team.Civilian)).toBe(false);
    }
  });

  it('run from gunfire and get away from it', () => {
    const { sim, peds } = city();
    run(sim, 30);
    const civ = peds.civs.find((c) => c.state === 'walk')!;
    expect(civ).toBeDefined();
    const at = civ.actor.move.pos;
    const shot = vec3(at.x + 6, at.y, at.z + 1);
    let fired = false;
    const gun: SimSystem = {
      update: (s) => {
        if (fired) return;
        fired = true;
        s.events.push({ type: 'sound', pos: shot, radius: 60, kind: 'gunshot', sourceId: sim.player.id });
      },
    };
    sim.systems.unshift(gun);
    run(sim, TICK);
    expect(civ.state).toBe('panic');
    const d0 = Math.hypot(civ.actor.move.pos.x - shot.x, civ.actor.move.pos.z - shot.z);
    run(sim, 3);
    const d1 = Math.hypot(civ.actor.move.pos.x - shot.x, civ.actor.move.pos.z - shot.z);
    expect(d1).toBeGreaterThan(d0 + 5);
    // Calm again in time.
    run(sim, 20);
    expect(['walk', 'wait']).toContain(civ.state);
  });

  it('fine a player who kills one, not a bot, and never below zero', () => {
    const { sim, peds } = city();
    run(sim, 30);
    const [a, b, c] = peds.civs;
    expect(c).toBeDefined();
    const p = sim.player;
    const def = WEAPONS.ak47;
    const kill = (attacker: typeof p, victim: typeof p) => {
      victim.health = 1;
      sim.onHit({ attacker, victim, def, group: 1, distance: 5, damageScale: 1, penetrated: false, pos: victim.move.pos });
    };
    p.money = 1000;
    kill(p, a.actor);
    expect(a.actor.alive).toBe(false);
    expect(p.money).toBe(1000 - CIV_FINE);
    expect(sim.events.drain().some((e) => e.type === 'message' && e.actorId === p.id)).toBe(true);
    const bot = makeActor(sim.newActorId(), 'bot', Team.Bots, 0, 0, 0);
    kill(bot, b.actor);
    expect(p.money).toBe(1000 - CIV_FINE);
    p.money = 100;
    kill(p, c.actor);
    expect(p.money).toBe(0);
    // Bodies go after a while.
    run(sim, 16);
    expect(peds.civs.includes(a)).toBe(false);
  });

  it('go when the players leave them far behind', () => {
    const { sim, peds } = city();
    run(sim, 30);
    expect(peds.aliveCount).toBeGreaterThan(0);
    teleport(sim.player, 5000, 0, 5000);
    run(sim, 2);
    expect(peds.civs.length).toBe(0);
  });
});
