import { worldToChunk, chunkKey } from '../world/chunkMath';
import { addGrenades, grenadeRoom, grenadeTotal, giveWeapon, type WeaponItem } from '../weapons/Inventory';
import { equipSlot } from '../weapons/WeaponSystem';
import { GEAR_PRICES, GRENADE_CAP, GRENADE_TOTAL_CAP, isGrenadeId, WEAPONS, type BuyItem, type WeaponSlot } from '../weapons/weaponDefs';
import type { Simulation } from './Simulation';

export type { BuyItem };

export const isAmmo = (item: BuyItem): item is 'ammo_primary' | 'ammo_secondary' =>
  item === 'ammo_primary' || item === 'ammo_secondary';

export const ammoSlot = (item: 'ammo_primary' | 'ammo_secondary'): WeaponSlot =>
  item === 'ammo_primary' ? 'primary' : 'secondary';

/** The gun an ammo purchase would refill, or null if that slot is empty. */
function ammoTarget(sim: Simulation, item: 'ammo_primary' | 'ammo_secondary'): WeaponItem | null {
  return sim.player.inv[ammoSlot(item)];
}

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
  if (isAmmo(item)) {
    // Priced per magazine needed to fill the reserve back up.
    const w = ammoTarget(sim, item);
    if (!w) return 0;
    const missing = Math.max(0, w.def.reserve - w.reserve);
    return Math.ceil(missing / w.def.magSize) * w.def.ammoPrice;
  }
  return WEAPONS[item].price;
}

/** Why the item can't be bought regardless of zone and money (owned, ammo full...), or null if it can. */
export function unavailableReason(sim: Simulation, item: BuyItem): string | null {
  if (isAmmo(item)) {
    const w = ammoTarget(sim, item);
    if (!w) return item === 'ammo_primary' ? 'No primary weapon' : 'No secondary weapon';
    return w.reserve >= w.def.reserve ? 'Ammo full' : null;
  }
  if (isGrenadeId(item)) {
    const inv = sim.player.inv;
    if (grenadeRoom(inv, item) > 0) return null;
    if (grenadeTotal(inv) >= GRENADE_TOTAL_CAP) return `Grenades full (${GRENADE_TOTAL_CAP})`;
    return GRENADE_CAP[item] > 1 ? `Carrying ${GRENADE_CAP[item]} already` : 'Already owned';
  }
  return ownsItem(sim, item) ? 'Already owned' : null;
}

function ownsItem(sim: Simulation, item: Exclude<BuyItem, 'ammo_primary' | 'ammo_secondary'>): boolean {
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
  const unavailable = unavailableReason(sim, item);
  if (unavailable) return fail(unavailable);
  const price = priceOf(sim, item);
  if (!sim.economy.canAfford(price)) return fail('Not enough money');
  sim.economy.spend(price, 'buy');
  const p = sim.player;
  if (item === 'kevlar') {
    p.armor = 100;
  } else if (item === 'helmet') {
    p.armor = 100;
    p.helmet = true;
  } else if (isAmmo(item)) {
    const w = ammoTarget(sim, item)!;
    w.reserve = w.def.reserve;
  } else if (isGrenadeId(item)) {
    // Grenades go on your belt; you keep holding your gun.
    addGrenades(p.inv, item, 1);
  } else {
    giveWeapon(p.inv, item);
    // Switch to what you bought, like CS.
    equipSlot(p, WEAPONS[item].slot, sim);
  }
  sim.events.push({ type: 'buy', item, ok: true });
  return true;
}
