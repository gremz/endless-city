import { Team, type Actor, type TeamId } from '../../sim/Actor';
import type { CharacterAsset } from './CharacterAssets';
import type { BotGroup } from './characterSpec';

/** One of the models a CharacterRenderer draws with; `group` says which bots may use it. */
export interface CharacterVariant {
  asset: CharacterAsset;
  group?: BotGroup;
}

/** Integer hash of an actor id (the same on every client, unlike a random pick). */
function hashId(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Which variant an actor is drawn with: civilians from the civilians, armoured actors from the
 * terrorists, the rest from the gang, chosen by id. A group with no models falls back to the
 * gang (civilians), or to any variant.
 */
export function pickVariant(a: Pick<Actor, 'id' | 'armor'> & { team?: TeamId }, groups: readonly (BotGroup | undefined)[]): number {
  const want: BotGroup = a.team === Team.Civilian ? 'civilian' : a.armor > 0 ? 'terrorist' : 'gang';
  const of = (g: BotGroup) => groups.flatMap((x, i) => (x === g ? [i] : []));
  let candidates = of(want);
  if (!candidates.length && want === 'civilian') candidates = of('gang');
  if (!candidates.length) candidates = groups.map((_, i) => i);
  return candidates[hashId(a.id) % candidates.length];
}
