import { vec3, type Vec3 } from '../core/math';
import { eyeHeight, makeMoveState, type MoveState } from '../player/pmove';

export const Team = { Player: 0, Bots: 1 } as const;
export type TeamId = (typeof Team)[keyof typeof Team];

/** State shared by the player and bots. Weapons/brains attach to this. */
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
  alive: boolean;
  health: number;
  armor: number;
  helmet: boolean;
  /** Tick of death (for death cams / body fade). */
  diedAt: number;
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
    alive: true,
    health: 100,
    armor: 0,
    helmet: false,
    diedAt: -1,
  };
}

/** Snapshot the current position as the interpolation start for the next tick. */
export function storePrev(a: Actor): void {
  a.prevPos.x = a.move.pos.x;
  a.prevPos.y = a.move.pos.y;
  a.prevPos.z = a.move.pos.z;
  a.prevEye = eyeHeight(a.move);
}

/** Move without interpolation smear (spawns, respawns, teleports). */
export function teleport(a: Actor, x: number, y: number, z: number): void {
  a.move.pos.x = x;
  a.move.pos.y = y;
  a.move.pos.z = z;
  a.move.vel.x = a.move.vel.y = a.move.vel.z = 0;
  storePrev(a);
}
