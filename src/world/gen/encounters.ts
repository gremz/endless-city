import { CHUNK } from '../../core/config';
import type { Rand } from '../../core/rng';
import { NAV_CELL, NAV_RES, NavFlag } from './ChunkData';
import { spanColumns, type NavBake } from './navBake';

export interface EncounterData {
  spawns: Float32Array;
  perches: Float32Array;
  patrol: Float32Array;
  hasEncounter: boolean;
  opening: boolean;
}

/**
 * The block straight ahead of the spawn drop-in point (the player starts facing +Z): the one
 * chunk near spawn with bots, a scripted pair in plain view to open the game with.
 */
export const OPENING_CHUNK = { cx: 0, cz: 1 } as const;

export function isOpeningChunk(cx: number, cz: number): boolean {
  return cx === OPENING_CHUNK.cx && cz === OPENING_CHUNK.cz;
}

/**
 * Pick bot spawn slots (reachable, off-street, preferring cover and interiors, spaced apart),
 * a patrol loop, and valid perches. Positions are converted to world meters.
 */
export function placeEncounters(
  r: Rand,
  nav: NavBake,
  cx: number,
  cz: number,
  level: number,
  rawPerches: number[],
): EncounterData {
  const N = NAV_RES;
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  // Candidate spans packed as (score << 16 | spanId) so a typed-array sort ranks them.
  const spanCol = spanColumns(nav.col);
  const keys = new Int32Array(nav.floor.length);
  let count = 0;
  for (let s = 0; s < nav.floor.length; s++) {
    const c = spanCol[s];
    const i = c % N;
    const j = (c - i) / N;
    if (i < 2 || j < 2 || i >= N - 2 || j >= N - 2) continue;
    const f = nav.flags[s];
    if (!(f & NavFlag.Walkable) || !(f & NavFlag.Reachable) || f & (NavFlag.Street | NavFlag.Water)) continue;
    let score = r();
    if (f & NavFlag.CoverFull) score += 2;
    else if (f & NavFlag.CoverHalf) score += 1.5;
    if (f & NavFlag.Indoor) score += 1;
    if (f & NavFlag.NearWall && !(f & (NavFlag.CoverHalf | NavFlag.CoverFull))) score -= 0.5;
    keys[count++] = (Math.max(0, Math.floor((score + 1) * 1000)) << 16) | s;
  }
  const ranked = keys.subarray(0, count).sort().reverse();
  const spanOf = (k: number) => k & 0xffff;
  const cellOf = (k: number) => spanCol[spanOf(k)];

  const spawns: number[] = [];
  const slotCells: number[] = [];
  const minSpacing2 = (3.5 / NAV_CELL) ** 2;
  const MAX_SLOTS = 10;
  for (let c = 0; c < ranked.length && slotCells.length < MAX_SLOTS; c++) {
    const span = spanOf(ranked[c]);
    const cell = spanCol[span];
    const ci = cell % N;
    const cj = (cell - ci) / N;
    let ok = true;
    for (const sc of slotCells) {
      const si = sc % N;
      const sj = (sc - si) / N;
      if ((si - ci) ** 2 + (sj - cj) ** 2 < minSpacing2) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    slotCells.push(cell);
    spawns.push(ox + (ci + 0.5) * NAV_CELL, nav.floor[span] / 100 + 0.02, oz + (cj + 0.5) * NAV_CELL);
  }

  // Patrol loop: farthest-point sampling over reachable open cells.
  const patrol: number[] = [];
  if (count) {
    const pts: number[] = [spanOf(ranked[Math.floor(r() * Math.min(count, 40))])];
    for (let k = 1; k < 4; k++) {
      let best = pts[0];
      let bestD = -1;
      for (let s = 0; s < count; s += 7) {
        const cell = cellOf(ranked[s]);
        const ci = cell % N;
        const cj = (cell - ci) / N;
        let d = Infinity;
        for (const p of pts) d = Math.min(d, (spanCol[p] % N - ci) ** 2 + (Math.floor(spanCol[p] / N) - cj) ** 2);
        if (d > bestD) {
          bestD = d;
          best = spanOf(ranked[s]);
        }
      }
      pts.push(best);
    }
    for (const p of pts) {
      const pi = spanCol[p] % N;
      const pj = (spanCol[p] - pi) / N;
      patrol.push(ox + (pi + 0.5) * NAV_CELL, nav.floor[p] / 100 + 0.02, oz + (pj + 0.5) * NAV_CELL);
    }
  }

  const perches: number[] = [];
  for (let k = 0; k < rawPerches.length; k += 3) {
    perches.push(ox + rawPerches[k], rawPerches[k + 1], oz + rawPerches[k + 2]);
  }

  const nearSpawn = Math.max(Math.abs(cx), Math.abs(cz)) <= 1;
  const opening = isOpeningChunk(cx, cz);
  const hasEncounter = opening || (!nearSpawn && spawns.length >= 4 * 3 && r() < 0.55 + 0.03 * level);
  return {
    spawns: new Float32Array(spawns),
    perches: new Float32Array(perches),
    patrol: new Float32Array(patrol),
    hasEncounter,
    opening,
  };
}
