import { worldToChunk, chunkKey } from '../world/chunkMath';
import { giveWeapon } from '../weapons/Inventory';
import { GEAR_PRICES, WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import type { Simulation } from './Simulation';

export type BuyItem = WeaponId | 'kevlar' | 'helmet';

export const OUT_OF_COMBAT = 5;

/** Buying is allowed in the spawn area and in cleared areas, and only out of combat. */
export function buyZoneStatus(sim: Simulation, engagedNearby: boolean): { ok: boolean; reason: string } {
  const p = sim.player;
  if (!p.alive) return { ok: false, reason: 'You are dead' };
  const key = chunkKey(worldToChunk(p.move.pos.x), worldToChunk(p.move.pos.z));
  const spawn = chunkKey(sim.params.spawnCx, sim.params.spawnCz);
  if (key !== spawn && !sim.cleared.has(key) && sim.params.world === 'city') {
    return { ok: false, reason: 'Buy only in the spawn area or areas you have cleared' };
  }
  const t = sim.time;
  if (t - p.lastDamagedAt < OUT_OF_COMBAT || t - p.lastDealtAt < OUT_OF_COMBAT || engagedNearby) {
    return { ok: false, reason: 'Cannot buy during combat' };
  }
  return { ok: true, reason: '' };
}

export function priceOf(sim: Simulation, item: BuyItem): number {
  if (item === 'kevlar') return GEAR_PRICES.kevlar;
  if (item === 'helmet') return sim.player.armor >= 100 && !sim.player.helmet ? 350 : GEAR_PRICES.helmet;
  return WEAPONS[item].price;
}

/** Whether the player already owns the item fully (nothing to buy). */
export function owned(sim: Simulation, item: BuyItem): boolean {
  const p = sim.player;
  if (item === 'kevlar') return p.armor >= 100;
  if (item === 'helmet') return p.armor >= 100 && p.helmet;
  const def = WEAPONS[item];
  const cur = p.inv[def.slot];
  return !!cur && cur.def.id === item && cur.reserve === def.reserve && cur.clip === def.magSize;
}

/** Validate and apply a purchase. Emits a 'buy' event either way. */
export function buy(sim: Simulation, item: BuyItem, engagedNearby: boolean): boolean {
  const zone = buyZoneStatus(sim, engagedNearby);
  const fail = (reason: string) => {
    sim.events.push({ type: 'buy', item, ok: false, reason });
    return false;
  };
  if (!zone.ok) return fail(zone.reason);
  if (owned(sim, item)) return fail('Already owned');
  const price = priceOf(sim, item);
  if (!sim.economy.canAfford(price)) return fail('Not enough money');
  sim.economy.spend(price, 'buy');
  const p = sim.player;
  if (item === 'kevlar') {
    p.armor = 100;
  } else if (item === 'helmet') {
    p.armor = 100;
    p.helmet = true;
  } else {
    const def = WEAPONS[item];
    giveWeapon(p.inv, item);
    // Switch to what you bought, like CS.
    if (p.inv.active !== def.slot) {
      p.inv.last = p.inv.active;
      p.inv.active = def.slot;
    }
    p.wpn.deployEnd = sim.time + def.deployTime;
    p.wpn.nextAttack = p.wpn.deployEnd;
    p.wpn.reloadEnd = -1;
    p.wpn.scope = 0;
    p.wpn.recoilIndex = 0;
    p.wpn.fireInacc = 0;
    sim.events.push({ type: 'deploy', actorId: p.id, weapon: item });
  }
  sim.events.push({ type: 'buy', item, ok: true });
  return true;
}
