import { CHUNK } from '../../core/config';
import type { Rand } from '../../core/rng';
import { NAV_CELL, NAV_RES, NavFlag } from './ChunkData';
import type { NavBake } from './navBake';

/** Where the player drops in on the spawn plaza (chunk-local meters). */
const SPAWN_X = 32;
const SPAWN_Z = 22;
const MIN_SPACING = 12;

/**
 * Pick health pack spots: reachable, off-street cells, preferring interiors and wall-hugging
 * corners. The spawn plaza always gets one in view of the drop-in point; encounter chunks get
 * one or two, quiet chunks sometimes one. Returns x, y, z triples in world meters.
 */
export function placePickups(r: Rand, nav: NavBake, cx: number, cz: number, hasEncounter: boolean, isSpawn: boolean): Float32Array {
  const want = isSpawn ? 1 : hasEncounter ? 1 + (r() < 0.5 ? 1 : 0) : r() < 0.4 ? 1 : 0;
  if (!want) return new Float32Array(0);
  const N = NAV_RES;
  // Candidate cells packed as (score << 14 | cellIndex) so a typed-array sort ranks them.
  const keys = new Int32Array(N * N);
  let count = 0;
  for (let j = 2; j < N - 2; j++) {
    for (let i = 2; i < N - 2; i++) {
      const f = nav.flags[j * N + i];
      if (!(f & NavFlag.Walkable) || !(f & NavFlag.Reachable) || f & NavFlag.Street) continue;
      let score = r();
      if (isSpawn) {
        const d = Math.hypot((i + 0.5) * NAV_CELL - SPAWN_X, (j + 0.5) * NAV_CELL - SPAWN_Z);
        if (d < 5 || d > 14) continue;
      } else {
        if (f & NavFlag.Indoor) score += 1.5;
        if (f & NavFlag.NearWall) score += 0.8;
        if (f & (NavFlag.CoverHalf | NavFlag.CoverFull)) score += 0.5;
      }
      keys[count++] = (Math.floor(score * 1000) << 14) | (j * N + i);
    }
  }
  const ranked = keys.subarray(0, count).sort().reverse();
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  const out: number[] = [];
  const minD2 = (MIN_SPACING / NAV_CELL) ** 2;
  const picked: number[] = [];
  for (let c = 0; c < ranked.length && picked.length < want; c++) {
    const cell = ranked[c] & 0x3fff;
    const ci = cell % N;
    const cj = (cell - ci) / N;
    if (picked.some((p) => ((p % N) - ci) ** 2 + (Math.floor(p / N) - cj) ** 2 < minD2)) continue;
    picked.push(cell);
    out.push(ox + (ci + 0.5) * NAV_CELL, nav.floor[cell] / 100 + 0.02, oz + (cj + 0.5) * NAV_CELL);
  }
  return new Float32Array(out);
}
