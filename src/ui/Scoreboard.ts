import { el } from './dom';

export interface ScoreRow {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  money: number;
  alive: boolean;
}

/** Tab: who's playing, kills, deaths and money (co-op). */
export class Scoreboard {
  private root: HTMLDivElement;
  private body: HTMLTableSectionElement;
  private title: HTMLDivElement;
  private html = '';

  constructor(parent: HTMLElement) {
    this.title = el('div.scoreboard-title');
    this.body = el('tbody');
    const head = el('thead', {}, [
      el('tr', {}, ['Player', 'Kills', 'Deaths', 'Money'].map((t) => el('th', { text: t }))),
    ]);
    this.root = el('div.scoreboard', {}, [this.title, el('table', {}, [head, this.body])]);
    this.root.hidden = true;
    parent.append(this.root);
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  render(title: string, rows: readonly ScoreRow[], me: number): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = rows
      .map(
        (r) =>
          `<tr class="${r.id === me ? 'me' : ''}${r.alive ? '' : ' dead'}"><td>${esc(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>$${r.money.toLocaleString('en-US')}</td></tr>`,
      )
      .join('');
    if (html !== this.html) {
      this.html = html;
      this.body.innerHTML = html;
    }
    this.title.textContent = title;
  }
}
