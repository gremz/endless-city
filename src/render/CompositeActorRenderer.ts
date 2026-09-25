import * as THREE from 'three';
import type { SimEvent } from '../core/events';
import type { Actor } from '../sim/Actor';
import type { ActorRenderer } from './BotRenderer';

/** Splits the actors between renderers (e.g. players as characters, bots as box figures). */
export class CompositeActorRenderer implements ActorRenderer {
  readonly root = new THREE.Group();
  private lists: Actor[][];

  constructor(private parts: { renderer: ActorRenderer; accept: (a: Actor) => boolean }[]) {
    this.root.name = 'actors';
    for (const p of parts) this.root.add(p.renderer.root);
    this.lists = parts.map(() => []);
  }

  update(actors: readonly Actor[], playerId: number, alpha: number, time: number, frameDt: number, torches?: ReadonlySet<number>, torchLevel?: number): void {
    for (const list of this.lists) list.length = 0;
    for (const a of actors) {
      const i = this.parts.findIndex((p) => p.accept(a));
      if (i >= 0) this.lists[i].push(a);
    }
    this.parts.forEach((p, i) => p.renderer.update(this.lists[i], playerId, alpha, time, frameDt, torches, torchLevel));
  }

  onEvent(e: SimEvent): void {
    for (const p of this.parts) p.renderer.onEvent?.(e);
  }

  setShadows(on: boolean): void {
    for (const p of this.parts) p.renderer.setShadows(on);
  }

  dispose(): void {
    for (const p of this.parts) p.renderer.dispose();
  }
}
