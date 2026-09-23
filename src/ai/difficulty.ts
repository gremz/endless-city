import { lerp } from '../core/math';
import type { WeaponId } from '../weapons/weaponDefs';

export interface BotSkill {
  level: number;
  /** Seconds from first seeing the target to the first shot. */
  reaction: number;
  /** Initial aim error (degrees) that decays over focusTime. */
  aimError: number;
  focusTime: number;
  /** Chance of aiming at the head rather than the chest. */
  headChance: number;
  visionRange: number;
  /** Full field of view (degrees). */
  fov: number;
  /** Max turn rate (degrees/second). */
  turnRate: number;
  /** Fraction of recoil the bot pulls down against. */
  recoilComp: number;
  /** Awareness gained per second at close range while visible. */
  awareness: number;
  /** Delay (s) of the position the bot tracks. */
  trackingDelay: number;
  canFlank: boolean;
  strafePeek: boolean;
  squadSize: number;
  overwatch: boolean;
  armor: number;
  helmet: boolean;
}

/** Skill parameters interpolated from level 0 (novice) to level 10 (veteran). */
export function skillFor(level: number): BotSkill {
  const t = Math.max(0, Math.min(10, level)) / 10;
  return {
    level,
    reaction: lerp(0.65, 0.18, t),
    aimError: lerp(5, 0.8, t),
    focusTime: lerp(1.2, 0.35, t),
    headChance: lerp(0.05, 0.45, t),
    visionRange: lerp(40, 90, t),
    fov: lerp(100, 140, t),
    turnRate: lerp(180, 720, t),
    recoilComp: lerp(0.2, 0.85, t),
    awareness: lerp(1.4, 4, t),
    trackingDelay: lerp(0.2, 0.06, t),
    canFlank: level >= 3,
    strafePeek: level >= 5,
    squadSize: Math.min(6, 2 + Math.floor(level / 2)),
    overwatch: level >= 4,
    armor: level >= 3 ? 100 : 0,
    helmet: level >= 6,
  };
}

/** Loadout by level: pistols early, SMGs, then rifles, AWP for overwatch at high levels. */
export function weaponFor(level: number, r: number, overwatch = false): WeaponId {
  if (overwatch) return level >= 6 ? 'awp' : level >= 4 ? 'ak47' : 'deagle';
  if (level <= 1) return r < 0.8 ? 'glock' : 'deagle';
  if (level <= 3) return r < 0.5 ? 'mp9' : r < 0.85 ? 'ump45' : 'deagle';
  if (level <= 6) return r < 0.5 ? 'ak47' : r < 0.85 ? 'm4a4' : 'ump45';
  return r < 0.55 ? 'ak47' : 'm4a4';
}

export const BOT_NAMES = [
  'Ivan', 'Dima', 'Kolya', 'Pasha', 'Sasha', 'Misha', 'Artem', 'Boris', 'Yuri', 'Lev',
  'Karim', 'Omar', 'Farid', 'Tariq', 'Nadir', 'Rafi', 'Samir', 'Hakim', 'Zaid', 'Jamal',
  'Viktor', 'Oleg', 'Gleb', 'Timur', 'Rustam', 'Emil', 'Anton', 'Sergei', 'Maks', 'Roman',
  'Hassan', 'Idris', 'Khalid', 'Malik', 'Yusuf', 'Bashir', 'Sami', 'Adel', 'Reza', 'Kamal',
];
