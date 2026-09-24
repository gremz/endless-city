import type { SimEvent } from '../core/events';
import type { GameParams } from '../core/urlParams';
import type { UserCmd } from '../input/UserCmd';
import type { Actor } from '../sim/Actor';
import type { Pickup, PickupItem } from '../sim/Pickups';
import type { Vehicle } from '../sim/vehicle/Vehicle';
import type { Inventory, WeaponState } from '../weapons/Inventory';
import type { BuyItem, GrenadeId, WeaponId, WeaponSlot } from '../weapons/weaponDefs';

/**
 * Wire format between a host's ServerGame and its clients. Commands and snapshots are compact
 * binary sent on the unreliable channel; everything else is JSON on the reliable channel.
 */
export const PROTOCOL_VERSION = 2;
/** A snapshot goes out every this many server ticks (32 Hz at 64 Hz). */
export const SNAPSHOT_EVERY = 2;
/** Commands per packet: each one repeats the last few in case packets are lost. */
export const CMD_REDUNDANCY = 4;
export const MAX_PLAYERS = 4;

export const Bin = { Cmds: 1, Snapshot: 2 } as const;

// ---------------------------------------------------------------- reliable (JSON) messages

/** World settings a client needs to build the same city as the host. */
export type NetParams = Pick<
  GameParams,
  'seed' | 'seedText' | 'world' | 'noBots' | 'level' | 'spawnCx' | 'spawnCz' | 'tickRate' | 'hour' | 'weather'
>;

export interface NetEncounter {
  key: number;
  level: number;
  cleared: boolean;
  active: boolean;
}

/** A pickup as sent to clients (Infinity is not JSON). */
export interface NetPickup {
  id: number;
  item: PickupItem;
  pos: [number, number, number];
  yaw: number;
  chunkKey: number;
  slot: number;
  owner: number;
  expiresAt: number | null;
  spawnedAt: number;
}

export type ClientMsg =
  | { t: 'hello'; name: string; version: number; autoBhop: boolean }
  | { t: 'buy'; item: BuyItem }
  | { t: 'chat'; text: string };

export type ServerMsg =
  | { t: 'welcome'; actorId: number; params: NetParams; tick: number; time: number }
  | { t: 'reject'; reason: string }
  | { t: 'roster'; add: [id: number, name: string, team: number, dummy: boolean][] }
  | { t: 'ev'; e: SimEvent[] }
  | { t: 'pickups'; items: NetPickup[] }
  | { t: 'world'; cleared: number[]; enc: NetEncounter[] }
  | { t: 'chat'; from: string; text: string }
  /** Per player: actor id, name, kills, deaths, money. */
  | { t: 'scores'; s: [id: number, name: string, kills: number, deaths: number, money: number][] };

export function netParams(p: GameParams): NetParams {
  return {
    seed: p.seed,
    seedText: p.seedText,
    world: p.world,
    noBots: p.noBots,
    level: p.level,
    spawnCx: p.spawnCx,
    spawnCz: p.spawnCz,
    tickRate: p.tickRate,
    hour: p.hour,
    weather: p.weather,
  };
}

export function netPickup(p: Pickup): NetPickup {
  return {
    id: p.id,
    item: p.item,
    pos: [p.pos.x, p.pos.y, p.pos.z],
    yaw: p.yaw,
    chunkKey: p.chunkKey,
    slot: p.slot,
    owner: p.owner,
    expiresAt: Number.isFinite(p.expiresAt) ? p.expiresAt : null,
    spawnedAt: p.spawnedAt,
  };
}

export function fromNetPickup(n: NetPickup): Pickup {
  return {
    id: n.id,
    item: n.item,
    pos: { x: n.pos[0], y: n.pos[1], z: n.pos[2] },
    yaw: n.yaw,
    chunkKey: n.chunkKey,
    slot: n.slot,
    stash: n.owner >= 0,
    owner: n.owner,
    expiresAt: n.expiresAt ?? Infinity,
    spawnedAt: n.spawnedAt,
  };
}

/** JSON with numbers rounded to 0.1 mm / 0.1 ms: smaller packets, same behaviour. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 1e4) / 1e4 : x));
}

// ---------------------------------------------------------------- binary helpers

class Writer {
  private buf = new ArrayBuffer(1024);
  private view = new DataView(this.buf);
  off = 0;

  private need(n: number): void {
    if (this.off + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.off + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.off));
    this.buf = next;
    this.view = new DataView(next);
  }
  u8(v: number) {
    this.need(1);
    this.view.setUint8(this.off, v);
    this.off += 1;
  }
  i8(v: number) {
    this.need(1);
    this.view.setInt8(this.off, v);
    this.off += 1;
  }
  u16(v: number) {
    this.need(2);
    this.view.setUint16(this.off, v, true);
    this.off += 2;
  }
  u32(v: number) {
    this.need(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
  }
  f32(v: number) {
    this.need(4);
    this.view.setFloat32(this.off, v, true);
    this.off += 4;
  }
  f64(v: number) {
    this.need(8);
    this.view.setFloat64(this.off, v, true);
    this.off += 8;
  }
  bytes(b: Uint8Array) {
    this.u32(b.length);
    this.need(b.length);
    new Uint8Array(this.buf, this.off, b.length).set(b);
    this.off += b.length;
  }
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.off);
  }
}

class Reader {
  private view: DataView;
  off = 0;
  constructor(private buf: ArrayBuffer) {
    this.view = new DataView(buf);
  }
  u8() {
    return this.view.getUint8(this.off++);
  }
  i8() {
    return this.view.getInt8(this.off++);
  }
  u16() {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  f32() {
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }
  f64() {
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }
  bytes(): Uint8Array {
    const n = this.u32();
    const b = new Uint8Array(this.buf, this.off, n);
    this.off += n;
    return b;
  }
}

export function binKind(buf: ArrayBuffer): number {
  return buf.byteLength ? new Uint8Array(buf)[0] : 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- commands

export interface SeqCmd {
  seq: number;
  cmd: UserCmd;
}

export interface CmdPacket {
  /** Latest snapshot the client has (for the host's stats). */
  ackSnapshot: number;
  /** Host time the client is drawing other actors at (lag compensation). */
  viewTime: number;
  cmds: SeqCmd[];
}

export function encodeCmds(p: CmdPacket): ArrayBuffer {
  const w = new Writer();
  w.u8(Bin.Cmds);
  w.u32(p.ackSnapshot);
  w.f64(p.viewTime);
  w.u8(p.cmds.length);
  for (const { seq, cmd } of p.cmds) {
    w.u32(seq);
    w.f32(cmd.yaw);
    w.f32(cmd.pitch);
    w.i8(Math.round(Math.max(-1, Math.min(1, cmd.forward)) * 127));
    w.i8(Math.round(Math.max(-1, Math.min(1, cmd.side)) * 127));
    w.u16(cmd.buttons);
    w.u16(cmd.pressed);
    w.f32(cmd.attackYaw);
    w.f32(cmd.attackPitch);
    w.i8(cmd.weaponSelect);
  }
  return w.finish();
}

export function decodeCmds(buf: ArrayBuffer): CmdPacket {
  const r = new Reader(buf);
  r.u8();
  const ackSnapshot = r.u32();
  const viewTime = r.f64();
  const n = r.u8();
  const cmds: SeqCmd[] = [];
  for (let i = 0; i < n; i++) {
    const seq = r.u32();
    const cmd: UserCmd = {
      yaw: r.f32(),
      pitch: r.f32(),
      forward: r.i8() / 127,
      side: r.i8() / 127,
      buttons: r.u16(),
      pressed: r.u16(),
      attackYaw: r.f32(),
      attackPitch: r.f32(),
      weaponSelect: r.i8(),
    };
    cmds.push({ seq, cmd });
  }
  return { ackSnapshot, viewTime, cmds };
}

// ---------------------------------------------------------------- snapshots

export const Flag = {
  Alive: 1,
  OnGround: 2,
  Ducked: 4,
  Flashlight: 8,
  Engaging: 16,
  Dummy: 32,
  Helmet: 64,
  HasPrimary: 128,
  HasSecondary: 256,
  Noclip: 512,
  Healing: 1024,
} as const;

const SLOTS: readonly WeaponSlot[] = ['primary', 'secondary', 'knife', 'grenade'];

/** What every client sees of an actor. */
export interface NetActor {
  id: number;
  team: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  duck: number;
  health: number;
  armor: number;
  slot: WeaponSlot;
  diedAt: number;
}

export interface NetInv {
  p: [WeaponId, number, number] | null;
  s: [WeaponId, number, number] | null;
  n: Record<GrenadeId, number>;
  sel: GrenadeId;
  a: WeaponSlot;
  l: WeaponSlot;
}

/** The receiving player's own state, which nobody else needs. */
export interface PrivateState {
  money: number;
  medkits: number;
  healEnd: number;
  flash: [start: number, until: number, peak: number];
  combat: [lastDamagedAt: number, lastDealtAt: number, lastAttacker: number];
  inv: NetInv;
  wpn: WeaponState;
  /** Pickup id the E key would take, or -1. */
  swap: number;
  mv: [tagTime: number, maxSpeed: number, groundNormalY: number];
}

export interface NetGrenades {
  /** Projectiles in flight: id, kind, x, y, z, restTime. */
  p: [number, GrenadeId, number, number, number, number][];
  /** Smoke clouds: id, x, y, z, start, end. */
  s: [number, number, number, number, number, number][];
  /** Fires: id, x, y, z, radius, start, end. */
  f: [number, number, number, number, number, number, number][];
}

export const CarFlag = {
  OnGround: 1,
  Braking: 2,
  Destroyed: 4,
  Hatch: 8,
} as const;

/** A car as every client sees it: the full handling state, so its driver can predict it. */
export interface NetVehicle {
  id: number;
  flags: number;
  paint: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  yawRate: number;
  steer: number;
  throttle: number;
  pitch: number;
  roll: number;
  health: number;
  /** Driver's actor id, or -1. */
  driver: number;
  burnUntil: number;
}

export function netVehicle(v: Vehicle): NetVehicle {
  const c = v.car;
  let flags = 0;
  if (c.onGround) flags |= CarFlag.OnGround;
  if (c.braking) flags |= CarFlag.Braking;
  if (v.destroyed) flags |= CarFlag.Destroyed;
  if (v.hatch) flags |= CarFlag.Hatch;
  return {
    id: v.id,
    flags,
    paint: v.paint,
    x: c.pos.x,
    y: c.pos.y,
    z: c.pos.z,
    vx: c.vel.x,
    vy: c.vel.y,
    vz: c.vel.z,
    yaw: c.yaw,
    yawRate: c.yawRate,
    steer: c.steer,
    throttle: c.throttle,
    pitch: c.pitch,
    roll: c.roll,
    health: Math.max(0, Math.ceil(v.health)),
    driver: v.driver,
    burnUntil: v.burnUntil,
  };
}

export interface Snapshot {
  /** Server tick the snapshot was taken on (also its sequence number). */
  tick: number;
  time: number;
  /** Last command sequence the host has run for this client. */
  ackCmd: number;
  actors: NetActor[];
  vehicles: NetVehicle[];
  me: PrivateState | null;
  nades: NetGrenades;
}

export function netActor(a: Actor): NetActor {
  const m = a.move;
  let flags = 0;
  if (a.alive) flags |= Flag.Alive;
  if (m.onGround) flags |= Flag.OnGround;
  if (m.ducked) flags |= Flag.Ducked;
  if (a.flashlight) flags |= Flag.Flashlight;
  if (a.engaging) flags |= Flag.Engaging;
  if (a.dummy) flags |= Flag.Dummy;
  if (a.helmet) flags |= Flag.Helmet;
  if (a.inv.primary) flags |= Flag.HasPrimary;
  if (a.inv.secondary) flags |= Flag.HasSecondary;
  if (m.noclip) flags |= Flag.Noclip;
  if (a.healEnd >= 0) flags |= Flag.Healing;
  return {
    id: a.id,
    team: a.team,
    flags,
    x: m.pos.x,
    y: m.pos.y,
    z: m.pos.z,
    vx: m.vel.x,
    vy: m.vel.y,
    vz: m.vel.z,
    yaw: a.yaw,
    pitch: a.pitch,
    duck: m.duckAmount,
    health: Math.max(0, Math.min(255, Math.ceil(a.health))),
    armor: Math.max(0, Math.min(255, Math.ceil(a.armor))),
    slot: a.inv.active,
    diedAt: a.diedAt,
  };
}

export function netInv(inv: Inventory): NetInv {
  const w = (i: Inventory['primary']): NetInv['p'] => (i ? [i.def.id, i.clip, i.reserve] : null);
  return { p: w(inv.primary), s: w(inv.secondary), n: { ...inv.nades }, sel: inv.nadeSel, a: inv.active, l: inv.last };
}

export function privateState(a: Actor, swap: number): PrivateState {
  return {
    money: a.money,
    medkits: a.medkits,
    healEnd: a.healEnd,
    flash: [a.flashStart, a.flashUntil, a.flashPeak],
    combat: [a.lastDamagedAt, a.lastDealtAt, a.lastAttacker],
    inv: netInv(a.inv),
    wpn: { ...a.wpn },
    swap,
    mv: [a.move.tagTime, a.move.maxSpeed, a.move.groundNormalY],
  };
}

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const w = new Writer();
  w.u8(Bin.Snapshot);
  w.u32(s.tick);
  w.f64(s.time);
  w.u32(s.ackCmd);
  w.u16(s.actors.length);
  for (const a of s.actors) {
    w.u16(a.id);
    w.u8(a.team);
    w.u16(a.flags);
    w.f32(a.x);
    w.f32(a.y);
    w.f32(a.z);
    w.f32(a.vx);
    w.f32(a.vy);
    w.f32(a.vz);
    w.f32(a.yaw);
    w.f32(a.pitch);
    w.u8(Math.round(a.duck * 255));
    w.u8(a.health);
    w.u8(a.armor);
    w.u8(SLOTS.indexOf(a.slot));
    w.f32(a.diedAt);
  }
  w.u16(s.vehicles.length);
  for (const v of s.vehicles) {
    w.u16(v.id);
    w.u8(v.flags);
    w.u8(v.paint);
    w.f32(v.x);
    w.f32(v.y);
    w.f32(v.z);
    w.f32(v.vx);
    w.f32(v.vy);
    w.f32(v.vz);
    w.f32(v.yaw);
    w.f32(v.yawRate);
    w.f32(v.steer);
    w.i8(Math.round(Math.max(-1, Math.min(1, v.throttle)) * 127));
    w.f32(v.pitch);
    w.f32(v.roll);
    w.u16(v.health);
    w.u16(v.driver < 0 ? 0xffff : v.driver);
    w.f32(v.burnUntil);
  }
  w.bytes(enc.encode(toJson({ me: s.me, nades: s.nades })));
  return w.finish();
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const r = new Reader(buf);
  r.u8();
  const tick = r.u32();
  const time = r.f64();
  const ackCmd = r.u32();
  const n = r.u16();
  const actors: NetActor[] = [];
  for (let i = 0; i < n; i++) {
    actors.push({
      id: r.u16(),
      team: r.u8(),
      flags: r.u16(),
      x: r.f32(),
      y: r.f32(),
      z: r.f32(),
      vx: r.f32(),
      vy: r.f32(),
      vz: r.f32(),
      yaw: r.f32(),
      pitch: r.f32(),
      duck: r.u8() / 255,
      health: r.u8(),
      armor: r.u8(),
      slot: SLOTS[r.u8()] ?? 'knife',
      diedAt: r.f32(),
    });
  }
  const nv = r.u16();
  const vehicles: NetVehicle[] = [];
  for (let i = 0; i < nv; i++) {
    const id = r.u16();
    const flags = r.u8();
    const paint = r.u8();
    const x = r.f32();
    const y = r.f32();
    const z = r.f32();
    const vx = r.f32();
    const vy = r.f32();
    const vz = r.f32();
    const yaw = r.f32();
    const yawRate = r.f32();
    const steer = r.f32();
    const throttle = r.i8() / 127;
    const pitch = r.f32();
    const roll = r.f32();
    const health = r.u16();
    const d = r.u16();
    const burnUntil = r.f32();
    vehicles.push({ id, flags, paint, x, y, z, vx, vy, vz, yaw, yawRate, steer, throttle, pitch, roll, health, driver: d === 0xffff ? -1 : d, burnUntil });
  }
  const extra = JSON.parse(dec.decode(r.bytes())) as { me: PrivateState | null; nades: NetGrenades };
  return { tick, time, ackCmd, actors, vehicles, me: extra.me, nades: extra.nades };
}
