import { vec3, type Vec3 } from '../core/math';
import type { Brush } from '../physics/brush';
import type { ChunkData } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';
import type { Simulation } from './Simulation';

/** Panes within this distance of an HE blast shatter. */
export const BLAST_GLASS_RADIUS = 6;

/** A pane's id in saves and on the wire: its chunk and its brush index there. */
export type PaneRef = [chunkKey: number, index: number];

/**
 * Breakable window panes. They are chunk brushes (movement- and grenade-solid, see-through for
 * bots); breaking one clears its contents in place, and the broken set is remembered so a
 * reloaded chunk comes back with the same windows out. The host (or solo game) decides what
 * breaks; online clients apply the host's breaks.
 */
export class GlassSystem implements StreamerListener {
  /** Broken panes, "chunkKey:index". */
  private broken = new Set<string>();
  /** Resident panes: brush → its index in the chunk. */
  private panes = new Map<Brush, number>();
  private byChunk = new Map<number, Brush[]>();
  /** Bumped whenever a pane breaks (renderers resync). */
  version = 0;

  constructor(private sim: Simulation) {}

  onChunkLoaded(d: ChunkData): void {
    if (!d.glass.length) return;
    const brushes = this.sim.world.chunkBrushes(d.key);
    if (!brushes) return;
    const list: Brush[] = [];
    for (const idx of d.glass) {
      const b = brushes[idx];
      if (!b) continue;
      this.panes.set(b, idx);
      list.push(b);
      if (this.broken.has(`${d.key}:${idx}`)) b.contents = 0;
    }
    this.byChunk.set(d.key, list);
  }

  onChunkUnloaded(key: number): void {
    for (const b of this.byChunk.get(key) ?? []) this.panes.delete(b);
    this.byChunk.delete(key);
  }

  onChunkVisibility(): void {}

  isBroken(chunkKey: number, index: number): boolean {
    return this.broken.has(`${chunkKey}:${index}`);
  }

  isPane(b: Brush): boolean {
    return this.panes.has(b);
  }

  /** Something hit a pane: it breaks (on the host; predicting clients leave it to the host). */
  hit(b: Brush): void {
    const idx = this.panes.get(b);
    if (idx === undefined || this.sim.predicting || this.sim.replica) return;
    this.breakPane(b.chunkKey, idx, true);
  }

  /** Shatter every pane near a point (explosions). */
  breakNear(pos: Vec3, radius: number): void {
    if (this.sim.predicting || this.sim.replica) return;
    for (const [b, idx] of this.panes) {
      if (!b.contents) continue;
      const x = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const y = Math.max(b.minY, Math.min(pos.y, b.maxY));
      const z = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      if (Math.hypot(x - pos.x, y - pos.y, z - pos.z) < radius) this.breakPane(b.chunkKey, idx, true);
    }
  }

  /** Break a pane. `announce` emits the event and noise (the host); replicas apply silently. */
  breakPane(chunkKey: number, index: number, announce: boolean): void {
    const key = `${chunkKey}:${index}`;
    if (this.broken.has(key)) return;
    this.broken.add(key);
    this.version++;
    const b = this.sim.world.chunkBrushes(chunkKey)?.[index];
    if (b) b.contents = 0;
    if (!announce || !b) return;
    const pos = vec3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    this.sim.events.push({ type: 'glass_break', chunkKey, index, pos });
    this.sim.events.push({ type: 'sound', pos, radius: 30, kind: 'glass', sourceId: -1 });
  }

  /** Broken panes, for saves and the host's world state. */
  list(): PaneRef[] {
    return [...this.broken].map((k) => k.split(':').map(Number) as PaneRef);
  }

  /** Replace the broken set (loading a save, or a client applying the host's state). */
  restore(list: readonly PaneRef[]): void {
    for (const [k, i] of list) this.breakPane(k, i, false);
  }

  /** Remember nothing (a new game). */
  reset(): void {
    this.broken.clear();
    this.version++;
  }
}
