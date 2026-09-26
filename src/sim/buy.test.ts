import { describe, expect, it } from 'vitest';
import { CHUNK, TICK } from '../core/config';
import { parseParams } from '../core/urlParams';
import { makeInventory } from '../weapons/Inventory';
import { chunkKey } from '../world/chunkMath';
import { teleport } from './Actor';
import { buy, priceOf, recommendUpgrade, unavailableReason } from './buy';
import { Simulation } from './Simulation';

/** City sim with the player standing in the spawn chunk, well out of combat. */
function makeSim() {
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.time = 100;
  sim.player.money = 10000;
  teleport(sim.player, sim.params.spawnCx * CHUNK + 32, 0, sim.params.spawnCz * CHUNK + 32);
  return sim;
}

describe('buying ammo', () => {
  it('prices a refill per missing magazine', () => {
    const sim = makeSim();
    sim.player.inv = makeInventory('glock', 'ak47');
    const ak = sim.player.inv.primary!;
    expect(unavailableReason(sim.player, 'ammo_primary')).toBe('Ammo full');
    ak.reserve -= 1;
    expect(priceOf(sim.player, 'ammo_primary')).toBe(80);
    ak.reserve = ak.def.reserve - ak.def.magSize - 1;
    expect(priceOf(sim.player, 'ammo_primary')).toBe(160);
  });

  it('refills the reserve, charges money and keeps the active weapon', () => {
    const sim = makeSim();
    sim.player.inv = makeInventory('glock', 'ak47');
    const ak = sim.player.inv.primary!;
    ak.reserve = 0;
    ak.clip = 5;
    const price = priceOf(sim.player, 'ammo_primary');
    const active = sim.player.inv.active;
    expect(buy(sim, sim.player, 'ammo_primary', false)).toBe(true);
    expect(ak.reserve).toBe(ak.def.reserve);
    expect(ak.clip).toBe(5);
    expect(sim.player.money).toBe(10000 - price);
    expect(sim.player.inv.active).toBe(active);
    expect(buy(sim, sim.player, 'ammo_primary', false)).toBe(false);
  });

  it('needs a gun in the slot', () => {
    const sim = makeSim();
    sim.player.inv = makeInventory('glock');
    expect(unavailableReason(sim.player, 'ammo_primary')).toBe('No primary weapon');
    expect(buy(sim, sim.player, 'ammo_primary', false)).toBe(false);
  });

  it('only works in a buy zone', () => {
    const sim = makeSim();
    sim.player.inv.secondary!.reserve = 0;
    teleport(sim.player, (sim.params.spawnCx + 3) * CHUNK + 32, 0, sim.params.spawnCz * CHUNK + 32);
    expect(buy(sim, sim.player, 'ammo_secondary', false)).toBe(false);
    sim.cleared.add(chunkKey(sim.params.spawnCx + 3, sim.params.spawnCz));
    expect(buy(sim, sim.player, 'ammo_secondary', false)).toBe(true);
  });
});

describe('upgrade recommendation', () => {
  it('suggests a rifle with Kevlar money kept back, then Kevlar, then a helmet', () => {
    const p = makeSim().player;
    p.inv = makeInventory('glock', 'mp9');
    p.money = 500;
    expect(recommendUpgrade(p)).toBe(null);
    p.money = 1400;
    expect(recommendUpgrade(p)).toBe('kevlar');
    // An AK alone is affordable, but not with Kevlar on top: armour first.
    p.money = 3000;
    expect(recommendUpgrade(p)).toBe('kevlar');
    p.money = 2700 + 650;
    expect(recommendUpgrade(p)).toBe('ak47');
    p.money = 3100 + 650;
    expect(recommendUpgrade(p)).toBe('m4a4');
    p.armor = 100;
    p.money = 2800;
    expect(recommendUpgrade(p)).toBe('ak47');
    p.inv = makeInventory('glock', 'ak47');
    expect(recommendUpgrade(p)).toBe('helmet');
    p.helmet = true;
    expect(recommendUpgrade(p)).toBe(null);
  });
});
