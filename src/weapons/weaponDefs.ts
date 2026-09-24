import { HU } from '../core/config';

export type GrenadeId = 'hegrenade' | 'flashbang' | 'smokegrenade' | 'molotov';
export type WeaponId = 'knife' | 'glock' | 'deagle' | 'mp9' | 'ump45' | 'ak47' | 'm4a4' | 'awp' | GrenadeId;
export type WeaponSlot = 'primary' | 'secondary' | 'knife' | 'grenade';
export type WeaponCategory = 'knife' | 'pistol' | 'smg' | 'rifle' | 'sniper' | 'grenade';
export type SoundKind = 'knife' | 'pistol' | 'deagle' | 'smg' | 'rifle_heavy' | 'rifle_light' | 'awp' | 'grenade';

export const GRENADE_IDS: readonly GrenadeId[] = ['hegrenade', 'flashbang', 'smokegrenade', 'molotov'];
export const isGrenadeId = (id: string): id is GrenadeId => (GRENADE_IDS as readonly string[]).includes(id);

/** How many of each grenade you can carry, and the total cap (CS rules: two flashes, four in all). */
export const GRENADE_CAP: Record<GrenadeId, number> = { hegrenade: 1, flashbang: 2, smokegrenade: 1, molotov: 1 };
export const GRENADE_TOTAL_CAP = 4;

/**
 * Weapon data, roughly CS:GO values. Inaccuracy and spread are in milliradians (as in CS:GO
 * weapon scripts), speeds in m/s, times in seconds.
 */
export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: WeaponSlot;
  category: WeaponCategory;
  price: number;
  /** Price of one magazine of reserve ammo. */
  ammoPrice: number;
  killReward: number;
  damage: number;
  /** Fraction of damage that goes to health when the hit is armored (CS armor ratio * 0.5). */
  armorPen: number;
  /** Damage multiplier per 500 HU (12.7 m) travelled. */
  rangeMod: number;
  /** Max range in meters. */
  range: number;
  /** Meters of penetrable material a bullet can pass through. */
  penetration: number;
  /** Seconds between shots. */
  cycleTime: number;
  automatic: boolean;
  magSize: number;
  reserve: number;
  reloadTime: number;
  deployTime: number;
  maxSpeed: number;
  /** Max speed while scoped (snipers). */
  maxSpeedScoped?: number;
  spread: number;
  inaccStand: number;
  inaccCrouch: number;
  inaccMove: number;
  inaccAir: number;
  /** Added per shot. */
  inaccFire: number;
  /** Scoped inaccuracy (replaces stand/crouch while zoomed). */
  inaccStandScoped?: number;
  inaccCrouchScoped?: number;
  /** Seconds for the fire penalty to decay by 10x. */
  recoveryTime: number;
  pattern: string;
  /** How much of the recoil the camera shows (the rest you have to pull down). */
  viewFollow: number;
  /** Horizontal zoom FOVs (CS 4:3 degrees) per scope level. */
  zoomFovs?: number[];
  tracerEvery: number;
  sound: SoundKind;
  /** Melee reach (knife). */
  meleeRange?: number;
  /** Secondary melee attack (knife stab). */
  altDamage?: number;
  altCycleTime?: number;
  altRange?: number;
  /** Grenades: seconds from the throw to detonation (smokes and molotovs can go off sooner). */
  fuse?: number;
  /** Grenades: throw speed at full strength (m/s). */
  throwSpeed?: number;
}

/** Grenade defs share most gun fields with the knife: no magazine, no spray, no tracers. */
function grenade(id: GrenadeId, name: string, price: number, damage: number, fuse: number): WeaponDef {
  return {
    id,
    name,
    slot: 'grenade',
    category: 'grenade',
    price,
    ammoPrice: 0,
    killReward: 300,
    damage,
    armorPen: 0.5,
    rangeMod: 1,
    range: 0,
    penetration: 0,
    cycleTime: 0.35,
    automatic: false,
    magSize: 0,
    reserve: 0,
    reloadTime: 0,
    deployTime: 0.6,
    maxSpeed: 245 * HU,
    spread: 0,
    inaccStand: 0,
    inaccCrouch: 0,
    inaccMove: 0,
    inaccAir: 0,
    inaccFire: 0,
    recoveryTime: 0.1,
    pattern: 'none',
    viewFollow: 0,
    tracerEvery: 0,
    sound: 'grenade',
    fuse,
    throwSpeed: 750 * HU * 0.9,
  };
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: 'knife',
    name: 'Knife',
    slot: 'knife',
    category: 'knife',
    price: 0,
    ammoPrice: 0,
    killReward: 1500,
    damage: 40,
    armorPen: 0.85,
    rangeMod: 1,
    range: 1.3,
    penetration: 0,
    cycleTime: 0.4,
    automatic: true,
    magSize: 0,
    reserve: 0,
    reloadTime: 0,
    deployTime: 0.5,
    maxSpeed: 250 * HU,
    spread: 0,
    inaccStand: 0,
    inaccCrouch: 0,
    inaccMove: 0,
    inaccAir: 0,
    inaccFire: 0,
    recoveryTime: 0.1,
    pattern: 'none',
    viewFollow: 0,
    tracerEvery: 0,
    sound: 'knife',
    meleeRange: 1.3,
    altDamage: 65,
    altCycleTime: 1.0,
    altRange: 1.0,
  },
  glock: {
    id: 'glock',
    name: 'Glock-18',
    slot: 'secondary',
    category: 'pistol',
    price: 200,
    ammoPrice: 20,
    killReward: 300,
    damage: 30,
    armorPen: 0.47,
    rangeMod: 0.85,
    range: 100,
    penetration: 0.15,
    cycleTime: 0.15,
    automatic: false,
    magSize: 20,
    reserve: 120,
    reloadTime: 2.27,
    deployTime: 1.0,
    maxSpeed: 240 * HU,
    spread: 2.0,
    inaccStand: 5.6,
    inaccCrouch: 4.2,
    inaccMove: 22,
    inaccAir: 180,
    inaccFire: 28,
    recoveryTime: 0.35,
    pattern: 'pistol',
    viewFollow: 0.5,
    tracerEvery: 0,
    sound: 'pistol',
  },
  deagle: {
    id: 'deagle',
    name: 'Desert Eagle',
    slot: 'secondary',
    category: 'pistol',
    price: 700,
    ammoPrice: 40,
    killReward: 300,
    damage: 63,
    armorPen: 0.932,
    rangeMod: 0.81,
    range: 150,
    penetration: 0.35,
    cycleTime: 0.225,
    automatic: false,
    magSize: 7,
    reserve: 35,
    reloadTime: 2.2,
    deployTime: 1.0,
    maxSpeed: 230 * HU,
    spread: 2.0,
    inaccStand: 5.0,
    inaccCrouch: 3.5,
    inaccMove: 45,
    inaccAir: 200,
    inaccFire: 60,
    recoveryTime: 0.7,
    pattern: 'deagle',
    viewFollow: 0.5,
    tracerEvery: 0,
    sound: 'deagle',
  },
  mp9: {
    id: 'mp9',
    name: 'MP9',
    slot: 'primary',
    category: 'smg',
    price: 1250,
    ammoPrice: 20,
    killReward: 600,
    damage: 26,
    armorPen: 0.6,
    rangeMod: 0.87,
    range: 100,
    penetration: 0.2,
    cycleTime: 0.07,
    automatic: true,
    magSize: 30,
    reserve: 120,
    reloadTime: 2.13,
    deployTime: 1.0,
    maxSpeed: 240 * HU,
    spread: 0.6,
    inaccStand: 7,
    inaccCrouch: 5,
    inaccMove: 32,
    inaccAir: 200,
    inaccFire: 4.5,
    recoveryTime: 0.25,
    pattern: 'mp9',
    viewFollow: 0.45,
    tracerEvery: 3,
    sound: 'smg',
  },
  ump45: {
    id: 'ump45',
    name: 'UMP-45',
    slot: 'primary',
    category: 'smg',
    price: 1200,
    ammoPrice: 25,
    killReward: 600,
    damage: 35,
    armorPen: 0.65,
    rangeMod: 0.75,
    range: 100,
    penetration: 0.25,
    cycleTime: 0.09,
    automatic: true,
    magSize: 25,
    reserve: 100,
    reloadTime: 3.5,
    deployTime: 1.0,
    maxSpeed: 230 * HU,
    spread: 1.0,
    inaccStand: 8,
    inaccCrouch: 6,
    inaccMove: 40,
    inaccAir: 200,
    inaccFire: 6,
    recoveryTime: 0.3,
    pattern: 'ump',
    viewFollow: 0.45,
    tracerEvery: 3,
    sound: 'smg',
  },
  ak47: {
    id: 'ak47',
    name: 'AK-47',
    slot: 'primary',
    category: 'rifle',
    price: 2700,
    ammoPrice: 80,
    killReward: 300,
    damage: 36,
    armorPen: 0.775,
    rangeMod: 0.98,
    range: 200,
    penetration: 0.4,
    cycleTime: 0.1,
    automatic: true,
    magSize: 30,
    reserve: 90,
    reloadTime: 2.43,
    deployTime: 1.0,
    maxSpeed: 215 * HU,
    spread: 0.6,
    inaccStand: 4.8,
    inaccCrouch: 3.6,
    inaccMove: 140,
    inaccAir: 300,
    inaccFire: 7.8,
    recoveryTime: 0.38,
    pattern: 'ak',
    viewFollow: 0.45,
    tracerEvery: 3,
    sound: 'rifle_heavy',
  },
  m4a4: {
    id: 'm4a4',
    name: 'M4A4',
    slot: 'primary',
    category: 'rifle',
    price: 3100,
    ammoPrice: 60,
    killReward: 300,
    damage: 33,
    armorPen: 0.7,
    rangeMod: 0.97,
    range: 200,
    penetration: 0.4,
    cycleTime: 0.09,
    automatic: true,
    magSize: 30,
    reserve: 90,
    reloadTime: 3.1,
    deployTime: 1.0,
    maxSpeed: 225 * HU,
    spread: 0.5,
    inaccStand: 4.0,
    inaccCrouch: 3.0,
    inaccMove: 125,
    inaccAir: 280,
    inaccFire: 6.0,
    recoveryTime: 0.35,
    pattern: 'm4',
    viewFollow: 0.45,
    tracerEvery: 3,
    sound: 'rifle_light',
  },
  awp: {
    id: 'awp',
    name: 'AWP',
    slot: 'primary',
    category: 'sniper',
    price: 4750,
    ammoPrice: 125,
    killReward: 100,
    damage: 115,
    armorPen: 0.975,
    rangeMod: 0.99,
    range: 250,
    penetration: 0.6,
    cycleTime: 1.46,
    automatic: false,
    magSize: 5,
    reserve: 30,
    reloadTime: 3.67,
    deployTime: 1.25,
    maxSpeed: 200 * HU,
    maxSpeedScoped: 100 * HU,
    spread: 0.2,
    inaccStand: 60,
    inaccCrouch: 45,
    inaccStandScoped: 2.5,
    inaccCrouchScoped: 1.5,
    inaccMove: 170,
    inaccAir: 400,
    inaccFire: 90,
    recoveryTime: 0.35,
    pattern: 'awp',
    viewFollow: 0.6,
    zoomFovs: [40, 10],
    tracerEvery: 1,
    sound: 'awp',
  },
  hegrenade: grenade('hegrenade', 'HE Grenade', 300, 98, 1.6),
  flashbang: grenade('flashbang', 'Flashbang', 200, 0, 1.6),
  smokegrenade: grenade('smokegrenade', 'Smoke Grenade', 300, 0, 3),
  molotov: { ...grenade('molotov', 'Molotov', 400, 8, 2), armorPen: 1 },
};

export type BuyItem = WeaponId | 'kevlar' | 'helmet' | 'ammo_primary' | 'ammo_secondary';

export const BUY_MENU: { title: string; items: BuyItem[] }[] = [
  { title: 'Pistols', items: ['glock', 'deagle'] },
  { title: 'SMGs', items: ['mp9', 'ump45'] },
  { title: 'Rifles', items: ['m4a4', 'ak47', 'awp'] },
  { title: 'Gear', items: ['kevlar', 'helmet'] },
  { title: 'Grenades', items: ['flashbang', 'smokegrenade', 'hegrenade', 'molotov'] },
  { title: 'Ammo', items: ['ammo_primary', 'ammo_secondary'] },
];

export const GEAR_PRICES = { kevlar: 650, helmet: 1000 } as const;

/**
 * Not a weapon: what run-over hits and wrecked-car injuries are credited with (kill feed "Car",
 * an SMG-sized kill reward). Damage is set per hit; armor doesn't help.
 */
export const CAR_HIT: WeaponDef = { ...WEAPONS.knife, id: 'car' as WeaponId, name: 'Car', killReward: 600, damage: 0, armorPen: 1, rangeMod: 1 };

/** Not a weapon: what falling damage is credited with (kill feed "Fall"). Armor doesn't help. */
export const FALL_HIT: WeaponDef = { ...WEAPONS.knife, id: 'fall' as WeaponId, name: 'Fall', killReward: 0, damage: 0, armorPen: 1, rangeMod: 1 };
