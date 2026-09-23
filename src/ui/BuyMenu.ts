import { BUY_MENU, WEAPONS } from '../weapons/weaponDefs';
import type { BuyItem } from '../sim/buy';
import { el } from './dom';

export interface BuyMenuModel {
  money: number;
  price(item: BuyItem): number;
  owned(item: BuyItem): boolean;
  zone(): { ok: boolean; reason: string };
}

const GEAR_NAMES: Record<string, string> = { kevlar: 'Kevlar Vest', helmet: 'Kevlar + Helmet' };

const itemName = (item: BuyItem) => (item === 'kevlar' || item === 'helmet' ? GEAR_NAMES[item] : WEAPONS[item].name);

/** CS-style keyboard buy menu: pick a category with a number key, then an item. */
export class BuyMenu {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private status: HTMLDivElement;
  private category = -1;
  open = false;

  constructor(
    parent: HTMLElement,
    private model: BuyMenuModel,
    private onBuy: (item: BuyItem) => void,
  ) {
    this.body = el('div.buy-body');
    this.status = el('div.buy-status');
    this.root = el('div.buy-menu', {}, [el('div.buy-title', { text: 'BUY MENU' }), this.body, this.status]);
    this.root.hidden = true;
    parent.append(this.root);
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.category = -1;
    this.root.hidden = false;
    this.status.textContent = '';
    this.render();
  }

  close(): void {
    this.open = false;
    this.root.hidden = true;
  }

  /** Number key pressed while open (0 = back/close). */
  select(n: number): void {
    if (n === 0) {
      if (this.category >= 0) this.category = -1;
      else this.close();
      this.render();
      return;
    }
    if (this.category < 0) {
      if (n - 1 < BUY_MENU.length) this.category = n - 1;
    } else {
      const item = BUY_MENU[this.category].items[n - 1];
      if (item) this.onBuy(item);
    }
    this.render();
  }

  feedback(text: string, ok: boolean): void {
    this.status.textContent = text;
    this.status.className = `buy-status ${ok ? 'ok' : 'bad'}`;
    if (this.open) this.render();
  }

  render(): void {
    if (!this.open) return;
    const zone = this.model.zone();
    const rows: HTMLElement[] = [];
    if (!zone.ok) rows.push(el('div.buy-warning', { text: zone.reason }));
    if (this.category < 0) {
      BUY_MENU.forEach((c, i) => rows.push(el('div.buy-row', {}, [el('kbd', { text: String(i + 1) }), el('span', { text: c.title })])));
    } else {
      const c = BUY_MENU[this.category];
      rows.push(el('div.buy-cat', { text: c.title }));
      c.items.forEach((item, i) => {
        const price = this.model.price(item);
        const owned = this.model.owned(item);
        const row = el('div.buy-row', {}, [
          el('kbd', { text: String(i + 1) }),
          el('span.buy-name', { text: itemName(item) }),
          el('span.buy-price', { text: owned ? 'owned' : `$${price}` }),
        ]);
        if (owned || price > this.model.money || !zone.ok) row.classList.add('disabled');
        rows.push(row);
      });
    }
    rows.push(el('div.buy-foot', { text: this.category < 0 ? '0 or B: close' : '0: back · B: close' }));
    this.body.replaceChildren(...rows);
  }
}
