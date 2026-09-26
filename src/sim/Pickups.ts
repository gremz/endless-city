import { hash3, hash4, Salt, sfc32 } from '../core/rng';
import { vec3, type Vec3 } from '../core/math';
import { Buttons } from '../input/UserCmd';
import { MASK_PLAYER } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { addGrenades, makeInventory, type WeaponItem } from '../weapons/Inventory';
import { equipSlot, type HitInfo } from '../weapons/WeaponSystem';
import { GRENADE_IDS, WEAPONS, type GrenadeId, type WeaponId } from '../weapons/weaponDefs';
import { chunkKey, worldToChunk } from '../world/chunkMath';
import type { ChunkData } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';
import { Team, type Actor } from './Actor';
import { MEDKIT_MAX } from './medkit';
import type { Simulation, SimSystem } from './Simulation';

/** Seconds before a taken city pack comes back. */
export const PACK_RESPAWN = 180;
/** Seconds something dropped on the ground (bot loot, swapped-out guns) stays there. */
export const DROP_LIFETIME = 60;
/** Chance a bot killed by the player also drops a health pack. */
export const DROP_CHANCE = 0.25;
/** Walk-over pickup reach. */
const REACH = 1;
const REACH_Y = 1.6;
/** Reach for the E swap prompt. */
export const SWAP_REACH = 1.6;
export const MAX_ITEMS = 96;

export type PickupItem =
  | { kind: 'medkit' }
  | { kind: 'weapon'; weapon: WeaponId; clip: number; reserve: number }
  | { kind: 'grenade'; grenade: GrenadeId; count: number };

export interface Pickup {
  id: number;
  item: PickupItem;
  pos: Vec3;
  /** Heading of the item lying on the ground. */
  yaw: number;
  chunkKey: number;
  /** Index into the chunk's pickup spots, or -1 for something dropped. */
  slot: number;
  /** Part of a player's death stash: never expires, never evicted. */
  stash: boolean;
  /** Actor id of the player whose stash this is (-1 for ordinary items). */
  owner: number;
  /** Sim time it vanishes (Infinity for city packs and the stash). */
  expiresAt: number;
  /** Sim time it appeared (for the pop-in animation). */
  spawnedAt: number;
}

/** A dropped item as stored in a save (city packs are regenerated instead). */
export interface SavedPickup {
  item: PickupItem;
  pos: [number, number, number];
  yaw: number;
  stash: boolean;
  /** null = never. */
  expiresAt: number | null;
}

export interface PickupSave {
  taken: [string, number][];
  drops: SavedPickup[];
}

const DROP_MINS = vec3(-0.15, 0, -0.15);
const DROP_MAXS = vec3(0.15, 0.3, 0.15);

/**
 * Items lying in the world: city health packs from chunk generation (respawning after being
 * taken, remembered across chunk reloads), loot dropped by dead bots, and the player's death
 * stash. Walking over a pack or a gun for an empty slot takes it, guns you already carry give
 * their ammo, and E swaps the gun in hand for another one.
 */
export class PickupManager implements SimSystem, StreamerListener {
  readonly items: Pickup[] = [];
  /** Per player: nearest gun they could swap to with E this tick. */
  private swapCandidates = new Map<number, Pickup>();
  /** City spots per resident chunk. */
  private spots = new Map<number, Float32Array>();
  /** "chunkKey:slot" → sim time the taken pack returns. */
  private taken = new Map<string, number>();
  private nextId = 1;
  private fullMsgAt = new Map<number, number>();
  private tr = makeTrace();

  constructor(private sim: Simulation) {}

  onChunkLoaded(data: ChunkData): void {
    if (!data.pickups.length) return;
    this.spots.set(data.key, data.pickups);
    for (let i = 0; i < data.pickups.length / 3; i++) {
      if ((this.taken.get(`${data.key}:${i}`) ?? -Infinity) > this.sim.time) continue;
      this.taken.delete(`${data.key}:${i}`);
      this.addSpot(data.key, i);
    }
  }

  onChunkUnloaded(key: number): void {
    this.spots.delete(key);
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].chunkKey === key && this.items[i].slot >= 0) this.items.splice(i, 1);
    }
  }

  onChunkVisibility(): void {}

  /** Where a player's death stash lies, if there is one. */
  stashPos(owner: number): Vec3 | null {
    return this.items.find((p) => p.stash && p.owner === owner)?.pos ?? null;
  }

  /**
   * Mirror the host's items (online clients, where nothing is simulated here). `swapId` is the
   * pickup the host says `actorId` could swap to, or -1.
   */
  replicate(items: readonly Pickup[], actorId: number, swapId: number): void {
    this.items.length = 0;
    this.items.push(...items);
    this.swapCandidates.clear();
    const swap = items.find((p) => p.id === swapId);
    if (swap) this.swapCandidates.set(actorId, swap);
  }

  /** Point the local swap prompt at a pickup (online clients). */
  setSwapCandidate(actorId: number, swapId: number): void {
    const swap = this.items.find((p) => p.id === swapId);
    if (swap) this.swapCandidates.set(actorId, swap);
    else this.swapCandidates.delete(actorId);
  }

  /** Remove a player's death stash (they left the game). */
  clearStash(owner: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].owner === owner) this.items.splice(i, 1);
  }

  /** The gun a player would take with E right now. */
  swapCandidate(actorId: number): Pickup | null {
    return this.swapCandidates.get(actorId) ?? null;
  }

  private addSpot(key: number, slot: number): void {
    const s = this.spots.get(key);
    if (!s) return;
    const pos = vec3(s[slot * 3], s[slot * 3 + 1], s[slot * 3 + 2]);
    this.add({ kind: 'medkit' }, pos, (key * 7 + slot) % 6.28, key, slot, -1, Infinity);
  }

  private add(item: PickupItem, pos: Vec3, yaw: number, key: number, slot: number, owner: number, expiresAt: number): Pickup | null {
    if (this.items.length >= MAX_ITEMS) {
      // Too crowded: the oldest ordinary drop makes room.
      const i = this.items.findIndex((p) => p.slot < 0 && !p.stash);
      if (i < 0) return null;
      this.items.splice(i, 1);
    }
    const stash = owner >= 0;
    const p: Pickup = { id: this.nextId++, item, pos, yaw, chunkKey: key, slot, stash, owner, expiresAt, spawnedAt: this.sim.time };
    this.items.push(p);
    return p;
  }

  /** Drop an item at a world position; with an `owner` it becomes part of their death stash. */
  drop(x: number, y: number, z: number, item: PickupItem = { kind: 'medkit' }, yaw = 0, owner = -1, lifetime = DROP_LIFETIME): Pickup | null {
    const key = chunkKey(worldToChunk(x), worldToChunk(z));
    return this.add(item, vec3(x, y + 0.02, z), yaw, key, -1, owner, owner >= 0 ? Infinity : this.sim.time + lifetime);
  }

  /**
   * Scatter an actor's guns (and, for a player, carried medkits) around their feet, then
   * leave them with just the knife. A player's drop becomes their death stash.
   */
  dropInventory(a: Actor, stash: boolean): void {
    const sim = this.sim;
    const r = sfc32(hash4(sim.params.seed, a.id, sim.tick, Salt.Loot));
    const items: PickupItem[] = [];
    for (const w of [a.inv.primary, a.inv.secondary]) if (w) items.push(weaponPickup(w));
    for (const id of GRENADE_IDS) if (a.inv.nades[id] > 0) items.push({ kind: 'grenade', grenade: id, count: a.inv.nades[id] });
    if (stash) for (let i = 0; i < a.medkits; i++) items.push({ kind: 'medkit' });
    const base = r() * Math.PI * 2;
    items.forEach((item, i) => {
      const ang = base + (i / items.length) * Math.PI * 2 + (r() - 0.5) * 0.6;
      const dist = 0.3 + r() * 0.5;
      const [x, y, z] = this.groundSpot(a.move.pos, Math.sin(ang) * dist, Math.cos(ang) * dist);
      const keep = a.keepLoot && item.kind === 'weapon';
      this.drop(x, y, z, item, r() * Math.PI * 2, stash ? a.id : -1, keep ? Infinity : DROP_LIFETIME);
    });
    a.inv = makeInventory(null);
    a.medkits = 0;
  }

  /** A floor spot near `from`, offset by (dx, dz) but never through a wall. */
  private groundSpot(from: Vec3, dx: number, dz: number): [number, number, number] {
    const tr = this.tr;
    const w = this.sim.world;
    const y = from.y + 0.4;
    w.traceBox(tr, vec3(from.x, y, from.z), vec3(from.x + dx, y, from.z + dz), DROP_MINS, DROP_MAXS, MASK_PLAYER);
    const x = tr.startSolid ? from.x : tr.endX;
    const z = tr.startSolid ? from.z : tr.endZ;
    w.traceBox(tr, vec3(x, y, z), vec3(x, y - 30, z), DROP_MINS, DROP_MAXS, MASK_PLAYER);
    return [x, tr.fraction < 1 && !tr.startSolid ? tr.endY : from.y, z];
  }

  update(sim: Simulation): void {
    const t = sim.time;
    // Respawns (4 Hz is plenty).
    if ((sim.tick & 15) === 0) {
      for (const [k, at] of this.taken) {
        if (at > t) continue;
        const [key, slot] = k.split(':').map(Number);
        if (!this.spots.has(key)) continue;
        this.taken.delete(k);
        this.addSpot(key, slot);
      }
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].expiresAt <= t) this.items.splice(i, 1);
    }
    this.swapCandidates.clear();
    for (const p of sim.players) if (p.alive && p.vehicle < 0) this.touch(p, sim);
  }

  /** Walk-over pickups and the E swap for one player. */
  private touch(p: Actor, sim: Simulation): void {
    const t = sim.time;
    const pos = p.move.pos;
    let swapD = SWAP_REACH;
    let swap: Pickup | null = null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (Math.abs(it.pos.y - pos.y) > REACH_Y) continue;
      const d = Math.hypot(it.pos.x - pos.x, it.pos.z - pos.z);
      if (it.item.kind === 'weapon') {
        const def = WEAPONS[it.item.weapon];
        const cur = p.inv[def.slot];
        if (cur && cur.def.id !== def.id) {
          if (d < swapD) {
            swapD = d;
            swap = it;
          }
          continue;
        }
        if (d > REACH) continue;
        if (!cur) {
          // Empty slot: take it as it lies, keep holding what you hold.
          p.inv[def.slot as 'primary' | 'secondary'] = { def, clip: it.item.clip, reserve: it.item.reserve };
          this.remove(i, t);
          sim.events.push({ type: 'pickup', actorId: p.id, item: def.id, pos: it.pos, amount: 1 });
        } else {
          this.takeAmmo(i, p, cur, sim);
        }
        continue;
      }
      if (d > REACH) continue;
      if (it.item.kind === 'grenade') {
        const took = addGrenades(p.inv, it.item.grenade, it.item.count);
        if (took <= 0) continue;
        it.item.count -= took;
        if (it.item.count <= 0) this.remove(i, t);
        sim.events.push({ type: 'pickup', actorId: p.id, item: it.item.grenade, pos: it.pos, amount: took });
        continue;
      }
      if (p.medkits >= MEDKIT_MAX) {
        if (t - (this.fullMsgAt.get(p.id) ?? -100) > 3) {
          this.fullMsgAt.set(p.id, t);
          sim.events.push({ type: 'message', actorId: p.id, text: `Medkits full (${MEDKIT_MAX})` });
        }
        continue;
      }
      p.medkits++;
      this.remove(i, t);
      sim.events.push({ type: 'pickup', actorId: p.id, item: 'medkit', pos: it.pos, amount: 1 });
    }
    if (!swap) return;
    if (sim.cmdFor(p).pressed & Buttons.USE && !sim.usedVehicle(p.id)) this.swap(swap, p, sim);
    else this.swapCandidates.set(p.id, swap);
  }

  /** Same gun as the one carried: move its rounds into the reserve. */
  private takeAmmo(i: number, p: Actor, cur: WeaponItem, sim: Simulation): void {
    const it = this.items[i];
    if (it.item.kind !== 'weapon') return;
    const room = cur.def.reserve - cur.reserve;
    if (room <= 0) return;
    const fromReserve = Math.min(room, it.item.reserve);
    const fromClip = Math.min(room - fromReserve, it.item.clip);
    const amount = fromReserve + fromClip;
    if (amount <= 0) return;
    it.item.reserve -= fromReserve;
    it.item.clip -= fromClip;
    cur.reserve += amount;
    if (it.item.reserve + it.item.clip <= 0) this.remove(i, sim.time);
    sim.events.push({ type: 'pickup', actorId: p.id, item: 'ammo', pos: it.pos, amount });
  }

  /** E on a gun: drop the one in that slot at your feet, take this one and draw it. */
  private swap(it: Pickup, p: Actor, sim: Simulation): void {
    if (it.item.kind !== 'weapon') return;
    const def = WEAPONS[it.item.weapon];
    const slot = def.slot as 'primary' | 'secondary';
    const old = p.inv[slot];
    p.inv[slot] = { def, clip: it.item.clip, reserve: it.item.reserve };
    this.remove(this.items.indexOf(it), sim.time);
    if (old) this.drop(p.move.pos.x, p.move.pos.y, p.move.pos.z, weaponPickup(old), p.yaw + Math.PI / 2);
    equipSlot(p, slot, sim);
    sim.events.push({ type: 'pickup', actorId: p.id, item: def.id, pos: it.pos, amount: 1 });
  }

  private remove(i: number, t: number): void {
    const it = this.items[i];
    this.items.splice(i, 1);
    if (it.slot >= 0) this.taken.set(`${it.chunkKey}:${it.slot}`, t + PACK_RESPAWN);
  }

  onHit(sim: Simulation, info: HitInfo, killed: boolean): void {
    const v = info.victim;
    // A dead hostage had nothing on him.
    if (!killed || v.dummy || v.captive) return;
    if (v.team === Team.Player) {
      // Dying again loses the stash you never went back for.
      for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].owner === v.id) this.items.splice(i, 1);
      this.dropInventory(v, true);
      return;
    }
    if (v.team !== Team.Bots) return;
    this.dropInventory(v, false);
    if (info.attacker.team === Team.Player && dropRoll(sim.params.seed, v.id, sim.tick) < DROP_CHANCE) {
      const [x, y, z] = this.groundSpot(v.move.pos, 0.2, -0.3);
      this.drop(x, y, z);
    }
  }

  serialize(): PickupSave {
    return {
      taken: [...this.taken],
      drops: this.items
        .filter((p) => p.slot < 0)
        .map((p) => ({
          item: { ...p.item },
          pos: [p.pos.x, p.pos.y, p.pos.z],
          yaw: p.yaw,
          stash: p.stash,
          expiresAt: Number.isFinite(p.expiresAt) ? p.expiresAt : null,
        })),
    };
  }

  /**
   * Bring back saved drops and pack timers (call with the sim clock already restored). The
   * saved death stash goes to `stashOwner`.
   */
  restore(s: PickupSave, stashOwner: number): void {
    this.taken = new Map(s.taken);
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].slot < 0) this.items.splice(i, 1);
    for (const d of s.drops) {
      const [x, y, z] = d.pos;
      const owner = d.stash ? stashOwner : -1;
      this.add({ ...d.item }, vec3(x, y, z), d.yaw, chunkKey(worldToChunk(x), worldToChunk(z)), -1, owner, d.expiresAt ?? Infinity);
    }
  }
}

export function weaponPickup(w: WeaponItem): PickupItem {
  return { kind: 'weapon', weapon: w.def.id, clip: w.clip, reserve: w.reserve };
}

/** Deterministic 0..1 loot roll for a kill. */
export function dropRoll(seed: number, victimId: number, tick: number): number {
  return sfc32(hash3(seed, victimId, tick, Salt.Loot))();
}
