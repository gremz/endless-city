import { HitGroup } from '../ai/hitboxes';
import { HU } from '../core/config';
import { anglesToForward, vec3, type Vec3 } from '../core/math';
import { Contents, DOOR_OWNER, makeBrush, SOLID, type Brush } from '../physics/brush';
import { eyeHeight, hullMaxs, hullMins } from '../player/pmove';
import { KICK_HIT } from '../weapons/weaponDefs';
import { DOOR_STRIDE, DoorFlag, Material, type ChunkData } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';
import { Team, type Actor } from './Actor';
import type { Simulation } from './Simulation';

export const DoorState = { Closed: 0, Open: 1, Broken: 2 } as const;

/** How far away E reaches a door, and how squarely you must look at it. */
export const USE_RANGE = 2;
const USE_FACING = 0.7;
/** Running at a door faster than this and pressing E kicks it in. */
export const KICK_SPEED = 200 * HU;
export const WOOD_HP = 150;
export const METAL_HP = 400;
const KICK_DAMAGE_WOOD = 100;
const KICK_DAMAGE_METAL = 50;
/** Damage to someone standing right behind a door that gets kicked in. */
const KICK_HURT = 20;
/** HE damage to a door at the center of the blast. */
const BLAST_DAMAGE = 260;
const BOT_REACH = 1.1;
const BOT_KICK_COOLDOWN = 1.2;
const THICK = 0.08;

export interface Door {
  /** Collision owner id (DOOR_OWNER + n). */
  owner: number;
  chunkKey: number;
  index: number;
  x: number;
  y: number;
  z: number;
  alongX: boolean;
  width: number;
  height: number;
  metal: boolean;
  locked: boolean;
  /** Direction into the building along the axis the door faces (+1 or -1). */
  inward: number;
  state: number;
  hp: number;
  /** Which way it last swung: +1 into the building, -1 out. */
  side: number;
  /** Sim time of the last state change (the swing animation). */
  changedAt: number;
  kickAt: number;
  brush: Brush;
}

/** A door's state as saved and sent to clients: chunk, index, state, side, hp, locked. */
export type DoorRecord = [chunkKey: number, index: number, state: number, side: number, hp: number, locked: number];

/**
 * Doors: open and close with E, kicked in by running at them, broken by gunfire and blasts.
 * Locked doors only give way to force. A closed door is one moving brush in the collision
 * world (wood can be shot through); open and broken doors don't block anything. Bots open the
 * doors on their way and kick in locked ones. The host (or solo game) runs the rules; online
 * clients apply the host's state.
 */
export class DoorSystem implements StreamerListener {
  readonly doors = new Map<number, Door>();
  /** Doors that differ from how the city generates them, "chunkKey:index" → record. */
  private changed = new Map<string, DoorRecord>();
  private byChunk = new Map<number, Door[]>();
  private nextOwner = DOOR_OWNER;
  /** Bumped whenever any door changes (renderers, net). */
  version = 0;

  constructor(private sim: Simulation) {}

  onChunkLoaded(d: ChunkData): void {
    if (!d.doors.length) return;
    const list: Door[] = [];
    for (let i = 0; i * DOOR_STRIDE < d.doors.length; i++) {
      const o = i * DOOR_STRIDE;
      const alongX = d.doors[o + 3] === 1;
      const x = d.doors[o];
      const y = d.doors[o + 1];
      const z = d.doors[o + 2];
      const width = d.doors[o + 4];
      const height = d.doors[o + 5];
      const flags = d.doors[o + 6];
      const metal = (flags & DoorFlag.Metal) !== 0;
      const hw = width / 2;
      const brush = alongX
        ? makeBrush(x - hw, y, z - THICK / 2, x + hw, y + height, z + THICK / 2, metal ? SOLID : SOLID | Contents.PENETRABLE, metal ? Material.Metal : Material.Wood)
        : makeBrush(x - THICK / 2, y, z - hw, x + THICK / 2, y + height, z + hw, metal ? SOLID : SOLID | Contents.PENETRABLE, metal ? Material.Metal : Material.Wood);
      const door: Door = {
        owner: this.nextOwner++,
        chunkKey: d.key,
        index: i,
        x,
        y,
        z,
        alongX,
        width,
        height,
        metal,
        locked: (flags & DoorFlag.Locked) !== 0,
        inward: d.doors[o + 7],
        state: DoorState.Closed,
        hp: metal ? METAL_HP : WOOD_HP,
        side: 1,
        changedAt: -Infinity,
        kickAt: 0,
        brush,
      };
      const saved = this.changed.get(`${d.key}:${i}`);
      if (saved) {
        door.state = saved[2];
        door.side = saved[3];
        door.hp = saved[4];
        door.locked = saved[5] === 1;
      }
      this.doors.set(door.owner, door);
      list.push(door);
      this.sync(door);
    }
    this.byChunk.set(d.key, list);
    this.version++;
  }

  onChunkUnloaded(key: number): void {
    for (const door of this.byChunk.get(key) ?? []) {
      this.sim.world.clearDynamic(door.owner);
      this.doors.delete(door.owner);
    }
    this.byChunk.delete(key);
    this.version++;
  }

  onChunkVisibility(): void {}

  byOwner(owner: number): Door | undefined {
    return this.doors.get(owner);
  }

  find(chunkKey: number, index: number): Door | undefined {
    return this.byChunk.get(chunkKey)?.[index];
  }

  /** Collision follows state: only a closed door is solid. */
  private sync(door: Door): void {
    if (door.state === DoorState.Closed) this.sim.world.setDynamic(door.owner, [door.brush]);
    else this.sim.world.clearDynamic(door.owner);
  }

  private remember(door: Door): void {
    this.changed.set(`${door.chunkKey}:${door.index}`, [door.chunkKey, door.index, door.state, door.side, door.hp, door.locked ? 1 : 0]);
    this.version++;
  }

  private get authoritative(): boolean {
    return !this.sim.predicting && !this.sim.replica;
  }

  /** The door `a` is looking at within reach, if any. */
  target(a: Actor): Door | null {
    const eyeY = a.move.pos.y + eyeHeight(a.move);
    const f = anglesToForward(vec3(), a.yaw, a.pitch);
    let best: Door | null = null;
    let bestD = USE_RANGE;
    for (const door of this.doors.values()) {
      if (door.state === DoorState.Broken) continue;
      const dx = door.x - a.move.pos.x;
      const dz = door.z - a.move.pos.z;
      const dy = Math.max(door.y, Math.min(eyeY, door.y + door.height)) - eyeY;
      const d = Math.hypot(dx, dy, dz);
      if (d >= bestD || Math.abs(door.y - a.move.pos.y) > 1.5) continue;
      if (d > 0.6 && (f.x * dx + f.y * dy + f.z * dz) / d < USE_FACING) continue;
      best = door;
      bestD = d;
    }
    return best;
  }

  /** E pressed: open, close or kick the door in front of `a`. Returns true if E was used on a door. */
  use(a: Actor): boolean {
    const door = this.target(a);
    if (!door) return false;
    if (!this.authoritative) return true;
    const speed = Math.hypot(a.move.vel.x, a.move.vel.z);
    if (door.state === DoorState.Closed && speed > KICK_SPEED) {
      this.kick(door, a);
      return true;
    }
    if (door.state === DoorState.Closed && door.locked) {
      this.announce(door, 'locked', 8, a.id);
      return true;
    }
    if (door.state === DoorState.Open) {
      if (this.blocked(door)) return true;
      this.set(door, DoorState.Closed, door.side, 'close', a.id);
    } else {
      this.set(door, DoorState.Open, this.awayFrom(door, a.move.pos), 'open', a.id);
    }
    return true;
  }

  /** Swing side that opens the door away from someone standing at `p`. */
  private awayFrom(door: Door, p: Vec3): number {
    const along = door.alongX ? p.z - door.z : p.x - door.x;
    // They're on the outside if they stand opposite the inward direction.
    return along * door.inward <= 0 ? 1 : -1;
  }

  /** Someone standing in the doorway keeps the door from closing. */
  private blocked(door: Door): boolean {
    const b = door.brush;
    for (const a of this.sim.actors) {
      if (!a.alive) continue;
      const p = a.move.pos;
      const mn = hullMins(a.move);
      const mx = hullMaxs(a.move);
      if (p.x + mx.x > b.minX && p.x + mn.x < b.maxX && p.y + mx.y > b.minY && p.y + mn.y < b.maxY && p.z + mx.z > b.minZ && p.z + mn.z < b.maxZ) return true;
    }
    return false;
  }

  /** `by` is who did it (-1 for nobody in particular): the noise gives players away to bots. */
  private set(door: Door, state: number, side: number, action: DoorAction, by = -1): void {
    door.state = state;
    door.side = side;
    door.changedAt = this.sim.time;
    this.sync(door);
    this.remember(door);
    this.announce(door, action, action === 'break' || action === 'kick' ? 45 : 14, by);
  }

  private announce(door: Door, action: DoorAction, noise: number, by: number): void {
    const pos = vec3(door.x, door.y + 1.1, door.z);
    this.sim.events.push({ type: 'door', chunkKey: door.chunkKey, index: door.index, action, state: door.state, side: door.side, pos });
    this.sim.events.push({ type: 'sound', pos, radius: noise, kind: 'door', sourceId: by });
  }

  /**
   * Kick: wood gives way (a locked wooden door takes two kicks), metal only after many. A door
   * that bursts open knocks whoever stands behind it.
   */
  kick(door: Door, a: Actor): void {
    if (!this.authoritative || door.state !== DoorState.Closed) return;
    door.kickAt = this.sim.time + BOT_KICK_COOLDOWN;
    const side = this.awayFrom(door, a.move.pos);
    if (door.locked || door.metal) {
      door.hp -= door.metal ? KICK_DAMAGE_METAL : KICK_DAMAGE_WOOD;
      if (door.hp > 0) {
        this.remember(door);
        this.announce(door, 'kick', 45, a.id);
        return;
      }
      door.locked = false;
      this.set(door, DoorState.Broken, side, 'break', a.id);
    } else {
      this.set(door, DoorState.Open, side, 'kick', a.id);
    }
    this.knock(door, a, side);
  }

  /** Hurt anyone right behind a door that was just kicked in. */
  private knock(door: Door, kicker: Actor, side: number): void {
    const dir = side * door.inward;
    for (const v of this.sim.actors) {
      if (!v.alive || v === kicker || !this.sim.canHit(kicker, v)) continue;
      const p = v.move.pos;
      const across = door.alongX ? p.x - door.x : p.z - door.z;
      const behind = (door.alongX ? p.z - door.z : p.x - door.x) * dir;
      if (Math.abs(across) > door.width / 2 + 0.3 || behind < 0 || behind > 1.4 || Math.abs(p.y - door.y) > 1) continue;
      this.sim.onHit({ attacker: kicker, victim: v, def: KICK_HIT, group: HitGroup.Chest, distance: 0, damageScale: KICK_HURT / KICK_HIT.damage, penetrated: false, pos: vec3(p.x, p.y + 1, p.z) });
    }
  }

  /** Bullets, knives: wear the door down until it breaks. */
  damage(owner: number, amount: number): void {
    const door = this.doors.get(owner);
    if (!door || !this.authoritative || door.state === DoorState.Broken) return;
    door.hp -= amount;
    if (door.hp <= 0) {
      door.locked = false;
      this.set(door, DoorState.Broken, door.side, 'break');
    } else this.remember(door);
  }

  /** HE blast: nearby doors take damage by distance (open ones too). */
  blast(pos: Vec3, radius: number): void {
    if (!this.authoritative) return;
    for (const door of this.doors.values()) {
      if (door.state === DoorState.Broken) continue;
      const d = Math.hypot(door.x - pos.x, door.y + 1 - pos.y, door.z - pos.z);
      if (d < radius) this.damage(door.owner, BLAST_DAMAGE * (1 - d / radius));
    }
  }

  /** Bots open the doors they walk into and kick in the locked ones (host, a few times a second). */
  update(): void {
    const sim = this.sim;
    if (!this.authoritative || (sim.tick & 3) !== 0 || !this.doors.size) return;
    for (const a of sim.actors) {
      if (!a.alive || a.team !== Team.Bots || a.dummy) continue;
      const p = a.move.pos;
      for (const door of this.doors.values()) {
        if (door.state !== DoorState.Closed) continue;
        const dx = Math.abs(door.x - p.x);
        const dz = Math.abs(door.z - p.z);
        if (Math.abs(door.y - p.y) > 1.2) continue;
        const across = door.alongX ? dx : dz;
        const through = door.alongX ? dz : dx;
        if (across > door.width / 2 + 0.2 || through > BOT_REACH) continue;
        if (!door.locked) this.set(door, DoorState.Open, this.awayFrom(door, p), 'open', a.id);
        else if (sim.time >= door.kickAt) this.kick(door, a);
      }
    }
  }

  /** Doors that differ from the generated city (saves, and the host's world state). */
  list(): DoorRecord[] {
    return [...this.changed.values()];
  }

  /** Apply door records (a save, or the host's state on a client). */
  restore(list: readonly DoorRecord[]): void {
    for (const r of list) this.apply(r);
  }

  /** A door event from the host: change state straight away (hp and lock follow in the world state). */
  applyAction(chunkKey: number, index: number, state: number, side: number): void {
    const door = this.find(chunkKey, index);
    const prev = this.changed.get(`${chunkKey}:${index}`);
    const hp = door?.hp ?? prev?.[4] ?? WOOD_HP;
    const locked = state === DoorState.Broken ? 0 : door ? (door.locked ? 1 : 0) : (prev?.[5] ?? 0);
    this.apply([chunkKey, index, state, side, hp, locked]);
  }

  /** Apply one door's state. */
  apply(r: DoorRecord): void {
    const [chunkKey, index, state, side, hp, locked] = r;
    this.changed.set(`${chunkKey}:${index}`, [chunkKey, index, state, side, hp, locked]);
    const door = this.find(chunkKey, index);
    if (door) {
      if (door.state !== state) door.changedAt = this.sim.time;
      door.state = state;
      door.side = side;
      door.hp = hp;
      door.locked = locked === 1;
      this.sync(door);
    }
    this.version++;
  }
}

export type DoorAction = 'open' | 'close' | 'kick' | 'break' | 'locked';
