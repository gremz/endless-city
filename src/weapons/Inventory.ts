import { WEAPONS, type WeaponDef, type WeaponId, type WeaponSlot } from './weaponDefs';

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
}

export interface Inventory {
  primary: WeaponItem | null;
  secondary: WeaponItem | null;
  knife: WeaponItem;
  active: WeaponSlot;
  last: WeaponSlot;
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
  const old = inv[slot];
  if (slot === 'knife') inv.knife = item;
  else inv[slot] = item;
  return old;
}

const SLOT_ORDER: WeaponSlot[] = ['primary', 'secondary', 'knife'];

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
  return n === 1 ? 'primary' : n === 2 ? 'secondary' : n === 3 ? 'knife' : null;
}
