import { worldToChunk, chunkKey } from '../world/chunkMath';
import { addGrenades, grenadeRoom, grenadeTotal, giveWeapon, type WeaponItem } from '../weapons/Inventory';
import { equipSlot } from '../weapons/WeaponSystem';
import { GEAR_PRICES, GRENADE_CAP, GRENADE_TOTAL_CAP, isGrenadeId, WEAPONS, type BuyItem, type WeaponSlot } from '../weapons/weaponDefs';
import type { Actor } from './Actor';
import { BREACH_MAX } from './breach';
import type { Simulation } from './Simulation';

export type { BuyItem };

export const isAmmo = (item: BuyItem): item is 'ammo_primary' | 'ammo_secondary' =>
  item === 'ammo_primary' || item === 'ammo_secondary';

export const ammoSlot = (item: 'ammo_primary' | 'ammo_secondary'): WeaponSlot =>
  item === 'ammo_primary' ? 'primary' : 'secondary';

/** The gun an ammo purchase would refill, or null if that slot is empty. */
function ammoTarget(p: Actor, item: 'ammo_primary' | 'ammo_secondary'): WeaponItem | null {
  return p.inv[ammoSlot(item)];
}

export const OUT_OF_COMBAT = 5;

/** Any bot fighting within 40 m of the player (blocks buying, keeps the music tense). */
export function engagedNear(sim: Simulation, p: Actor): boolean {
  const pos = p.move.pos;
  return sim.actors.some((a) => a.engaging && a.alive && Math.hypot(a.move.pos.x - pos.x, a.move.pos.z - pos.z) < 40);
}

/** Buying is allowed in the spawn area and in cleared areas, and only out of combat. */
export function buyZoneStatus(sim: Simulation, p: Actor, engagedNearby: boolean): { ok: boolean; reason: string } {
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

export function priceOf(p: Actor, item: BuyItem): number {
  if (item === 'kevlar') return GEAR_PRICES.kevlar;
  if (item === 'breach') return GEAR_PRICES.breach;
  if (item === 'helmet') return p.armor >= 100 && !p.helmet ? 350 : GEAR_PRICES.helmet;
  if (isAmmo(item)) {
    // Priced per magazine needed to fill the reserve back up.
    const w = ammoTarget(p, item);
    if (!w) return 0;
    const missing = Math.max(0, w.def.reserve - w.reserve);
    return Math.ceil(missing / w.def.magSize) * w.def.ammoPrice;
  }
  return WEAPONS[item].price;
}

/** Why the item can't be bought regardless of zone and money (owned, ammo full...), or null if it can. */
export function unavailableReason(p: Actor, item: BuyItem): string | null {
  if (isAmmo(item)) {
    const w = ammoTarget(p, item);
    if (!w) return item === 'ammo_primary' ? 'No primary weapon' : 'No secondary weapon';
    return w.reserve >= w.def.reserve ? 'Ammo full' : null;
  }
  if (item === 'breach') return p.breachCharges >= BREACH_MAX ? `Carrying ${BREACH_MAX} already` : null;
  if (isGrenadeId(item)) {
    const inv = p.inv;
    if (grenadeRoom(inv, item) > 0) return null;
    if (grenadeTotal(inv) >= GRENADE_TOTAL_CAP) return `Grenades full (${GRENADE_TOTAL_CAP})`;
    return GRENADE_CAP[item] > 1 ? `Carrying ${GRENADE_CAP[item]} already` : 'Already owned';
  }
  return ownsItem(p, item) ? 'Already owned' : null;
}

function ownsItem(p: Actor, item: Exclude<BuyItem, 'ammo_primary' | 'ammo_secondary' | 'breach'>): boolean {
  if (item === 'kevlar') return p.armor >= 100;
  if (item === 'helmet') return p.armor >= 100 && p.helmet;
  const def = WEAPONS[item];
  const cur = p.inv[def.slot];
  return !!cur && cur.def.id === item && cur.reserve === def.reserve && cur.clip === def.magSize;
}

/** Validate and apply a purchase. Emits a 'buy' event either way. */
export function buy(sim: Simulation, p: Actor, item: BuyItem, engagedNearby: boolean): boolean {
  const zone = buyZoneStatus(sim, p, engagedNearby);
  const fail = (reason: string) => {
    sim.events.push({ type: 'buy', actorId: p.id, item, ok: false, reason });
    return false;
  };
  if (!zone.ok) return fail(zone.reason);
  const unavailable = unavailableReason(p, item);
  if (unavailable) return fail(unavailable);
  const price = priceOf(p, item);
  if (!sim.economy.canAfford(p, price)) return fail('Not enough money');
  sim.economy.spend(p, price, 'buy');
  if (item === 'kevlar') {
    p.armor = 100;
  } else if (item === 'helmet') {
    p.armor = 100;
    p.helmet = true;
  } else if (item === 'breach') {
    p.breachCharges++;
  } else if (isAmmo(item)) {
    const w = ammoTarget(p, item)!;
    w.reserve = w.def.reserve;
  } else if (isGrenadeId(item)) {
    // Grenades go on your belt; you keep holding your gun.
    addGrenades(p.inv, item, 1);
  } else {
    giveWeapon(p.inv, item);
    // Switch to what you bought, like CS.
    equipSlot(p, WEAPONS[item].slot, sim);
  }
  sim.events.push({ type: 'buy', actorId: p.id, item, ok: true });
  return true;
}

/**
 * The next upgrade worth buying that the player can afford, or null: a rifle (keeping enough
 * back for Kevlar if unarmoured), then Kevlar, then a helmet.
 */
export function recommendUpgrade(p: Actor): BuyItem | null {
  if (!p.alive) return null;
  const unarmoured = p.armor < 50;
  const cat = p.inv.primary?.def.category;
  if (cat !== 'rifle' && cat !== 'sniper') {
    const keep = unarmoured ? priceOf(p, 'kevlar') : 0;
    for (const id of ['m4a4', 'ak47'] as const) if (p.money >= priceOf(p, id) + keep) return id;
  }
  if (unarmoured && p.money >= priceOf(p, 'kevlar')) return 'kevlar';
  if (!unarmoured && !p.helmet && p.money >= priceOf(p, 'helmet')) return 'helmet';
  return null;
}
