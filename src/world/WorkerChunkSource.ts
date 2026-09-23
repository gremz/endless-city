import type { ChunkData } from './gen/ChunkData';
import type { ChunkGenerator, ChunkSource } from './WorldStreamer';

interface Pending {
  cx: number;
  cz: number;
  worker: number;
}

/**
 * Generates chunks on a small pool of module workers. Falls back to main-thread generation if
 * workers are unavailable or a worker reports an error.
 */
export class WorkerChunkSource implements ChunkSource {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private pending = new Map<number, Pending>();
  private ready: ChunkData[] = [];
  private fallbackQueue: [number, number][] = [];
  private nextId = 1;
  readonly maxInFlight: number;

  constructor(
    private seed: number,
    private kind: 'city' | 'gym',
    private fallback: ChunkGenerator,
    count = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 2)),
  ) {
    try {
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module', name: `chunkgen-${i}` });
        w.onmessage = (e: MessageEvent<{ id: number; data?: ChunkData; error?: string; cx?: number; cz?: number }>) =>
          this.onResult(i, e.data);
        w.onerror = (e) => {
          console.error('chunk worker error', e.message);
        };
        this.workers.push(w);
        this.busy.push(0);
      }
    } catch (err) {
      console.warn('Workers unavailable, generating on the main thread', err);
      this.workers = [];
    }
    this.maxInFlight = Math.max(2, this.workers.length * 2);
  }

  get inFlight(): number {
    return this.pending.size + this.fallbackQueue.length;
  }

  request(cx: number, cz: number): void {
    if (!this.workers.length) {
      this.fallbackQueue.push([cx, cz]);
      return;
    }
    let wi = 0;
    for (let i = 1; i < this.busy.length; i++) if (this.busy[i] < this.busy[wi]) wi = i;
    const id = this.nextId++;
    this.pending.set(id, { cx, cz, worker: wi });
    this.busy[wi]++;
    this.workers[wi].postMessage({ id, seed: this.seed, cx, cz, kind: this.kind });
  }

  private onResult(worker: number, msg: { id: number; data?: ChunkData; error?: string; cx?: number; cz?: number }): void {
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    this.busy[worker] = Math.max(0, this.busy[worker] - 1);
    if (msg.data) this.ready.push(msg.data);
    else if (p) {
      console.error(`chunk ${p.cx},${p.cz} failed in worker; retrying on main thread\n${msg.error}`);
      this.fallbackQueue.push([p.cx, p.cz]);
    }
  }

  drain(maxSync: number): ChunkData[] {
    const out = this.ready.splice(0, Math.max(1, maxSync));
    while (this.fallbackQueue.length && out.length < maxSync) {
      const [cx, cz] = this.fallbackQueue.shift()!;
      out.push(this.fallback(this.seed, cx, cz));
    }
    return out;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.pending.clear();
    this.ready = [];
  }
}
