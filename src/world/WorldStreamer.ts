import { LOAD_RADIUS, UNLOAD_RADIUS } from '../core/config';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { brushesFromPacked } from './chunkBrushes';
import { chunkDist, chunkKey, worldToChunk } from './chunkMath';
import type { ChunkData } from './gen/ChunkData';

export type ChunkGenerator = (seed: number, cx: number, cz: number) => ChunkData;

/** Where chunk data comes from: synchronous generation or a worker pool. */
export interface ChunkSource {
  request(cx: number, cz: number): void;
  /** Finished chunks since the last call. `maxSync` bounds synchronous generation work. */
  drain(maxSync: number): ChunkData[];
  readonly inFlight: number;
  readonly maxInFlight: number;
  dispose(): void;
}

/** Generates on the calling thread, a few chunks per drain. */
export class SyncChunkSource implements ChunkSource {
  private queue: [number, number][] = [];
  readonly maxInFlight = 64;
  constructor(
    private seed: number,
    private generate: ChunkGenerator,
  ) {}
  get inFlight() {
    return this.queue.length;
  }
  request(cx: number, cz: number): void {
    this.queue.push([cx, cz]);
  }
  drain(maxSync: number): ChunkData[] {
    const out: ChunkData[] = [];
    while (this.queue.length && out.length < maxSync) {
      const [cx, cz] = this.queue.shift()!;
      out.push(this.generate(this.seed, cx, cz));
    }
    return out;
  }
  dispose(): void {
    this.queue = [];
  }
}

export interface ResidentChunk {
  data: ChunkData;
  visible: boolean;
}

export interface StreamerListener {
  onChunkLoaded(data: ChunkData, visible: boolean): void;
  onChunkUnloaded(key: number, data: ChunkData): void;
  onChunkVisibility(key: number, visible: boolean): void;
}

/**
 * Keeps chunks loaded around the players: everything within LOAD_RADIUS of any of them is loaded
 * and visible, chunks out to UNLOAD_RADIUS stay resident (collision + hidden meshes), beyond that
 * unload.
 */
export class WorldStreamer {
  readonly resident = new Map<number, ResidentChunk>();
  private requested = new Set<number>();
  private listeners: StreamerListener[] = [];
  /** Chunk coordinates of the players the world is kept around. */
  private centers: [number, number][] = [[0, 0]];
  /** Stats for the debug overlay. */
  lastGenMs = 0;
  maxGenMs = 0;
  avgGenMs = 0;
  private genSamples = 0;

  constructor(
    private world: CollisionWorld,
    private source: ChunkSource,
  ) {}

  addListener(l: StreamerListener): void {
    this.listeners.push(l);
    for (const [, r] of this.resident) l.onChunkLoaded(r.data, r.visible);
  }

  get pending(): number {
    return this.requested.size;
  }

  isLoaded(x: number, z: number): boolean {
    return this.resident.has(chunkKey(worldToChunk(x), worldToChunk(z)));
  }

  getChunkAt(x: number, z: number): ChunkData | undefined {
    return this.resident.get(chunkKey(worldToChunk(x), worldToChunk(z)))?.data;
  }

  getChunk(cx: number, cz: number): ChunkData | undefined {
    return this.resident.get(chunkKey(cx, cz))?.data;
  }

  /** Request missing chunks around (x, z), nearest first, biased towards the view direction. */
  update(x: number, z: number, viewYaw = 0): void {
    this.updateAround([{ x, z }], viewYaw);
  }

  /**
   * Request missing chunks around several positions (players). The first one gets priority
   * and the view-direction bias.
   */
  updateAround(points: readonly { x: number; z: number }[], viewYaw = 0): void {
    if (!points.length) return;
    this.centers = points.map((p) => [worldToChunk(p.x), worldToChunk(p.z)]);
    const fx = -Math.sin(viewYaw);
    const fz = -Math.cos(viewYaw);
    const wanted: [number, number, number][] = [];
    const seen = new Set<number>();
    this.centers.forEach(([pcx, pcz], ci) => {
      for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          const key = chunkKey(cx, cz);
          if (this.resident.has(key) || this.requested.has(key) || seen.has(key)) continue;
          seen.add(key);
          const d = Math.max(Math.abs(dx), Math.abs(dz));
          const len = Math.hypot(dx, dz) || 1;
          const facing = ci === 0 ? (dx * fx + dz * fz) / len : 0;
          wanted.push([cx, cz, d * 2 - facing + ci * 0.5]);
        }
      }
    });
    wanted.sort((a, b) => a[2] - b[2]);
    for (const [cx, cz] of wanted) {
      if (this.source.inFlight >= this.source.maxInFlight) break;
      this.requested.add(chunkKey(cx, cz));
      this.source.request(cx, cz);
    }
  }

  /** Chebyshev distance from a chunk to the nearest centre. */
  private centerDist(cx: number, cz: number): number {
    let best = Infinity;
    for (const [pcx, pcz] of this.centers) best = Math.min(best, chunkDist(cx, cz, pcx, pcz));
    return best;
  }

  /**
   * Apply finished chunks and unloads. Collision data only changes here, between sim ticks.
   * Returns the number of chunks applied.
   */
  apply(maxApply = 1, maxUnload = 2): number {
    let applied = 0;
    const ready = this.source.drain(maxApply);
    for (const data of ready) {
      this.requested.delete(data.key);
      const d = this.centerDist(data.cx, data.cz);
      if (d > UNLOAD_RADIUS || this.resident.has(data.key)) continue;
      this.world.addChunk(data.key, brushesFromPacked(data.brushes, data.cx, data.cz, data.key));
      const visible = d <= LOAD_RADIUS;
      this.resident.set(data.key, { data, visible });
      this.recordGen(data.genMs);
      for (const l of this.listeners) l.onChunkLoaded(data, visible);
      applied++;
    }

    let unloaded = 0;
    for (const [key, r] of this.resident) {
      const d = this.centerDist(r.data.cx, r.data.cz);
      if (d > UNLOAD_RADIUS) {
        if (unloaded >= maxUnload) continue;
        this.world.removeChunk(key);
        this.resident.delete(key);
        for (const l of this.listeners) l.onChunkUnloaded(key, r.data);
        unloaded++;
        continue;
      }
      const visible = d <= LOAD_RADIUS;
      if (visible !== r.visible) {
        r.visible = visible;
        for (const l of this.listeners) l.onChunkVisibility(key, visible);
      }
    }
    return applied;
  }

  /** Block until every chunk within `radius` of (x, z) is loaded (startup, teleports). */
  preload(x: number, z: number, radius: number, maxIterations = 500): void {
    for (let i = 0; i < maxIterations; i++) {
      this.update(x, z);
      this.apply(8, 8);
      if (this.allLoaded(x, z, radius)) return;
    }
  }

  allLoaded(x: number, z: number, radius: number): boolean {
    const pcx = worldToChunk(x);
    const pcz = worldToChunk(z);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!this.resident.has(chunkKey(pcx + dx, pcz + dz))) return false;
      }
    }
    return true;
  }

  private recordGen(ms: number): void {
    this.lastGenMs = ms;
    this.maxGenMs = Math.max(this.maxGenMs, ms);
    this.genSamples++;
    this.avgGenMs += (ms - this.avgGenMs) / Math.min(this.genSamples, 50);
  }

  dispose(): void {
    this.source.dispose();
  }
}
