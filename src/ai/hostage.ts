import { wrapAngle, type Vec3 } from '../core/math';
import { Buttons, makeCmd, type UserCmd } from '../input/UserCmd';
import { playerMove } from '../player/pmove';
import { makeActor, Team, teleport, type Actor } from '../sim/Actor';
import type { Simulation } from '../sim/Simulation';
import { makeInventory } from '../weapons/Inventory';
import { lineSeconds, linesFor, type VoiceCue, type VoiceId } from './voiceLines';

/** Seconds from a player coming near to the gunman pulling the trigger. */
export const EXECUTE_FUSE = 40;
/** A living player this close to the hostage lights the fuse (the drop-in point is ~45 m away). */
export const FUSE_RANGE = 80;
/** Paid to every player for getting the hostage out alive. */
export const RESCUE_REWARD = 400;
/** The gunman's warning comes this long before he fires (the objective turns urgent too). */
export const WARN_TIME = 12;
/** His last words, this long before the shot. */
export const LAST_WORDS = 3;
/** Seconds between the officer's pleas. */
export const PLEA_GAP = 12;
/** A beat between one line ending and the next starting. */
const LINE_GAP = 0.6;

/**
 * The opening's captured officer: kneeling between the pair, facing the plaza, until the gunman
 * shoots him or the player takes both of them out. Not a player, so bots never target him, and
 * only his executioner can hurt him (see `Simulation.canHit`).
 */
export interface Hostage {
  actor: Actor;
  /** Sim time the gunman fires, or -1 until a player is near enough to watch it happen. */
  executeAt: number;
  /** Unit vector from the plaza out through the scene (the shover keeps to the sides). */
  awayX: number;
  awayZ: number;
  phase: 'held' | 'freed' | 'executed';
  /** Chunk of the encounter he belongs to. */
  chunkKey: number;
  readonly cmd: UserCmd;
  // Dialogue.
  /** Nobody starts a new line before this (sim time), unless it's a line that can't wait. */
  quietUntil: number;
  /** Lines said so far per voice and cue (so each cue goes round its lines in turn). */
  said: Map<string, number>;
  /** When the officer pleads next, the shover gloats over the body, or the officer says thanks (-1: not due). */
  pleaAt: number;
  afterAt: number;
  thanksAt: number;
  warned: boolean;
  lastWords: boolean;
  /** Actor ids of the gunman and the shover (-1 until cast). */
  gunmanId: number;
  shoverId: number;
}

export function makeHostage(sim: Simulation, pos: Vec3, awayX: number, awayZ: number, chunkKey: number): Hostage {
  const a = makeActor(sim.newActorId(), 'Officer', Team.Player, pos.x, pos.y, pos.z);
  a.captive = true;
  // Hands empty: the knife slot is never drawn for a captive.
  a.inv = makeInventory(null);
  // Facing back towards the plaza, head a little bowed.
  a.yaw = a.prevYaw = Math.atan2(awayX, awayZ);
  a.pitch = -0.3;
  teleport(a, pos.x, pos.y, pos.z);
  sim.addActor(a);
  return {
    actor: a,
    executeAt: -1,
    awayX,
    awayZ,
    phase: 'held',
    chunkKey,
    cmd: makeCmd(),
    quietUntil: 0,
    said: new Map(),
    pleaAt: -1,
    afterAt: -1,
    thanksAt: -1,
    warned: false,
    lastWords: false,
    gunmanId: -1,
    shoverId: -1,
  };
}

/**
 * `speaker` says the next of `voice`'s lines for `cue`. Skipped (false) while someone else is
 * still talking, unless `force` (lines tied to a moment that won't come again).
 */
export function say(sim: Simulation, h: Hostage, speaker: Actor, voice: VoiceId, cue: VoiceCue, force = false): boolean {
  if (!speaker.alive || (!force && sim.time < h.quietUntil)) return false;
  const lines = linesFor(voice, cue);
  if (!lines.length) return false;
  const key = `${voice}:${cue}`;
  const n = h.said.get(key) ?? 0;
  h.said.set(key, n + 1);
  const line = lines[n % lines.length];
  sim.events.push({ type: 'voice', actorId: speaker.id, line: line.id });
  h.quietUntil = sim.time + lineSeconds(line) + LINE_GAP;
  return true;
}

/** Kneel while held; once freed, stand and face `faceYaw` (the nearest player). */
export function driveHostage(sim: Simulation, h: Hostage, faceYaw: number | null): void {
  const a = h.actor;
  if (!a.alive) return;
  const cmd = h.cmd;
  cmd.forward = cmd.side = 0;
  cmd.buttons = h.phase === 'held' ? Buttons.DUCK : 0;
  cmd.pressed = 0;
  cmd.weaponSelect = -1;
  if (h.phase === 'freed') {
    if (faceYaw !== null) a.yaw = wrapAngle(a.yaw + wrapAngle(faceYaw - a.yaw) * Math.min(1, sim.dt * 4));
    a.pitch = 0;
  }
  cmd.yaw = cmd.attackYaw = a.yaw;
  cmd.pitch = cmd.attackPitch = a.pitch;
  playerMove(a.move, cmd, sim.world, sim.dt);
}
