import type { EventQueue } from '../core/events';

export const START_MONEY = 800;
export const MAX_MONEY = 16000;

/** Player money: kill rewards, chunk-clear bonuses and purchases. */
export class Economy {
  money = START_MONEY;

  constructor(private events: EventQueue) {}

  add(amount: number, reason: string): void {
    const before = this.money;
    this.money = Math.max(0, Math.min(MAX_MONEY, this.money + amount));
    const delta = this.money - before;
    if (delta !== 0) this.events.push({ type: 'money', amount: delta, reason });
  }

  canAfford(price: number): boolean {
    return this.money >= price;
  }

  spend(price: number, reason: string): boolean {
    if (!this.canAfford(price)) return false;
    this.add(-price, reason);
    return true;
  }
}
