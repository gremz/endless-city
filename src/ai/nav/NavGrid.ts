import { chunkKey } from '../../world/chunkMath';
import { NAV_CELL, NAV_RES, NavFlag, type ChunkData } from '../../world/gen/ChunkData';
import type { StreamerListener } from '../../world/WorldStreamer';

interface NavChunk {
  floor: Int16Array;
  flags: Uint8Array;
  cover: Uint8Array;
}

/** Global cell index for a world coordinate. */
export const toCell = (v: number) => Math.floor(v / NAV_CELL);
export const cellCenter = (c: number) => (c + 0.5) * NAV_CELL;

/**
 * Seamless view over the nav grids of all resident chunks, addressed by global cell
 * coordinates (0.5 m). Unloaded cells read as unwalkable.
 */
export class NavGrid implements StreamerListener {
  private chunks = new Map<number, NavChunk>();
  private lastKey = -1;
  private last: NavChunk | undefined;

  onChunkLoaded(d: ChunkData): void {
    if (!d.navFlags.length) return;
    this.chunks.set(d.key, { floor: d.navFloor, flags: d.navFlags, cover: d.navCover });
    this.lastKey = -1;
  }

  onChunkUnloaded(key: number): void {
    this.chunks.delete(key);
    this.lastKey = -1;
  }

  onChunkVisibility(): void {}

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  private chunk(gx: number, gz: number): NavChunk | undefined {
    const cx = Math.floor(gx / NAV_RES);
    const cz = Math.floor(gz / NAV_RES);
    const key = chunkKey(cx, cz);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.last = this.chunks.get(key);
    }
    return this.last;
  }

  private local(gx: number, gz: number): number {
    const i = gx - Math.floor(gx / NAV_RES) * NAV_RES;
    const j = gz - Math.floor(gz / NAV_RES) * NAV_RES;
    return j * NAV_RES + i;
  }

  flags(gx: number, gz: number): number {
    const c = this.chunk(gx, gz);
    return c ? c.flags[this.local(gx, gz)] : 0;
  }

  walkable(gx: number, gz: number): boolean {
    return (this.flags(gx, gz) & NavFlag.Walkable) !== 0;
  }

  /** Floor height in meters, or NaN if not walkable/unloaded. */
  floor(gx: number, gz: number): number {
    const c = this.chunk(gx, gz);
    if (!c) return NaN;
    const idx = this.local(gx, gz);
    if (!(c.flags[idx] & NavFlag.Walkable)) return NaN;
    return c.floor[idx] / 100;
  }

  cover(gx: number, gz: number): number {
    const c = this.chunk(gx, gz);
    return c ? c.cover[this.local(gx, gz)] : 0;
  }

  /** Nearest walkable cell to (x, z) within a small radius, or null. */
  nearestWalkable(x: number, z: number, radiusCells = 6, nearY?: number): [number, number] | null {
    const gx = toCell(x);
    const gz = toCell(z);
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= radiusCells; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const f = this.floor(gx + dx, gz + dz);
          if (Number.isNaN(f)) continue;
          if (nearY !== undefined && Math.abs(f - nearY) > 1.2) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = [gx + dx, gz + dz];
          }
        }
      }
      if (best) return best;
    }
    return best;
  }
}
