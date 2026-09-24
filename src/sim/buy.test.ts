import { describe, expect, it } from 'vitest';
import { CHUNK, TICK } from '../core/config';
import { parseParams } from '../core/urlParams';
import { makeInventory } from '../weapons/Inventory';
import { chunkKey } from '../world/chunkMath';
import { teleport } from './Actor';
import { buy, priceOf, unavailableReason } from './buy';
import { Simulation } from './Simulation';

/** City sim with the player standing in the spawn chunk, well out of combat. */
function makeSim() {
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.time = 100;
  sim.economy.money = 10000;
  teleport(sim.player, sim.params.spawnCx * CHUNK + 32, 0, sim.params.spawnCz * CHUNK + 32);
  return sim;
}

describe('buying ammo', () => {
  it('prices a refill per missing magazine', () => {
    const sim = makeSim();
    sim.player.inv = makeInventory('glock', 'ak47');
    const ak = sim.player.inv.primary!;
    expect(unavailableReason(sim, 'ammo_primary')).toBe('Ammo full');
    ak.reserve -= 1;
    expect(priceOf(sim, 'ammo_primary')).toBe(80);
    ak.reserve = ak.def.reserve - ak.def.magSize - 1;
    expect(priceOf(sim, 'ammo_primary')).toBe(160);
  });

  it('refills the reserve, charges money and keeps the active weapon', () => {
    const sim = makeSim();
    sim.player.inv = makeInventory('glock', 'ak47');
    const ak = sim.player.inv.primary!;
    ak.reserve = 0;
    ak.clip = 5;
    const price = priceOf(sim, 'ammo_primary');
    const active = sim.player.inv.active;
    expect(buy(sim, 'ammo_primary', false)).toBe(true);
    expect(ak.reserve).toBe(ak.def.reserve);
    expect(ak.clip).toBe(5);
    expect(sim.economy.money).toBe(10000 - price);
    expect(sim.player.inv.active).toBe(active);
    expect(buy(sim, 'ammo_primary', false)).toBe(false);
  });

  it('needs a gun in the slot', () => {
    const sim = makeSim();
    sim.player.inv = makeInventory('glock');
    expect(unavailableReason(sim, 'ammo_primary')).toBe('No primary weapon');
    expect(buy(sim, 'ammo_primary', false)).toBe(false);
  });

  it('only works in a buy zone', () => {
    const sim = makeSim();
    sim.player.inv.secondary!.reserve = 0;
    teleport(sim.player, (sim.params.spawnCx + 3) * CHUNK + 32, 0, sim.params.spawnCz * CHUNK + 32);
    expect(buy(sim, 'ammo_secondary', false)).toBe(false);
    sim.cleared.add(chunkKey(sim.params.spawnCx + 3, sim.params.spawnCz));
    expect(buy(sim, 'ammo_secondary', false)).toBe(true);
  });
});
