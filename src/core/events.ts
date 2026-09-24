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
  | { type: 'impact'; /** Who fired. */ actorId: number; pos: Vec3; normal: Vec3; material: number; chunkKey: number }
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
  | { type: 'money'; actorId: number; amount: number; reason: string }
  | { type: 'chunkCleared'; chunkKey: number; bonus: number; level: number }
  | { type: 'respawn'; actorId: number }
  | { type: 'buy'; actorId: number; item: string; ok: boolean; reason?: string }
  | { type: 'pickup'; actorId: number; /** 'medkit', 'ammo' or a weapon id. */ item: string; pos: Vec3; amount: number }
  | { type: 'heal'; actorId: number; phase: 'start' | 'done' | 'cancel'; amount: number }
  | { type: 'message'; /** Only for this player (-1 = everyone). */ actorId: number; text: string }
  | { type: 'nade_pin'; actorId: number; weapon: string }
  | { type: 'nade_throw'; actorId: number; weapon: string }
  | { type: 'nade_bounce'; pos: Vec3; speed: number; material: number }
  | {
      type: 'nade_detonate';
      /** Grenade id. */
      kind: string;
      pos: Vec3;
      /** Molotov that burst in the air (no fire). */
      airburst: boolean;
      /** Surface under the burst, for scorch marks. */
      normal: Vec3 | null;
      chunkKey: number;
    }
  | { type: 'flashed'; actorId: number; strength: number; duration: number }
  | { type: 'fire_out'; pos: Vec3 }
  | { type: 'flashlight'; actorId: number; on: boolean }
  | { type: 'car_door'; actorId: number; vehicleId: number; pos: Vec3; enter: boolean }
  | { type: 'car_crash'; /** Driver, or -1. */ actorId: number; vehicleId: number; pos: Vec3; speed: number }
  | { type: 'car_destroyed'; vehicleId: number; pos: Vec3 };

export type SoundEventKind = 'gunshot' | 'footstep' | 'land' | 'reload' | 'knife' | 'grenade' | 'vehicle';

/** Simple append-only queue drained once per frame by presentation. */
export class EventQueue {
  private items: SimEvent[] = [];
  /** Sound events emitted during the current tick (for AI hearing); cleared each tick. */
  readonly tickSounds: Extract<SimEvent, { type: 'sound' }>[] = [];

  /** Drop everything pushed (client prediction replaying ticks it already showed). */
  muted = false;

  push(e: SimEvent): void {
    if (this.muted) return;
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
