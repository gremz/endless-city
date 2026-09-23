import type { Settings } from '../core/settings';
import { el } from './dom';

interface FeedEntry {
  node: HTMLElement;
  born: number;
}

/** In-game HUD: crosshair, vitals, ammo, money, hit markers, kill feed, scope, center messages. */
export class Hud {
  readonly root: HTMLDivElement;
  private crosshair: HTMLDivElement;
  private chLines: HTMLDivElement[];
  private chDot: HTMLDivElement;
  private health: HTMLSpanElement;
  private armor: HTMLSpanElement;
  private armorBox: HTMLDivElement;
  private helmetIcon: HTMLSpanElement;
  private ammo: HTMLSpanElement;
  private reserve: HTMLSpanElement;
  private weaponName: HTMLDivElement;
  private money: HTMLDivElement;
  private hitMarker: HTMLDivElement;
  private feed: HTMLDivElement;
  private feedEntries: FeedEntry[] = [];
  private scope: HTMLDivElement;
  private center: HTMLDivElement;
  private centerUntil = 0;
  private hitUntil = 0;
  private damageFlash: HTMLDivElement;
  private dmgUntil = 0;
  private arcs: HTMLDivElement;
  private compass: HTMLDivElement;
  private buyHint: HTMLDivElement;
  private lastGap = -1;
  private last = { hp: -1, ar: -1, helmet: false, clip: -1, res: -1, name: '', money: -1 };
  private clock = 0;

  constructor(parent: HTMLElement, private settings: Settings) {
    this.chLines = [0, 1, 2, 3].map((i) => el(`div.ch-line.ch-${i}`));
    this.chDot = el('div.ch-dot');
    this.crosshair = el('div.crosshair', {}, [...this.chLines, this.chDot]);
    this.health = el('span.hud-num', { text: '100' });
    this.armor = el('span.hud-num', { text: '0' });
    this.helmetIcon = el('span.hud-helmet', { text: '⛑' });
    this.armorBox = el('div.hud-vital', {}, [el('span.hud-icon', { text: '◈' }), this.armor, this.helmetIcon]);
    this.money = el('div.hud-money', { text: '$800' });
    const vitals = el('div.hud-vitals', {}, [
      this.money,
      el('div.hud-row', {}, [el('div.hud-vital', {}, [el('span.hud-icon', { text: '✚' }), this.health]), this.armorBox]),
    ]);
    this.ammo = el('span.hud-ammo', { text: '20' });
    this.reserve = el('span.hud-reserve', { text: '/ 120' });
    this.weaponName = el('div.hud-weapon', { text: 'Glock-18' });
    const ammoBox = el('div.hud-ammo-box', {}, [this.weaponName, el('div', {}, [this.ammo, this.reserve])]);
    this.hitMarker = el('div.hitmarker', {}, [0, 1, 2, 3].map((i) => el(`div.hm.hm-${i}`)));
    this.feed = el('div.killfeed');
    this.scope = el('div.scope', {}, [el('div.scope-h'), el('div.scope-v')]);
    this.center = el('div.center-msg');
    this.damageFlash = el('div.damage-flash');
    this.arcs = el('div.dmg-arcs');
    this.compass = el('div.compass');
    this.buyHint = el('div.buy-hint', { text: 'Press B to buy' });
    this.root = el('div.hud', {}, [
      this.damageFlash,
      this.scope,
      this.crosshair,
      this.hitMarker,
      this.arcs,
      vitals,
      ammoBox,
      this.feed,
      this.center,
      this.compass,
      this.buyHint,
    ]);
    this.scope.hidden = true;
    this.buyHint.hidden = true;
    parent.append(this.root);
    this.applyCrosshairStyle();
  }

  applyCrosshairStyle(): void {
    const s = this.settings;
    this.crosshair.style.setProperty('--ch-color', s.crosshairColor);
    this.crosshair.style.setProperty('--ch-size', `${s.crosshairSize}px`);
    this.crosshair.style.setProperty('--ch-thick', `${s.crosshairThickness}px`);
    this.chDot.hidden = !s.crosshairDot;
    this.lastGap = -1;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  /**
   * Crosshair gap from weapon inaccuracy (radians), projected with the vertical FOV so the
   * lines show where shots can land.
   */
  setSpread(inaccRad: number, vFovRad: number, screenH: number, showCrosshair: boolean): void {
    this.crosshair.hidden = !showCrosshair;
    const s = this.settings;
    const dyn = s.crosshairDynamic ? (Math.tan(inaccRad) / Math.tan(vFovRad / 2)) * (screenH / 2) : 0;
    const gap = Math.round(s.crosshairGap + Math.min(dyn, 120));
    if (gap === this.lastGap) return;
    this.lastGap = gap;
    this.crosshair.style.setProperty('--ch-gap', `${gap}px`);
  }

  setVitals(hp: number, armor: number, helmet: boolean): void {
    const l = this.last;
    if (hp !== l.hp) {
      this.health.textContent = String(hp);
      this.health.classList.toggle('low', hp <= 25);
      l.hp = hp;
    }
    if (armor !== l.ar || helmet !== l.helmet) {
      this.armor.textContent = String(armor);
      this.helmetIcon.hidden = !helmet;
      this.armorBox.classList.toggle('none', armor <= 0);
      l.ar = armor;
      l.helmet = helmet;
    }
  }

  setAmmo(name: string, clip: number, reserve: number, melee: boolean): void {
    const l = this.last;
    if (name !== l.name) {
      this.weaponName.textContent = name;
      l.name = name;
    }
    if (clip !== l.clip || reserve !== l.res) {
      this.ammo.textContent = melee ? '' : String(clip);
      this.reserve.textContent = melee ? '' : `/ ${reserve}`;
      this.ammo.classList.toggle('low', !melee && clip <= 5);
      l.clip = clip;
      l.res = reserve;
    }
  }

  setMoney(money: number): void {
    if (money === this.last.money) return;
    this.money.textContent = `$${money}`;
    this.last.money = money;
  }

  flashMoney(delta: number): void {
    const n = el('div.money-pop', { text: `${delta >= 0 ? '+' : '-'}$${Math.abs(delta)}` });
    if (delta < 0) n.classList.add('neg');
    this.money.append(n);
    setTimeout(() => n.remove(), 1600);
  }

  setScope(on: boolean): void {
    this.scope.hidden = !on;
  }

  setBuyHint(on: boolean): void {
    this.buyHint.hidden = !on;
  }

  hit(kind: 'body' | 'head' | 'kill'): void {
    this.hitMarker.className = `hitmarker show ${kind}`;
    this.hitUntil = this.clock + (kind === 'kill' ? 0.35 : 0.16);
  }

  damaged(fromAngle: number | null): void {
    this.dmgUntil = this.clock + 0.25;
    this.damageFlash.classList.add('show');
    if (fromAngle !== null) {
      const arc = el('div.dmg-arc');
      arc.style.transform = `translate(-50%, -50%) rotate(${fromAngle}rad)`;
      this.arcs.append(arc);
      setTimeout(() => arc.remove(), 1200);
    }
  }

  killFeed(killer: string, victim: string, weapon: string, headshot: boolean, mine: boolean, penetrated: boolean): void {
    const node = el('div.feed-entry', {}, [
      el('span.feed-name', { text: killer }),
      el('span.feed-weapon', { text: ` ${weapon}${penetrated ? ' ⟂' : ''}${headshot ? ' ◉' : ''} ` }),
      el('span.feed-name', { text: victim }),
    ]);
    if (mine) node.classList.add('mine');
    this.feed.prepend(node);
    this.feedEntries.unshift({ node, born: this.clock });
    while (this.feedEntries.length > 5) this.feedEntries.pop()!.node.remove();
  }

  message(text: string, seconds = 2.5, kind = ''): void {
    this.center.textContent = text;
    this.center.className = `center-msg show ${kind}`;
    this.centerUntil = this.clock + seconds;
  }

  setCompass(items: { angle: number; label: string; color: string }[], viewYaw: number): void {
    // Render markers along a 180° strip centered on the view direction.
    this.compass.replaceChildren(
      ...items
        .map((it) => {
          let d = it.angle - viewYaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          if (Math.abs(d) > Math.PI / 2) return null;
          const m = el('div.compass-mark', { text: it.label });
          m.style.left = `${50 - (d / (Math.PI / 2)) * 50}%`;
          m.style.color = it.color;
          return m;
        })
        .filter((x): x is HTMLDivElement => x !== null),
    );
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.clock > this.hitUntil) this.hitMarker.classList.remove('show');
    if (this.clock > this.centerUntil) this.center.classList.remove('show');
    if (this.clock > this.dmgUntil) this.damageFlash.classList.remove('show');
    for (const f of this.feedEntries) {
      const age = this.clock - f.born;
      if (age > 6) f.node.style.opacity = String(Math.max(0, 1 - (age - 6)));
    }
    while (this.feedEntries.length && this.clock - this.feedEntries[this.feedEntries.length - 1].born > 7) {
      this.feedEntries.pop()!.node.remove();
    }
  }
}
