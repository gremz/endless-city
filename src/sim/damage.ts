import { HITGROUP_MULT, HitGroup } from '../ai/hitboxes';
import { MOVE } from '../player/movementConfig';
import type { Actor } from './Actor';

/** Range falloff: damage × rangeMod^(distance / 500 HU). */
export function rangeDamage(base: number, rangeMod: number, dist: number): number {
  return base * Math.pow(rangeMod, dist / 12.7);
}

export interface ArmorResult {
  health: number;
  armor: number;
  helmetHit: boolean;
}

/**
 * CS armor model. Armor protects every hitgroup except the head, which needs a helmet.
 * Health takes dmg × armorPen; armor absorbs half the remainder; if armor runs out the
 * overflow goes to health.
 */
export function armorDamage(
  dmg: number,
  group: number,
  armorPen: number,
  armor: number,
  helmet: boolean,
): ArmorResult {
  const protectedHit = armor > 0 && (group !== HitGroup.Head || helmet);
  if (!protectedHit) return { health: Math.floor(dmg), armor: 0, helmetHit: false };
  let toHealth = dmg * armorPen;
  let toArmor = (dmg - toHealth) * 0.5;
  if (toArmor > armor) {
    toArmor = armor;
    toHealth = dmg - armor * 2;
  }
  return { health: Math.floor(toHealth), armor: Math.floor(toArmor), helmetHit: group === HitGroup.Head };
}

/** Full damage for a bullet hit: range falloff, hitgroup multiplier, then armor. */
export function bulletDamage(
  base: number,
  rangeMod: number,
  dist: number,
  group: number,
  armorPen: number,
  armor: number,
  helmet: boolean,
): ArmorResult {
  const dmg = rangeDamage(base, rangeMod, dist) * HITGROUP_MULT[group];
  return armorDamage(dmg, group, armorPen, armor, helmet);
}

/** Apply computed damage to an actor. Returns true if this killed them. */
export function applyDamage(victim: Actor, res: ArmorResult, god = false): boolean {
  if (!victim.alive) return false;
  victim.armor = Math.max(0, victim.armor - res.armor);
  if (victim.armor === 0) victim.helmet = false;
  if (!god) victim.health -= Math.max(1, res.health);
  victim.move.tagTime = MOVE.tagRecovery;
  if (victim.health <= 0) {
    victim.health = 0;
    victim.alive = false;
    return true;
  }
  return false;
}
