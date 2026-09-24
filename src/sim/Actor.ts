import { vec3, type Vec3 } from '../core/math';
import { eyeHeight, makeMoveState, type MoveState } from '../player/pmove';
import { makeInventory, makeWeaponState, type Inventory, type WeaponState } from '../weapons/Inventory';

export const Team = { Player: 0, Bots: 1 } as const;
export type TeamId = (typeof Team)[keyof typeof Team];

/** State shared by the player and bots. Brains attach to this. */
export interface Actor {
  id: number;
  name: string;
  team: TeamId;
  move: MoveState;
  /** Position and eye height at the previous tick, for render interpolation. */
  prevPos: Vec3;
  prevEye: number;
  yaw: number;
  pitch: number;
  prevYaw: number;
  alive: boolean;
  health: number;
  armor: number;
  helmet: boolean;
  /** Sim time of death (for death cams / body fade). */
  diedAt: number;
  inv: Inventory;
  wpn: WeaponState;
  /** Static target that respawns in place (shooting range). */
  dummy: boolean;
  spawnPos: Vec3;
  /** Actor id that last damaged this actor, and when. */
  lastAttacker: number;
  lastDamagedAt: number;
  /** Sim time this actor last dealt damage. */
  lastDealtAt: number;
  /** Distance accumulated towards the next footstep. */
  stepAccum: number;
  /** Carried health packs. */
  medkits: number;
  /** Sim time the current medkit use finishes, or -1 when not healing. */
  healEnd: number;
  /** Flashbang blindness: when it started, when it ends, and peak whiteness (0..1). */
  flashStart: number;
  flashUntil: number;
  flashPeak: number;
  /** Flashlight switched on (players: easier to spot at night; bots: out hunting after dark). */
  flashlight: boolean;
  /** Money (players only). */
  money: number;
  /** Bot in a firefight (shows on radars, blocks buying nearby). */
  engaging: boolean;
}

export function makeActor(id: number, name: string, team: TeamId, x: number, y: number, z: number): Actor {
  const move = makeMoveState(x, y, z);
  return {
    id,
    name,
    team,
    move,
    prevPos: vec3(x, y, z),
    prevEye: eyeHeight(move),
    yaw: 0,
    pitch: 0,
    prevYaw: 0,
    alive: true,
    health: 100,
    armor: 0,
    helmet: false,
    diedAt: -1,
    inv: makeInventory('glock'),
    wpn: makeWeaponState(),
    dummy: false,
    spawnPos: vec3(x, y, z),
    lastAttacker: -1,
    lastDamagedAt: -100,
    lastDealtAt: -100,
    stepAccum: 0,
    medkits: 0,
    healEnd: -1,
    flashStart: -10,
    flashUntil: -10,
    flashPeak: 0,
    flashlight: false,
    money: 0,
    engaging: false,
  };
}

/** Snapshot the current position as the interpolation start for the next tick. */
export function storePrev(a: Actor): void {
  a.prevPos.x = a.move.pos.x;
  a.prevPos.y = a.move.pos.y;
  a.prevPos.z = a.move.pos.z;
  a.prevEye = eyeHeight(a.move);
  a.prevYaw = a.yaw;
}

/** Move without interpolation smear (spawns, respawns, teleports). */
export function teleport(a: Actor, x: number, y: number, z: number): void {
  a.move.pos.x = x;
  a.move.pos.y = y;
  a.move.pos.z = z;
  a.move.vel.x = a.move.vel.y = a.move.vel.z = 0;
  storePrev(a);
}

export function eyePos(a: Actor, out: Vec3): Vec3 {
  out.x = a.move.pos.x;
  out.y = a.move.pos.y + eyeHeight(a.move);
  out.z = a.move.pos.z;
  return out;
}
