import type { EventQueue } from '../core/events';
import type { Actor } from './Actor';

export const START_MONEY = 800;
export const MAX_MONEY = 16000;

/** Player money: kill rewards, chunk-clear bonuses and purchases. Each player has their own. */
export class Economy {
  constructor(private events: EventQueue) {}

  add(a: Actor, amount: number, reason: string): void {
    const before = a.money;
    a.money = Math.max(0, Math.min(MAX_MONEY, a.money + amount));
    const delta = a.money - before;
    if (delta !== 0) this.events.push({ type: 'money', actorId: a.id, amount: delta, reason });
  }

  canAfford(a: Actor, price: number): boolean {
    return a.money >= price;
  }

  spend(a: Actor, price: number, reason: string): boolean {
    if (!this.canAfford(a, price)) return false;
    this.add(a, -price, reason);
    return true;
  }
}
