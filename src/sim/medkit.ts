import { Buttons, type UserCmd } from '../input/UserCmd';
import type { Actor } from './Actor';
import type { Simulation } from './Simulation';

/** Most health packs an actor can carry. */
export const MEDKIT_MAX = 3;
/** Health restored by one pack. */
export const MEDKIT_HEAL = 50;
/** Seconds the gun is lowered while applying a pack. */
export const MEDKIT_TIME = 1;

export function isHealing(a: Actor): boolean {
  return a.healEnd >= 0;
}

/** 0..1 progress of the current medkit use (0 when not healing). */
export function healProgress(a: Actor, time: number): number {
  if (a.healEnd < 0) return 0;
  return Math.min(1, Math.max(0, 1 - (a.healEnd - time) / MEDKIT_TIME));
}

function cancelHeal(a: Actor, sim: Simulation): void {
  a.healEnd = -1;
  a.wpn.nextAttack = Math.max(sim.time, a.wpn.deployEnd);
  sim.events.push({ type: 'heal', actorId: a.id, phase: 'cancel', amount: 0 });
}

/**
 * Medkit use, run before the weapon each tick: HEAL starts a short channel that blocks firing;
 * HEAL again or ATTACK cancels it (the pack is kept); finishing consumes one pack.
 */
export function updateHeal(a: Actor, cmd: UserCmd, sim: Simulation): void {
  if (!a.alive) {
    a.healEnd = -1;
    return;
  }
  const t = sim.time;
  if (a.healEnd >= 0) {
    if (cmd.pressed & (Buttons.HEAL | Buttons.ATTACK)) {
      cancelHeal(a, sim);
      return;
    }
    if (t >= a.healEnd) {
      const before = a.health;
      a.health = Math.min(100, a.health + MEDKIT_HEAL);
      a.medkits--;
      a.healEnd = -1;
      sim.events.push({ type: 'heal', actorId: a.id, phase: 'done', amount: a.health - before });
    }
    return;
  }
  if (!(cmd.pressed & Buttons.HEAL)) return;
  if (a.medkits <= 0) {
    sim.events.push({ type: 'message', text: 'No medkits' });
    return;
  }
  if (a.health >= 100) {
    sim.events.push({ type: 'message', text: 'Health full' });
    return;
  }
  const w = a.wpn;
  a.healEnd = t + MEDKIT_TIME;
  w.nextAttack = Math.max(w.nextAttack, a.healEnd);
  w.reloadEnd = -1;
  w.scope = 0;
  w.rescopeAt = -1;
  sim.events.push({ type: 'heal', actorId: a.id, phase: 'start', amount: 0 });
}
