import { describe, expect, it } from 'vitest';
import { TICK } from '../core/config';
import { parseParams } from '../core/urlParams';
import { Buttons, makeCmd, type UserCmd } from '../input/UserCmd';
import { Contents, SOLID } from '../physics/brush';
import { brushesFromPacked } from '../world/chunkBrushes';
import { chunkKey } from '../world/chunkMath';
import { BrushWriter } from '../world/gen/BrushWriter';
import { Material, type ChunkData } from '../world/gen/ChunkData';
import { makeActor, Team, teleport, type Actor } from './Actor';
import { MEDKIT_HEAL, MEDKIT_MAX, MEDKIT_TIME } from './medkit';
import { DROP_LIFETIME, dropRoll, MAX_ITEMS, PACK_RESPAWN, PickupManager } from './Pickups';
import { addGrenades, grenadeTotal, makeInventory } from '../weapons/Inventory';
import { WEAPONS } from '../weapons/weaponDefs';
import { Simulation } from './Simulation';

/** A flat chunk at (0, 0) with health packs at the given (x, z) spots, and a sim standing on it. */
function setup(spots: [number, number][] = []) {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  const brushes = w.finish();
  const data = {
    cx: 0,
    cz: 0,
    key: chunkKey(0, 0),
    seed: 1,
    brushes,
    meshes: [],
    district: 0,
    level: 0,
    navFloor: new Int16Array(0),
    navFlags: new Uint8Array(0),
    navCover: new Uint8Array(0),
    spawns: new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    pickups: new Float32Array(spots.flatMap(([x, z]) => [x, 0.02, z])),
    hasEncounter: false,
    genMs: 0,
  } satisfies ChunkData;
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(data.key, brushesFromPacked(brushes, 0, 0, data.key));
  const pickups = new PickupManager(sim);
  sim.systems.push(pickups);
  pickups.onChunkLoaded(data);
  teleport(sim.player, 5, 0.05, 5);
  return { sim, data, pickups };
}

function run(sim: Simulation, seconds: number, cmd: UserCmd = makeCmd()): void {
  const n = Math.round(seconds / sim.dt);
  for (let i = 0; i < n; i++) sim.step(cmd);
}

function press(sim: Simulation, button: number): void {
  const cmd = makeCmd();
  cmd.buttons = button;
  cmd.pressed = button;
  sim.step(cmd);
}

const eventsOf = (sim: Simulation, type: string) => sim.events.drain().filter((e) => e.type === type);

function killInfo(attacker: Actor, victim: Actor) {
  const def = attacker.inv.secondary?.def ?? attacker.inv.knife.def;
  return { attacker, victim, def, group: 0, distance: 5, damageScale: 1, penetrated: false, pos: victim.move.pos };
}

const weaponsOnGround = (pickups: PickupManager) => pickups.items.filter((p) => p.item.kind === 'weapon');

describe('health pack pickups', () => {
  it('collects a pack in reach and leaves one out of reach', () => {
    const { sim, pickups } = setup([
      [5.5, 5],
      [9, 5],
    ]);
    run(sim, 0.1);
    expect(sim.player.medkits).toBe(1);
    expect(pickups.items).toHaveLength(1);
    expect(eventsOf(sim, 'pickup')).toHaveLength(1);
  });

  it(`won't carry more than ${MEDKIT_MAX}`, () => {
    const { sim, pickups } = setup([[5, 5]]);
    sim.player.medkits = MEDKIT_MAX;
    run(sim, 0.5);
    expect(sim.player.medkits).toBe(MEDKIT_MAX);
    expect(pickups.items).toHaveLength(1);
  });

  it('city packs respawn after a while, even across a chunk reload', () => {
    const { sim, data, pickups } = setup([[5, 5]]);
    run(sim, 0.1);
    expect(pickups.items).toHaveLength(0);
    teleport(sim.player, 30, 0.05, 30);
    // Reloading the chunk early must not bring the pack back.
    pickups.onChunkUnloaded(data.key);
    pickups.onChunkLoaded(data);
    run(sim, PACK_RESPAWN - 5);
    expect(pickups.items).toHaveLength(0);
    run(sim, 6);
    expect(pickups.items).toHaveLength(1);
  });

  it('bot drops vanish after their lifetime', () => {
    const { sim, pickups } = setup();
    pickups.drop(20, 0, 20);
    run(sim, DROP_LIFETIME - 1);
    expect(pickups.items).toHaveLength(1);
    run(sim, 1.5);
    expect(pickups.items).toHaveLength(0);
  });

  it('drops a pack from some bots the player kills, deterministically', () => {
    expect(dropRoll(7, 12, 345)).toBe(dropRoll(7, 12, 345));
    const { sim, pickups } = setup();
    let drops = 0;
    for (let i = 0; i < 200; i++) {
      const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 20, 0.05, 20);
      bot.inv = makeInventory(null); // unarmed, so guns don't crowd out the packs
      const medkits = () => pickups.items.filter((p) => p.item.kind === 'medkit').length;
      const before = medkits();
      pickups.onHit(sim, killInfo(sim.player, bot), true);
      drops += medkits() - before;
      sim.tick++;
    }
    expect(drops).toBeGreaterThan(40);
    expect(drops).toBeLessThan(100);
  });
});

describe('inventory drops', () => {
  it('a dead bot drops its guns with their ammo and keeps nothing', () => {
    const { sim, pickups } = setup();
    const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 20, 0.05, 20);
    bot.inv = makeInventory('glock', 'ak47');
    bot.inv.primary!.clip = 12;
    bot.inv.primary!.reserve = 40;
    pickups.onHit(sim, killInfo(sim.player, bot), true);
    const guns = weaponsOnGround(pickups);
    expect(guns.map((g) => g.item.kind === 'weapon' && g.item.weapon).sort()).toEqual(['ak47', 'glock']);
    const ak = guns.find((g) => g.item.kind === 'weapon' && g.item.weapon === 'ak47')!;
    expect(ak.item).toMatchObject({ clip: 12, reserve: 40 });
    expect(ak.stash).toBe(false);
    expect(ak.expiresAt).toBe(sim.time + DROP_LIFETIME);
    expect(Math.hypot(ak.pos.x - 20, ak.pos.z - 20)).toBeLessThan(1);
    expect(ak.pos.y).toBeCloseTo(0.02, 1);
    expect(bot.inv.primary).toBeNull();
    expect(bot.inv.secondary).toBeNull();
  });

  it('the player leaves a stash that lasts, and dying again replaces it', () => {
    const { sim, pickups } = setup();
    const p = sim.player;
    const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 20, 0.05, 20);
    p.inv = makeInventory('deagle', 'awp');
    p.medkits = 2;
    p.alive = false;
    pickups.onHit(sim, killInfo(bot, p), true);
    expect(pickups.items.filter((i) => i.stash)).toHaveLength(4);
    expect(pickups.stashPos(sim.player.id)).not.toBeNull();
    expect(p.medkits).toBe(0);
    run(sim, DROP_LIFETIME + 5);
    expect(pickups.items.filter((i) => i.stash)).toHaveLength(4);

    sim.respawnPlayer(sim.player, 40, 40);
    p.alive = false;
    pickups.onHit(sim, killInfo(bot, p), true);
    const stash = pickups.items.filter((i) => i.stash);
    expect(stash).toHaveLength(1);
    expect(stash[0].item).toMatchObject({ kind: 'weapon', weapon: 'glock' });
    expect(Math.hypot(stash[0].pos.x - 40, stash[0].pos.z - 40)).toBeLessThan(1);
  });

  it('grenades go into the stash and are picked back up, up to the caps', () => {
    const { sim, pickups } = setup();
    const p = sim.player;
    const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 20, 0.05, 20);
    addGrenades(p.inv, 'flashbang', 2);
    addGrenades(p.inv, 'smokegrenade', 1);
    p.alive = false;
    pickups.onHit(sim, killInfo(bot, p), true);
    const nades = pickups.items.filter((i) => i.item.kind === 'grenade');
    expect(nades.map((i) => i.item.kind === 'grenade' && [i.item.grenade, i.item.count])).toEqual([
      ['flashbang', 2],
      ['smokegrenade', 1],
    ]);
    expect(grenadeTotal(p.inv)).toBe(0);
    sim.respawnPlayer(sim.player, 5, 5);
    // Already carrying one flash: only one more fits, the other stays on the ground.
    addGrenades(p.inv, 'flashbang', 1);
    for (const it of nades) {
      it.pos.x = 5;
      it.pos.z = 5;
      it.pos.y = p.move.pos.y;
    }
    run(sim, 0.2);
    expect(p.inv.nades).toMatchObject({ flashbang: 2, smokegrenade: 1 });
    const left = pickups.items.filter((i) => i.item.kind === 'grenade');
    expect(left).toHaveLength(1);
    expect(left[0].item).toMatchObject({ grenade: 'flashbang', count: 1 });
  });

  it('walking over a gun for an empty slot takes it without switching', () => {
    const { sim, pickups } = setup();
    pickups.drop(5.3, 0, 5, { kind: 'weapon', weapon: 'm4a4', clip: 7, reserve: 9 });
    run(sim, 0.1);
    expect(sim.player.inv.primary).toMatchObject({ clip: 7, reserve: 9 });
    expect(sim.player.inv.primary!.def.id).toBe('m4a4');
    expect(sim.player.inv.active).toBe('secondary');
    expect(pickups.items).toHaveLength(0);
  });

  it('the same gun gives its ammo, up to the reserve cap', () => {
    const { sim, pickups } = setup();
    const g = sim.player.inv.secondary!;
    g.reserve = g.def.reserve - 5;
    pickups.drop(5.3, 0, 5, { kind: 'weapon', weapon: 'glock', clip: 20, reserve: 3 });
    run(sim, 0.1);
    expect(g.reserve).toBe(g.def.reserve);
    // 3 from its reserve and 2 from its magazine; the rest stays on the ground.
    expect(pickups.items).toHaveLength(1);
    expect(pickups.items[0].item).toMatchObject({ clip: 18, reserve: 0 });
    run(sim, 0.5);
    expect(pickups.items).toHaveLength(1);
  });

  it('E swaps the gun in that slot and drops the old one', () => {
    const { sim, pickups } = setup();
    pickups.drop(6, 0, 5, { kind: 'weapon', weapon: 'deagle', clip: 5, reserve: 10 });
    run(sim, 0.1);
    expect(pickups.swapCandidate(sim.player.id)?.item).toMatchObject({ weapon: 'deagle' });
    expect(sim.player.inv.secondary!.def.id).toBe('glock');
    press(sim, Buttons.USE);
    expect(sim.player.inv.secondary).toMatchObject({ clip: 5, reserve: 10 });
    expect(sim.player.inv.secondary!.def.id).toBe('deagle');
    expect(sim.player.inv.active).toBe('secondary');
    expect(sim.player.wpn.deployEnd).toBeCloseTo(sim.time + WEAPONS.deagle.deployTime, 5);
    const left = weaponsOnGround(pickups);
    expect(left).toHaveLength(1);
    expect(left[0].item).toMatchObject({ weapon: 'glock' });
    // The dropped glock is now the swap candidate, not picked back up automatically.
    run(sim, 0.1);
    expect(sim.player.inv.secondary!.def.id).toBe('deagle');
  });

  it('a crowded world evicts old drops but never the stash', () => {
    const { sim, pickups } = setup();
    sim.player.inv = makeInventory('glock', 'ak47');
    const bot = makeActor(sim.newActorId(), 'Bot', Team.Bots, 20, 0.05, 20);
    teleport(sim.player, 50, 0.05, 50);
    sim.player.alive = false;
    pickups.onHit(sim, killInfo(bot, sim.player), true);
    for (let i = 0; i < MAX_ITEMS + 20; i++) pickups.drop(30, 0, 30 + (i % 10));
    expect(pickups.items.length).toBe(MAX_ITEMS);
    expect(pickups.items.filter((i) => i.stash)).toHaveLength(2);
  });
});

describe('medkit use', () => {
  it(`heals +${MEDKIT_HEAL} after ${MEDKIT_TIME}s and consumes a pack`, () => {
    const { sim } = setup();
    const p = sim.player;
    p.medkits = 2;
    p.health = 30;
    press(sim, Buttons.HEAL);
    expect(p.healEnd).toBeGreaterThan(0);
    run(sim, MEDKIT_TIME * 0.5);
    expect(p.health).toBe(30);
    run(sim, MEDKIT_TIME * 0.6);
    expect(p.health).toBe(30 + MEDKIT_HEAL);
    expect(p.medkits).toBe(1);
    expect(p.healEnd).toBe(-1);
  });

  it('caps health at 100', () => {
    const { sim } = setup();
    sim.player.medkits = 1;
    sim.player.health = 80;
    press(sim, Buttons.HEAL);
    run(sim, MEDKIT_TIME + 0.1);
    expect(sim.player.health).toBe(100);
    expect(sim.player.medkits).toBe(0);
  });

  it('does nothing at full health or without packs', () => {
    const { sim } = setup();
    sim.player.medkits = 1;
    press(sim, Buttons.HEAL);
    expect(sim.player.healEnd).toBe(-1);
    sim.player.medkits = 0;
    sim.player.health = 40;
    press(sim, Buttons.HEAL);
    expect(sim.player.healEnd).toBe(-1);
  });

  it('firing cancels the heal and keeps the pack', () => {
    const { sim } = setup();
    const p = sim.player;
    p.medkits = 1;
    p.health = 40;
    run(sim, 1); // finish the initial deploy
    press(sim, Buttons.HEAL);
    run(sim, 0.3);
    sim.events.drain();
    press(sim, Buttons.ATTACK);
    expect(p.healEnd).toBe(-1);
    expect(p.medkits).toBe(1);
    expect(p.health).toBe(40);
    expect(eventsOf(sim, 'shot')).toHaveLength(1);
  });

  it("the gun can't fire while healing", () => {
    const { sim } = setup();
    const p = sim.player;
    p.medkits = 1;
    p.health = 40;
    run(sim, 1);
    press(sim, Buttons.HEAL);
    sim.events.drain();
    // Trigger held down (not a fresh press, which would cancel).
    const hold = makeCmd();
    hold.buttons = Buttons.ATTACK;
    run(sim, MEDKIT_TIME * 0.8, hold);
    expect(eventsOf(sim, 'shot')).toHaveLength(0);
    expect(p.healEnd).toBeGreaterThan(0);
  });

  it('death clears carried packs', () => {
    const { sim } = setup();
    sim.player.medkits = 3;
    sim.resetLoadout(sim.player);
    expect(sim.player.medkits).toBe(0);
  });
});
