import { GRENADE_CAP, GRENADE_IDS, GRENADE_TOTAL_CAP, WEAPONS, type GrenadeId, type WeaponDef, type WeaponId, type WeaponSlot } from './weaponDefs';

export interface WeaponItem {
  def: WeaponDef;
  clip: number;
  reserve: number;
}

/** Per-actor firing state for the active weapon (reset on switch). */
export interface WeaponState {
  /** Sim time when the next shot is allowed. */
  nextAttack: number;
  /** Sim time when the reload finishes, or -1. */
  reloadEnd: number;
  /** Sim time when the deploy finishes. */
  deployEnd: number;
  /** Accumulated fire inaccuracy (mrad). */
  fireInacc: number;
  /** Position in the spray pattern (fractional while recovering). */
  recoilIndex: number;
  lastShot: number;
  /** 0 = unscoped, else zoom level index + 1. */
  scope: number;
  /** Rescope after the bolt cycles (AWP), or -1. */
  rescopeAt: number;
  rescopeLevel: number;
  /** Attack was held last tick (semi-auto needs a release). */
  triggerHeld: boolean;
  /** Dry-fire already signalled for this trigger pull. */
  dryFired: boolean;
  /** Bullets fired by this actor, used to key spread randomness. */
  shotCounter: number;
  /** Inspect animation requested (presentation only). */
  inspectAt: number;
  /** Grenade pin pulled (attack held), waiting for release. */
  pinPulled: boolean;
  /** Throw strength picked by the buttons held while the pin was out (1 full, 0.4 lob). */
  throwStrength: number;
  /** Sim time of the last throw (viewmodel swing, auto-switch). */
  thrownAt: number;
}

export interface Inventory {
  primary: WeaponItem | null;
  secondary: WeaponItem | null;
  knife: WeaponItem;
  /**
   * The selected grenade, or null when carrying none. Its `clip` mirrors the count in `nades`;
   * call syncGrenade after changing counts.
   */
  grenade: WeaponItem | null;
  /** Carried grenades by type. */
  nades: Record<GrenadeId, number>;
  /** Grenade type in the grenade slot. */
  nadeSel: GrenadeId;
  active: WeaponSlot;
  last: WeaponSlot;
}

export const emptyNades = (): Record<GrenadeId, number> => ({ hegrenade: 0, flashbang: 0, smokegrenade: 0, molotov: 0 });

export function grenadeTotal(inv: Inventory): number {
  let n = 0;
  for (const id of GRENADE_IDS) n += inv.nades[id];
  return n;
}

/** How many more of a grenade type fit (per-type and total caps). */
export function grenadeRoom(inv: Inventory, id: GrenadeId): number {
  return Math.max(0, Math.min(GRENADE_CAP[id] - inv.nades[id], GRENADE_TOTAL_CAP - grenadeTotal(inv)));
}

/**
 * Rebuild the grenade slot item after counts changed: keep the selected type if any are left,
 * else pick the first type carried. An empty grenade slot in hand falls back to the last weapon.
 */
export function syncGrenade(inv: Inventory): void {
  if (inv.nades[inv.nadeSel] <= 0) inv.nadeSel = GRENADE_IDS.find((id) => inv.nades[id] > 0) ?? inv.nadeSel;
  const n = inv.nades[inv.nadeSel];
  if (n <= 0) {
    inv.grenade = null;
  } else if (inv.grenade && inv.grenade.def.id === inv.nadeSel) {
    inv.grenade.clip = n;
  } else {
    inv.grenade = { def: WEAPONS[inv.nadeSel], clip: n, reserve: 0 };
  }
  if (!inv.grenade) {
    if (inv.active === 'grenade') inv.active = inv[inv.last] && inv.last !== 'grenade' ? inv.last : fallbackSlot(inv);
    if (inv.last === 'grenade') inv.last = 'knife';
  }
}

function fallbackSlot(inv: Inventory): WeaponSlot {
  return inv.primary ? 'primary' : inv.secondary ? 'secondary' : 'knife';
}

/** Add grenades up to the caps; returns how many were taken. */
export function addGrenades(inv: Inventory, id: GrenadeId, count: number): number {
  const take = Math.min(count, grenadeRoom(inv, id));
  if (take <= 0) return 0;
  inv.nades[id] += take;
  if (!inv.grenade) inv.nadeSel = id;
  syncGrenade(inv);
  return take;
}

/** Next grenade type carried after the selected one (pressing 4 again cycles, like CS). */
export function nextGrenadeType(inv: Inventory): GrenadeId {
  const i = GRENADE_IDS.indexOf(inv.nadeSel);
  for (let k = 1; k <= GRENADE_IDS.length; k++) {
    const id = GRENADE_IDS[(i + k) % GRENADE_IDS.length];
    if (inv.nades[id] > 0) return id;
  }
  return inv.nadeSel;
}

export function makeItem(id: WeaponId): WeaponItem {
  const def = WEAPONS[id];
  return { def, clip: def.magSize, reserve: def.reserve };
}

export function makeInventory(secondary: WeaponId | null = 'glock', primary: WeaponId | null = null): Inventory {
  const inv: Inventory = {
    primary: primary ? makeItem(primary) : null,
    secondary: secondary ? makeItem(secondary) : null,
    knife: makeItem('knife'),
    grenade: null,
    nades: emptyNades(),
    nadeSel: 'hegrenade',
    active: 'knife',
    last: 'knife',
  };
  inv.active = inv.primary ? 'primary' : inv.secondary ? 'secondary' : 'knife';
  inv.last = inv.active === 'primary' && inv.secondary ? 'secondary' : 'knife';
  return inv;
}

export function makeWeaponState(): WeaponState {
  return {
    nextAttack: 0,
    reloadEnd: -1,
    deployEnd: 0,
    fireInacc: 0,
    recoilIndex: 0,
    lastShot: -10,
    scope: 0,
    rescopeAt: -1,
    rescopeLevel: 0,
    triggerHeld: false,
    dryFired: false,
    shotCounter: 0,
    inspectAt: -10,
    pinPulled: false,
    throwStrength: 1,
    thrownAt: -10,
  };
}

export function activeItem(inv: Inventory): WeaponItem {
  return inv[inv.active] ?? inv.knife;
}

export function itemInSlot(inv: Inventory, slot: WeaponSlot): WeaponItem | null {
  return inv[slot];
}

/** Put a weapon in its slot (replacing what was there) and return the replaced item. */
export function giveWeapon(inv: Inventory, id: WeaponId): WeaponItem | null {
  const item = makeItem(id);
  const slot = item.def.slot;
  if (slot === 'grenade') {
    addGrenades(inv, id as GrenadeId, 1);
    return null;
  }
  const old = inv[slot];
  if (slot === 'knife') inv.knife = item;
  else inv[slot] = item;
  return old;
}

const SLOT_ORDER: WeaponSlot[] = ['primary', 'secondary', 'knife', 'grenade'];

/** Next/previous owned slot for mouse-wheel cycling. */
export function cycleSlot(inv: Inventory, dir: 1 | -1): WeaponSlot {
  let i = SLOT_ORDER.indexOf(inv.active);
  for (let k = 0; k < SLOT_ORDER.length; k++) {
    i = (i + dir + SLOT_ORDER.length) % SLOT_ORDER.length;
    if (inv[SLOT_ORDER[i]]) return SLOT_ORDER[i];
  }
  return inv.active;
}

export function slotFromNumber(n: number): WeaponSlot | null {
  return n === 1 ? 'primary' : n === 2 ? 'secondary' : n === 3 ? 'knife' : n === 4 ? 'grenade' : null;
}
