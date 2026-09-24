import { describe, expect, it } from 'vitest';
import { EncounterManager } from '../ai/EncounterManager';
import { TICK } from '../core/config';
import { parseParams } from '../core/urlParams';
import { makeCmd } from '../input/UserCmd';
import { Contents, SOLID } from '../physics/brush';
import { addGrenades, grenadeTotal, makeInventory } from '../weapons/Inventory';
import { brushesFromPacked } from '../world/chunkBrushes';
import { chunkKey } from '../world/chunkMath';
import { BrushWriter } from '../world/gen/BrushWriter';
import { Material, type ChunkData } from '../world/gen/ChunkData';
import type { WorldStreamer } from '../world/WorldStreamer';
import { makeActor, Team } from './Actor';
import { PACK_RESPAWN, PickupManager } from './Pickups';
import { applyPlayerSave, applyWorldSave, captureSave, paramsFromSave, SAVE_VERSION, validateSave, type SaveData } from './save';
import { Simulation } from './Simulation';

/** A flat chunk at (0, 0) with a health pack at (5, 5). */
function chunk(): ChunkData {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  return {
    cx: 0,
    cz: 0,
    key: chunkKey(0, 0),
    seed: 1,
    brushes: w.finish(),
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
    pickups: new Float32Array([5, 0.02, 5]),
    vehicles: new Float32Array(0),
    hasEncounter: false,
    genMs: 0,
  };
}

const noStreamer = { resident: new Map(), getChunk: () => undefined } as unknown as WorldStreamer;

function world(search = '?seed=abc') {
  const sim = new Simulation(parseParams(search, 1), { autoBhop: false }, TICK);
  const pickups = new PickupManager(sim);
  const encounters = new EncounterManager(sim, noStreamer);
  sim.systems.push(pickups);
  return { sim, pickups, encounters };
}

function load(sim: Simulation, pickups: PickupManager): ChunkData {
  const data = chunk();
  sim.world.addChunk(data.key, brushesFromPacked(data.brushes, 0, 0, data.key));
  pickups.onChunkLoaded(data);
  return data;
}

/** A run in progress: gear, money, a cleared area, a taken pack, a stash and a half-fought squad. */
function played(): { save: SaveData; time: number } {
  const { sim, pickups, encounters } = world();
  load(sim, pickups);
  const p = sim.player;
  p.move.pos.x = 5;
  p.move.pos.z = 5;
  p.move.pos.y = 0.05;
  for (let i = 0; i < 20; i++) sim.step(makeCmd()); // takes the pack
  expect(p.medkits).toBe(1);
  // Die once (stash), then come back with new gear.
  p.inv = makeInventory('deagle', 'ak47');
  const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 30, 0.05, 30);
  p.alive = false;
  pickups.onHit(sim, { attacker: bot, victim: p, def: bot.inv.secondary!.def, group: 0, distance: 5, damageScale: 1, penetrated: false, pos: p.move.pos }, true);
  sim.respawnPlayer(sim.player, 40, 40);
  p.inv = makeInventory('glock', 'm4a4');
  p.inv.primary!.clip = 11;
  p.inv.primary!.reserve = 33;
  p.inv.active = 'primary';
  addGrenades(p.inv, 'flashbang', 2);
  addGrenades(p.inv, 'hegrenade', 1);
  p.health = 64;
  p.armor = 80;
  p.helmet = true;
  p.medkits = 2;
  p.yaw = 1.25;
  p.pitch = -0.2;
  sim.player.money = 4321;
  sim.cleared.add(chunkKey(1, 0));
  encounters.restore([
    { key: chunkKey(1, 0), level: 1, cleared: true, remaining: 0, spawnedOnce: true },
    { key: chunkKey(2, 0), level: 2, cleared: false, remaining: 2, spawnedOnce: true },
  ]);
  const save = JSON.parse(JSON.stringify(captureSave(sim, sim.player, pickups, encounters, null, [chunkKey(0, 0), chunkKey(1, 0)], 1234))) as unknown;
  const valid = validateSave(save);
  expect(valid).not.toBeNull();
  return { save: valid!, time: sim.time };
}

describe('save games', () => {
  it('round-trips the player, progress and items', () => {
    const { save, time } = played();
    const params = paramsFromSave(save, parseParams('?debug', 99));
    expect(params).toMatchObject({ seed: save.seed, seedText: 'abc', world: 'city', debug: true });

    const { sim, pickups, encounters } = world(`?seed=${save.seedText}`);
    applyWorldSave(save, sim, pickups, encounters, null, sim.player.id);
    load(sim, pickups);
    applyPlayerSave(save.player, sim.player, save.money);
    const p = sim.player;

    expect(sim.time).toBe(time);
    expect(sim.player.money).toBe(4321);
    expect([...sim.cleared]).toEqual([chunkKey(1, 0)]);
    expect(p).toMatchObject({ alive: true, health: 64, armor: 80, helmet: true, medkits: 2, yaw: 1.25, pitch: -0.2 });
    expect(p.inv.active).toBe('primary');
    expect(p.inv.primary).toMatchObject({ clip: 11, reserve: 33 });
    expect(p.inv.primary!.def.id).toBe('m4a4');
    expect(p.inv.secondary!.def.id).toBe('glock');
    expect(p.inv.nades).toMatchObject({ flashbang: 2, hegrenade: 1, smokegrenade: 0, molotov: 0 });
    expect(p.inv.grenade).not.toBeNull();
    expect(save.player).toMatchObject({ x: 40, z: 40 });

    // The taken pack stays gone until its timer runs out.
    expect(pickups.items.filter((i) => i.slot >= 0)).toHaveLength(0);
    expect(save.pickups.taken).toHaveLength(1);
    expect(save.pickups.taken[0][1]).toBeGreaterThan(time + PACK_RESPAWN - 1);
    // The stash is still where the player died, and still never expires.
    const stash = pickups.items.filter((i) => i.stash);
    expect(stash.map((i) => i.item.kind === 'weapon' && i.item.weapon).sort()).toEqual(['ak47', 'deagle', false]);
    expect(stash.every((i) => i.expiresAt === Infinity)).toBe(true);
    expect(pickups.stashPos(sim.player.id)!.x).toBeCloseTo(5, 0);

    expect(encounters.isCleared(chunkKey(1, 0))).toBe(true);
    expect(encounters.states.get(chunkKey(2, 0))).toMatchObject({ remaining: 2, cleared: false, level: 2, cx: 2, cz: 0 });
    expect(save.explored).toEqual([chunkKey(0, 0), chunkKey(1, 0)]);
  });

  it('rejects saves it cannot trust', () => {
    const { save } = played();
    const edit = (fn: (s: Record<string, any>) => void) => {
      const s = JSON.parse(JSON.stringify(save));
      fn(s);
      return validateSave(s);
    };
    expect(validateSave(null)).toBeNull();
    expect(validateSave('save')).toBeNull();
    expect(edit((s) => (s.version = SAVE_VERSION + 1))).toBeNull();
    expect(edit((s) => (s.player.primary.id = 'bfg'))).toBeNull();
    expect(edit((s) => (s.player.primary.id = 'glock'))).toBeNull(); // wrong slot
    expect(edit((s) => (s.player.x = 'far'))).toBeNull();
    expect(edit((s) => (s.pickups.drops[0].item = { kind: 'weapon', weapon: 'knife', clip: 0, reserve: 0 }))).toBeNull();
    expect(edit((s) => delete s.cleared)).toBeNull();
  });

  it('loads older saves without grenades, and grenade drops', () => {
    const { save } = played();
    const s = JSON.parse(JSON.stringify(save));
    delete s.player.grenades;
    s.pickups.drops.push({ item: { kind: 'grenade', grenade: 'molotov', count: 1 }, pos: [1, 0, 1], yaw: 0, stash: false, expiresAt: 99 });
    const v = validateSave(s)!;
    expect(v).not.toBeNull();
    expect(v.pickups.drops.at(-1)!.item).toEqual({ kind: 'grenade', grenade: 'molotov', count: 1 });
    const { sim } = world();
    applyPlayerSave(v.player, sim.player, v.money);
    expect(grenadeTotal(sim.player.inv)).toBe(0);
    expect(sim.player.inv.grenade).toBeNull();
    // A save can't smuggle in more grenades than you can carry.
    s.player.grenades = { flashbang: 9, hegrenade: 9, smokegrenade: 9, molotov: 9 };
    applyPlayerSave(validateSave(s)!.player, sim.player, 0);
    expect(grenadeTotal(sim.player.inv)).toBe(4);
  });

  it('clamps values that are out of range', () => {
    const { save } = played();
    const s = JSON.parse(JSON.stringify(save));
    s.money = 1e9;
    s.player.health = 500;
    s.player.medkits = 40;
    s.player.primary.reserve = 9999;
    const v = validateSave(s)!;
    expect(v.money).toBe(16000);
    expect(v.player.health).toBe(100);
    expect(v.player.medkits).toBe(3);
    expect(v.player.primary!.reserve).toBe(90);
  });
});
