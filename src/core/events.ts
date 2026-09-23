import type { Vec3 } from './math';

/** Events emitted by the simulation for presentation (render, audio, UI) and AI hearing. */
export type SimEvent =
  | {
      type: 'shot';
      shooterId: number;
      weapon: string;
      from: Vec3;
      to: Vec3;
      tracer: boolean;
    }
  | { type: 'impact'; pos: Vec3; normal: Vec3; material: number; chunkKey: number }
  | {
      type: 'hit';
      attackerId: number;
      victimId: number;
      damage: number;
      group: number;
      pos: Vec3;
      helmetHit: boolean;
      killed: boolean;
    }
  | { type: 'kill'; attackerId: number; victimId: number; weapon: string; headshot: boolean; penetrated: boolean }
  | { type: 'sound'; pos: Vec3; radius: number; kind: SoundEventKind; sourceId: number }
  | { type: 'reload'; actorId: number; weapon: string }
  | { type: 'deploy'; actorId: number; weapon: string }
  | { type: 'dryfire'; actorId: number }
  | { type: 'land'; actorId: number; speed: number }
  | { type: 'jump'; actorId: number }
  | { type: 'step'; actorId: number; pos: Vec3; material: number }
  | { type: 'money'; amount: number; reason: string }
  | { type: 'chunkCleared'; chunkKey: number; bonus: number; level: number }
  | { type: 'respawn'; actorId: number }
  | { type: 'buy'; item: string; ok: boolean; reason?: string }
  | { type: 'message'; text: string };

export type SoundEventKind = 'gunshot' | 'footstep' | 'land' | 'reload' | 'knife';

/** Simple append-only queue drained once per frame by presentation. */
export class EventQueue {
  private items: SimEvent[] = [];
  /** Sound events emitted during the current tick (for AI hearing); cleared each tick. */
  readonly tickSounds: Extract<SimEvent, { type: 'sound' }>[] = [];

  push(e: SimEvent): void {
    if (e.type === 'sound') this.tickSounds.push(e);
    this.items.push(e);
    if (this.items.length > 4096) this.items.splice(0, this.items.length - 4096);
  }

  beginTick(): void {
    this.tickSounds.length = 0;
  }

  /** Take all queued events. */
  drain(): SimEvent[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  /** Events currently queued (read-only peek, e.g. for AI hearing within the same tick). */
  peek(): readonly SimEvent[] {
    return this.items;
  }
}
