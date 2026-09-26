import { hash3, Salt, sfc32, type Rand } from '../core/rng';
import type { Actor } from '../sim/Actor';
import type { Simulation } from '../sim/Simulation';
import type { Bot, Squad } from './Bot';
import { FACTION_VOICES, lineSeconds, linesFor, type BarkCue, type BarkVoiceId } from './voiceLines';

/**
 * Squad barks: what bots shout in a fight (spotted, reloading, man down...). One member speaks
 * at a time, unless something more urgent cuts in; every cue has its own cooldown and chance, so
 * a fight isn't a wall of chatter.
 */

/** How a cue is rationed. */
interface BarkRule {
  /** Cuts in over a squadmate still saying something less urgent. */
  priority: number;
  /** Seconds before the same cue again, from the same bot (or anyone in the squad, with `squadWide`). */
  cooldown: number;
  chance: number;
  squadWide?: boolean;
}

export const BARKS: Record<BarkCue, BarkRule> = {
  idle: { priority: 0, cooldown: 0, chance: 1 },
  suspicious: { priority: 1, cooldown: 20, chance: 0.7, squadWide: true },
  giveUp: { priority: 1, cooldown: 30, chance: 0.7, squadWide: true },
  cover: { priority: 1, cooldown: 10, chance: 0.35 },
  lost: { priority: 1, cooldown: 12, chance: 0.6, squadWide: true },
  reload: { priority: 1, cooldown: 8, chance: 0.5 },
  taunt: { priority: 1, cooldown: 15, chance: 0.5, squadWide: true },
  hurt: { priority: 2, cooldown: 4, chance: 0.4 },
  flank: { priority: 2, cooldown: 12, chance: 0.8 },
  retreat: { priority: 2, cooldown: 10, chance: 0.8 },
  kill: { priority: 2, cooldown: 0, chance: 0.8 },
  spotted: { priority: 3, cooldown: 10, chance: 1, squadWide: true },
  throw: { priority: 3, cooldown: 0, chance: 1 },
  blinded: { priority: 3, cooldown: 5, chance: 1 },
  manDown: { priority: 3, cooldown: 0, chance: 1 },
  lastAlive: { priority: 3, cooldown: 0, chance: 1 },
  incoming: { priority: 4, cooldown: 3, chance: 1 },
};

/** Nobody barks unless a living player is this close (m): nobody would hear it. */
export const BARK_RANGE = 60;
/** Idle chatter only carries this far (m), to be overheard sneaking up. */
const IDLE_RANGE = 40;
/** Seconds between idle remarks, from the same bot. */
const IDLE_GAP = 25;
const IDLE_JITTER = 20;
/** A beat between one line ending and the next starting. */
const LINE_GAP = 0.6;
/** The squad's "contact" shout comes after this long without seeing anyone (s). */
export const CONTACT_GAP = 10;

/** A squad's shared voice: who's talking, and what's been said. */
export interface SquadBarks {
  quietUntil: number;
  /** Priority of the line being said (until quietUntil). */
  speaking: number;
  /** Lines said so far per voice and cue (so each cue goes round its lines in turn). */
  said: Map<string, number>;
  /** When each squad-wide cue was last considered. */
  last: Partial<Record<BarkCue, number>>;
  /** Last time any member was in a firefight (saw a player, fully aware). */
  contactAt: number;
}

/** A bot's own voice. */
export interface BotBarks {
  /** Null: never barks (the opening's scene pair, who have their own lines). */
  voice: BarkVoiceId | null;
  /** Own stream, so talking never changes how the bot fights. */
  readonly r: Rand;
  last: Partial<Record<BarkCue, number>>;
  /** When the next idle remark is due (-1: not scheduled yet). */
  idleAt: number;
}

/** The terrorist cell's voices for armoured bots, the gang's otherwise: matches the model (see pickVariant). */
export function barkVoice(a: Pick<Actor, 'id' | 'armor'>): BarkVoiceId {
  return FACTION_VOICES[a.armor > 0 ? 'cell' : 'gang'][a.id & 1];
}

export function makeBotBarks(a: Actor, seed: number): BotBarks {
  return { voice: barkVoice(a), r: sfc32(hash3(seed, a.id, 0, Salt.Bark)), last: {}, idleAt: -1 };
}

export function squadBarks(sq: Squad): SquadBarks {
  return (sq.barks ??= { quietUntil: 0, speaking: -1, said: new Map(), last: {}, contactAt: -100 });
}

/** Horizontal distance from `a` to the nearest living player. */
function nearestPlayer(sim: Simulation, a: Actor): number {
  let best = Infinity;
  for (const p of sim.players) {
    if (!p.alive) continue;
    best = Math.min(best, Math.hypot(p.move.pos.x - a.move.pos.x, p.move.pos.z - a.move.pos.z));
  }
  return best;
}

/**
 * `bot` says the next of its lines for `cue`, if it's in earshot of a player, off cooldown, wins
 * the roll, and no squadmate is saying something as urgent. Returns whether it spoke.
 */
export function bark(sim: Simulation, bot: Bot, cue: BarkCue): boolean {
  const a = bot.actor;
  const me = bot.barks;
  if (!me.voice || !a.alive) return false;
  const now = sim.time;
  const rule = BARKS[cue];
  const sq = squadBarks(bot.squad);
  const last = rule.squadWide ? sq.last : me.last;
  if (rule.cooldown > 0 && now < (last[cue] ?? -Infinity) + rule.cooldown) return false;
  if (now < sq.quietUntil && rule.priority <= sq.speaking) return false;
  if (nearestPlayer(sim, a) > (cue === 'idle' ? IDLE_RANGE : BARK_RANGE)) return false;
  last[cue] = now;
  if (rule.chance < 1 && me.r() >= rule.chance) return false;
  const lines = linesFor(me.voice, cue);
  if (!lines.length) return false;
  const key = `${me.voice}:${cue}`;
  const n = sq.said.get(key) ?? 0;
  sq.said.set(key, n + 1);
  const line = lines[n % lines.length];
  sim.events.push({ type: 'voice', actorId: a.id, line: line.id });
  sq.quietUntil = now + lineSeconds(line) + LINE_GAP;
  sq.speaking = rule.priority;
  return true;
}

/** Now and then, an unaware bot with a squadmate still standing passes a remark. */
export function idleChatter(sim: Simulation, bot: Bot): void {
  const me = bot.barks;
  const now = sim.time;
  if (me.idleAt < 0) me.idleAt = now + 5 + me.r() * IDLE_GAP;
  if (now < me.idleAt) return;
  me.idleAt = now + IDLE_GAP + me.r() * IDLE_JITTER;
  if (bot.squad.members.some((m) => m !== bot && m.actor.alive)) bark(sim, bot, 'idle');
}
