import type { Actor } from '../../sim/Actor';
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
 * Which variant an actor is drawn with: armoured actors from the terrorists, the rest from the
 * gang (any variant if its group has none), chosen by id.
 */
export function pickVariant(a: Pick<Actor, 'id' | 'armor'>, groups: readonly (BotGroup | undefined)[]): number {
  const want: BotGroup = a.armor > 0 ? 'terrorist' : 'gang';
  let candidates = groups.flatMap((g, i) => (g === want ? [i] : []));
  if (!candidates.length) candidates = groups.map((_, i) => i);
  return candidates[hashId(a.id) % candidates.length];
}
