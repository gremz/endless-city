import { CHUNK } from '../core/config';
import { chunkKey, keyToCoords, worldToChunk } from '../world/chunkMath';
import type { Actor } from './Actor';
import type { Simulation } from './Simulation';

/** Seconds a dead player waits before fire or jump brings them back. */
export const RESPAWN_DELAY = 3;

/**
 * Where a player comes back: the nearest cleared area to `near` (their body, or a teammate) that
 * is loaded, else the spawn area. Returns a sidewalk spot on the chunk's west side, which is
 * always walkable.
 */
export function respawnPoint(sim: Simulation, near: Actor, isLoaded: (key: number) => boolean): { x: number; z: number } {
  const { params } = sim;
  const pcx = worldToChunk(near.move.pos.x);
  const pcz = worldToChunk(near.move.pos.z);
  let best = chunkKey(params.spawnCx, params.spawnCz);
  let bestD = Math.max(Math.abs(pcx - params.spawnCx), Math.abs(pcz - params.spawnCz));
  for (const key of sim.cleared) {
    const [cx, cz] = keyToCoords(key);
    const d = Math.max(Math.abs(pcx - cx), Math.abs(pcz - cz));
    if (d < bestD && isLoaded(key)) {
      best = key;
      bestD = d;
    }
  }
  const [cx, cz] = keyToCoords(best);
  return { x: cx * CHUNK + 5, z: cz * CHUNK + 14 };
}
