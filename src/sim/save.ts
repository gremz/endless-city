import type { EncounterManager, SavedEncounter } from '../ai/EncounterManager';
import type { GameParams } from '../core/urlParams';
import { addGrenades, emptyNades, makeWeaponState, type Inventory, type WeaponItem } from '../weapons/Inventory';
import { GRENADE_IDS, isGrenadeId, WEAPONS, type GrenadeId, type WeaponId, type WeaponSlot } from '../weapons/weaponDefs';
import type { Actor } from './Actor';
import { MAX_MONEY } from './Economy';
import { MEDKIT_MAX } from './medkit';
import type { PickupItem, PickupManager, PickupSave, SavedPickup } from './Pickups';
import type { Simulation } from './Simulation';
import { VEHICLE_HEALTH } from './vehicle/Vehicle';
import type { DoorRecord } from './Doors';
import type { PaneRef } from './Glass';
import type { SavedVehicle, VehicleSave, Vehicles } from './vehicle/Vehicles';

export const SAVE_VERSION = 1;

export interface SavedWeapon {
  id: WeaponId;
  clip: number;
  reserve: number;
}

export interface SavedPlayer {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  helmet: boolean;
  medkits: number;
  primary: SavedWeapon | null;
  secondary: SavedWeapon | null;
  active: WeaponSlot;
  /** Carried grenades by type (absent in older saves). */
  grenades?: Partial<Record<GrenadeId, number>>;
}

/** Everything needed to pick a city run back up. Plain JSON. */
export interface SaveData {
  version: typeof SAVE_VERSION;
  /** Wall-clock ms. */
  savedAt: number;
  seed: number;
  seedText: string;
  spawnCx: number;
  spawnCz: number;
  /** Forced difficulty (-1 = by distance). */
  level: number;
  time: number;
  tick: number;
  money: number;
  cleared: number[];
  player: SavedPlayer;
  encounters: SavedEncounter[];
  pickups: PickupSave;
  /** Cars that were driven or wrecked (absent in older saves). */
  vehicles?: VehicleSave;
  /** Doors that were opened, damaged or broken (absent in older saves). */
  doors?: DoorRecord[];
  /** Broken window panes (absent in older saves). */
  glass?: PaneRef[];
  /** Chunk keys seen on the city map. */
  explored: number[];
}

const savedWeapon = (w: WeaponItem | null): SavedWeapon | null => (w ? { id: w.def.id, clip: w.clip, reserve: w.reserve } : null);

/** Snapshot a running city game from player `p`'s side (solo, or a co-op host). `p` must be alive. */
export function captureSave(
  sim: Simulation,
  p: Actor,
  pickups: PickupManager,
  encounters: EncounterManager | null,
  vehicles: Vehicles | null,
  explored: readonly number[],
  now = Date.now(),
): SaveData {
  const { params } = sim;
  return {
    version: SAVE_VERSION,
    savedAt: now,
    seed: params.seed,
    seedText: params.seedText,
    spawnCx: params.spawnCx,
    spawnCz: params.spawnCz,
    level: params.level,
    time: sim.time,
    tick: sim.tick,
    money: p.money,
    cleared: [...sim.cleared],
    player: {
      x: p.move.pos.x,
      y: p.move.pos.y,
      z: p.move.pos.z,
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      armor: p.armor,
      helmet: p.helmet,
      medkits: p.medkits,
      primary: savedWeapon(p.inv.primary),
      secondary: savedWeapon(p.inv.secondary),
      active: p.inv.active,
      grenades: { ...p.inv.nades },
    },
    encounters: encounters?.serialize() ?? [],
    pickups: pickups.serialize(),
    vehicles: vehicles?.serialize() ?? { taken: [], cars: [] },
    doors: sim.doors.list(),
    glass: sim.glass.list(),
    explored: [...explored],
  };
}

/**
 * Restore the world state (clock, progress, items). Call before any chunk streams in. The saved
 * death stash goes to the actor with id `owner` (the player the save is loaded for).
 */
export function applyWorldSave(
  save: SaveData,
  sim: Simulation,
  pickups: PickupManager,
  encounters: EncounterManager | null,
  vehicles: Vehicles | null,
  owner: number,
): void {
  sim.time = save.time;
  sim.tick = save.tick;
  sim.cleared.clear();
  for (const k of save.cleared) sim.cleared.add(k);
  encounters?.restore(save.encounters);
  pickups.restore(save.pickups, owner);
  if (save.vehicles) vehicles?.restore(save.vehicles);
  sim.doors.restore(save.doors ?? []);
  sim.glass.restore(save.glass ?? []);
}

/**
 * Restore the player's vitals, loadout and money (position is placed by the game once the floor
 * exists).
 */
export function applyPlayerSave(s: SavedPlayer, p: Actor, money: number): void {
  p.money = money;
  p.alive = true;
  p.diedAt = -1;
  p.health = s.health;
  p.armor = s.armor;
  p.helmet = s.helmet;
  p.medkits = s.medkits;
  p.healEnd = -1;
  const item = (w: SavedWeapon | null): WeaponItem | null => (w ? { def: WEAPONS[w.id], clip: w.clip, reserve: w.reserve } : null);
  const inv: Inventory = {
    primary: item(s.primary),
    secondary: item(s.secondary),
    knife: { def: WEAPONS.knife, clip: 0, reserve: 0 },
    grenade: null,
    nades: emptyNades(),
    nadeSel: 'hegrenade',
    active: 'knife',
    last: 'knife',
  };
  for (const id of GRENADE_IDS) addGrenades(inv, id, s.grenades?.[id] ?? 0);
  inv.active = inv[s.active] ? s.active : inv.primary ? 'primary' : inv.secondary ? 'secondary' : 'knife';
  inv.last = inv.active === 'primary' && inv.secondary ? 'secondary' : 'knife';
  p.inv = inv;
  p.wpn = makeWeaponState();
  p.yaw = p.prevYaw = s.yaw;
  p.pitch = s.pitch;
}

/** Game parameters for a save's world, keeping local flags (debug, tick rate) from `base`. */
export function paramsFromSave(save: SaveData, base: GameParams): GameParams {
  return {
    ...base,
    seed: save.seed,
    seedText: save.seedText,
    world: 'city',
    spawnCx: save.spawnCx,
    spawnCz: save.spawnCz,
    level: save.level,
  };
}

// ---- validation (saves come from localStorage and may be stale or hand-edited) ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

class Invalid extends Error {}
function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Invalid(what);
  return v;
}

const isWeaponId = (v: unknown): v is WeaponId => typeof v === 'string' && Object.hasOwn(WEAPONS, v);

function weapon(v: unknown, slot: 'primary' | 'secondary'): SavedWeapon | null {
  if (v === null) return null;
  if (!isObj(v) || !isWeaponId(v.id) || WEAPONS[v.id].slot !== slot) throw new Invalid(`${slot} weapon`);
  const def = WEAPONS[v.id];
  return {
    id: v.id,
    clip: clamp(need(int(v.clip), 'clip'), 0, def.magSize),
    reserve: clamp(need(int(v.reserve), 'reserve'), 0, def.reserve),
  };
}

function pickupItem(v: unknown): PickupItem {
  if (isObj(v) && v.kind === 'medkit') return { kind: 'medkit' };
  if (isObj(v) && v.kind === 'grenade' && typeof v.grenade === 'string' && isGrenadeId(v.grenade)) {
    return { kind: 'grenade', grenade: v.grenade, count: clamp(need(int(v.count), 'count'), 1, 4) };
  }
  if (isObj(v) && v.kind === 'weapon' && isWeaponId(v.weapon) && v.weapon !== 'knife' && !isGrenadeId(v.weapon)) {
    const def = WEAPONS[v.weapon];
    return {
      kind: 'weapon',
      weapon: v.weapon,
      clip: clamp(need(int(v.clip), 'clip'), 0, def.magSize),
      reserve: clamp(need(int(v.reserve), 'reserve'), 0, def.reserve),
    };
  }
  throw new Invalid('pickup item');
}

function vehicleSave(v: unknown): VehicleSave {
  if (v === undefined) return { taken: [], cars: [] };
  if (!isObj(v) || !Array.isArray(v.taken) || !Array.isArray(v.cars)) throw new Invalid('vehicles');
  const taken = v.taken.map((t) => {
    if (typeof t !== 'string' || !/^\d+:\d+$/.test(t)) throw new Invalid('vehicle slot');
    return t;
  });
  const cars: SavedVehicle[] = v.cars.map((c) => {
    if (!isObj(c) || !Array.isArray(c.pos) || c.pos.length !== 3) throw new Invalid('car');
    return {
      pos: c.pos.map((x) => need(num(x), 'car pos')) as [number, number, number],
      yaw: need(num(c.yaw), 'car yaw'),
      paint: clamp(need(int(c.paint), 'paint'), 0, 255),
      hatch: c.hatch === true,
      health: clamp(need(num(c.health), 'car health'), 0, VEHICLE_HEALTH),
      destroyed: c.destroyed === true,
    };
  });
  return { taken, cars };
}

function intList(v: unknown, what: string): number[] {
  if (!Array.isArray(v)) throw new Invalid(what);
  return v.map((k) => need(int(k), what));
}

function doorSave(v: unknown): DoorRecord[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Invalid('doors');
  return v.map((r) => {
    if (!Array.isArray(r) || r.length !== 6) throw new Invalid('door');
    const [k, i, state, side, hp, locked] = r.map((x) => need(num(x), 'door'));
    return [need(int(k), 'door'), need(int(i), 'door'), clamp(Math.round(state), 0, 2), side < 0 ? -1 : 1, clamp(hp, -1000, 1000), locked ? 1 : 0];
  });
}

function glassSave(v: unknown): PaneRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Invalid('glass');
  return v.map((r) => {
    if (!Array.isArray(r) || r.length !== 2) throw new Invalid('pane');
    return [need(int(r[0]), 'pane'), need(int(r[1]), 'pane')];
  });
}

/** Parse untrusted JSON into a SaveData, or null if it isn't a usable save. */
export function validateSave(raw: unknown): SaveData | null {
  try {
    if (!isObj(raw) || raw.version !== SAVE_VERSION) return null;
    const p = raw.player;
    if (!isObj(p)) return null;
    const active = p.active === 'primary' || p.active === 'secondary' || p.active === 'knife' || p.active === 'grenade' ? p.active : 'knife';
    const grenades: Partial<Record<GrenadeId, number>> = {};
    if (isObj(p.grenades)) {
      for (const id of GRENADE_IDS) grenades[id] = clamp(int(p.grenades[id]) ?? 0, 0, 4);
    }
    const player: SavedPlayer = {
      x: need(num(p.x), 'x'),
      y: need(num(p.y), 'y'),
      z: need(num(p.z), 'z'),
      yaw: need(num(p.yaw), 'yaw'),
      pitch: clamp(need(num(p.pitch), 'pitch'), -1.56, 1.56),
      health: clamp(need(num(p.health), 'health'), 1, 100),
      armor: clamp(need(num(p.armor), 'armor'), 0, 100),
      helmet: p.helmet === true,
      medkits: clamp(need(int(p.medkits), 'medkits'), 0, MEDKIT_MAX),
      primary: weapon(p.primary, 'primary'),
      secondary: weapon(p.secondary, 'secondary'),
      active,
      grenades,
    };
    if (!Array.isArray(raw.encounters)) return null;
    const encounters: SavedEncounter[] = raw.encounters.map((e) => {
      if (!isObj(e)) throw new Invalid('encounter');
      return {
        key: need(int(e.key), 'key'),
        level: clamp(need(int(e.level), 'level'), 0, 10),
        cleared: e.cleared === true,
        remaining: clamp(need(int(e.remaining), 'remaining'), 0, 16),
        spawnedOnce: e.spawnedOnce === true,
      };
    });
    const pk = raw.pickups;
    if (!isObj(pk) || !Array.isArray(pk.taken) || !Array.isArray(pk.drops)) return null;
    const taken: [string, number][] = pk.taken.map((t) => {
      if (!Array.isArray(t) || typeof t[0] !== 'string' || !/^\d+:\d+$/.test(t[0])) throw new Invalid('taken');
      return [t[0], need(num(t[1]), 'taken time')];
    });
    const drops: SavedPickup[] = pk.drops.map((d) => {
      if (!isObj(d) || !Array.isArray(d.pos) || d.pos.length !== 3) throw new Invalid('drop');
      const pos = d.pos.map((c) => need(num(c), 'drop pos')) as [number, number, number];
      return {
        item: pickupItem(d.item),
        pos,
        yaw: num(d.yaw) ?? 0,
        stash: d.stash === true,
        expiresAt: d.expiresAt === null ? null : need(num(d.expiresAt), 'expiresAt'),
      };
    });
    const seed = need(int(raw.seed), 'seed');
    return {
      version: SAVE_VERSION,
      savedAt: num(raw.savedAt) ?? 0,
      seed: seed >>> 0,
      seedText: typeof raw.seedText === 'string' ? raw.seedText : String(seed >>> 0),
      spawnCx: need(int(raw.spawnCx), 'spawnCx'),
      spawnCz: need(int(raw.spawnCz), 'spawnCz'),
      level: clamp(int(raw.level) ?? -1, -1, 10),
      time: Math.max(0, need(num(raw.time), 'time')),
      tick: Math.max(0, need(int(raw.tick), 'tick')),
      money: clamp(need(int(raw.money), 'money'), 0, MAX_MONEY),
      cleared: intList(raw.cleared, 'cleared'),
      player,
      encounters,
      pickups: { taken, drops },
      vehicles: vehicleSave(raw.vehicles),
      doors: doorSave(raw.doors),
      glass: glassSave(raw.glass),
      explored: intList(raw.explored ?? [], 'explored'),
    };
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}
