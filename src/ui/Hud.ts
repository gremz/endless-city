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
  private death: HTMLDivElement;
  private deathTitle: HTMLDivElement;
  private deathHint: HTMLDivElement;
  private buyHint: HTMLDivElement;
  private prompt: HTMLDivElement;
  private promptText: string | null = null;
  private medkitBox: HTMLDivElement;
  private medkitCount: HTMLSpanElement;
  private healBar: HTMLDivElement;
  private healHint: HTMLDivElement;
  private healFlash: HTMLDivElement;
  private healUntil = 0;
  private flashOverlay: HTMLDivElement;
  private flashLevel = -1;
  private nades: HTMLDivElement;
  private nadeKey = '';
  private clockEl: HTMLDivElement;
  private clockKey = '';
  private ammoBox: HTMLDivElement;
  private carBox: HTMLDivElement;
  private carSpeed: HTMLSpanElement;
  private carBar: HTMLDivElement;
  private carKey = '';
  private lastGap = -1;
  private last = { hp: -1, ar: -1, helmet: false, clip: -1, res: -1, name: '', money: -1, kits: -1, heal: -1 };
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
    this.medkitCount = el('span.hud-kits', { text: '×0' });
    this.healBar = el('div.heal-bar');
    this.medkitBox = el('div.hud-vital.hud-medkit.none', {}, [el('span.medkit-icon'), this.medkitCount, this.healBar]);
    const vitals = el('div.hud-vitals', {}, [
      this.money,
      el('div.hud-row', {}, [el('div.hud-vital', {}, [el('span.hud-icon', { text: '✚' }), this.health]), this.armorBox, this.medkitBox]),
    ]);
    this.ammo = el('span.hud-ammo', { text: '20' });
    this.reserve = el('span.hud-reserve', { text: '/ 120' });
    this.weaponName = el('div.hud-weapon', { text: 'Glock-18' });
    this.nades = el('div.hud-nades');
    const ammoBox = el('div.hud-ammo-box', {}, [this.nades, this.weaponName, el('div', {}, [this.ammo, this.reserve])]);
    this.ammoBox = ammoBox;
    this.carSpeed = el('span.hud-ammo', { text: '0' });
    this.carBar = el('div.car-bar-fill');
    this.carBox = el('div.hud-ammo-box.hud-car', {}, [
      el('div.hud-weapon', { text: 'Car' }),
      el('div', {}, [this.carSpeed, el('span.hud-reserve', { text: 'km/h' })]),
      el('div.car-bar', {}, [this.carBar]),
      el('div.car-keys', {}, [el('kbd', { text: 'E' }), ' Get out  ', el('kbd', { text: 'Space' }), ' Handbrake']),
    ]);
    this.carBox.hidden = true;
    this.flashOverlay = el('div.flash-overlay');
    this.clockEl = el('div.hud-clock');
    this.hitMarker = el('div.hitmarker', {}, [0, 1, 2, 3].map((i) => el(`div.hm.hm-${i}`)));
    this.feed = el('div.killfeed');
    this.scope = el('div.scope', {}, [el('div.scope-h'), el('div.scope-v')]);
    this.center = el('div.center-msg');
    this.damageFlash = el('div.damage-flash');
    this.arcs = el('div.dmg-arcs');
    this.compass = el('div.compass');
    this.buyHint = el('div.buy-hint', { text: 'Press B to buy' });
    this.healHint = el('div.heal-hint', { text: 'Press H to use a medkit' });
    this.prompt = el('div.use-prompt');
    this.healFlash = el('div.heal-flash');
    this.deathTitle = el('div.death-title');
    this.deathHint = el('div.death-hint');
    this.death = el('div.death', {}, [this.deathTitle, this.deathHint]);
    this.death.hidden = true;
    this.root = el('div.hud', {}, [
      this.flashOverlay,
      this.damageFlash,
      this.healFlash,
      this.scope,
      this.crosshair,
      this.hitMarker,
      this.arcs,
      vitals,
      ammoBox,
      this.carBox,
      this.feed,
      this.center,
      this.compass,
      this.clockEl,
      this.buyHint,
      this.healHint,
      this.prompt,
      this.death,
    ]);
    this.scope.hidden = true;
    this.buyHint.hidden = true;
    this.healHint.hidden = true;
    this.prompt.hidden = true;
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

  /** Ammo readout: a gun shows clip / reserve, a grenade its count, the knife nothing. */
  setAmmo(name: string, clip: number, reserve: number, kind: 'gun' | 'melee' | 'count'): void {
    const l = this.last;
    if (name !== l.name) {
      this.weaponName.textContent = name;
      l.name = name;
      l.clip = -1;
    }
    if (clip !== l.clip || reserve !== l.res) {
      this.ammo.textContent = kind === 'melee' ? '' : kind === 'count' ? `×${clip}` : String(clip);
      this.reserve.textContent = kind === 'gun' ? `/ ${reserve}` : '';
      this.ammo.classList.toggle('low', kind === 'gun' && clip <= 5);
      l.clip = clip;
      l.res = reserve;
    }
  }

  /** While driving the ammo box becomes the car's speed and health; null hides it again. */
  setDriving(car: { speed: number; health: number; smoking: boolean } | null): void {
    const key = car ? `${Math.round(car.speed * 3.6)}|${Math.round(car.health * 100)}|${car.smoking}` : '';
    if (key === this.carKey) return;
    const was = this.carKey !== '';
    this.carKey = key;
    if (!car) {
      this.carBox.hidden = true;
      this.ammoBox.hidden = false;
      return;
    }
    if (!was) {
      this.carBox.hidden = false;
      this.ammoBox.hidden = true;
    }
    this.carSpeed.textContent = String(Math.round(car.speed * 3.6));
    this.carBar.style.transform = `scaleX(${Math.max(0, Math.min(1, car.health))})`;
    this.carBar.classList.toggle('low', car.smoking);
  }

  /** Grenade belt above the ammo box: one chip per carried grenade, the selected type lit. */
  setGrenades(list: readonly { label: string; count: number; kind: string }[], selected: string, inHand: boolean): void {
    const key = `${list.map((g) => `${g.kind}${g.count}`).join()}|${selected}|${inHand}`;
    if (key === this.nadeKey) return;
    this.nadeKey = key;
    const chips: HTMLElement[] = [];
    for (const g of list) {
      for (let i = 0; i < g.count; i++) {
        const chip = el(`span.nade-chip.nade-${g.kind}`, { text: g.label });
        if (g.kind === selected) chip.classList.add(inHand ? 'active' : 'selected');
        chips.push(chip);
      }
    }
    this.nades.replaceChildren(...chips);
  }

  /** Time of day under the radar: sun or moon, HH:MM and the weather. */
  setClock(hour: number, daylight: number, weather: string): void {
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 6) * 10;
    const icon = daylight > 0.5 ? '☀' : '☾';
    const sky = weather === 'clear' ? '' : `  ·  ${weather}`;
    const key = `${icon} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${sky}`;
    if (key === this.clockKey) return;
    this.clockKey = key;
    this.clockEl.textContent = key;
  }

  /** Flashbang whiteout, 0..1. */
  setFlash(v: number): void {
    const q = Math.round(v * 100) / 100;
    if (q === this.flashLevel) return;
    this.flashLevel = q;
    this.flashOverlay.style.opacity = String(q);
  }

  /** Carried medkits, and 0..1 progress of the one being applied (0 = not healing). */
  setMedkits(count: number, healProgress: number, hint: boolean): void {
    const l = this.last;
    if (count !== l.kits) {
      this.medkitCount.textContent = `×${count}`;
      this.medkitBox.classList.toggle('none', count <= 0);
      l.kits = count;
    }
    if (healProgress !== l.heal) {
      this.healBar.style.transform = `scaleX(${healProgress})`;
      this.healBar.classList.toggle('active', healProgress > 0);
      l.heal = healProgress;
    }
    this.healHint.hidden = !hint;
  }

  healed(): void {
    this.healUntil = this.clock + 0.35;
    this.healFlash.classList.add('show');
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

  showDeath(title: string | null, hint = ''): void {
    this.death.hidden = title === null;
    if (title !== null) {
      this.deathTitle.textContent = title;
      this.deathHint.textContent = hint;
    }
  }

  setScope(on: boolean): void {
    this.scope.hidden = !on;
  }

  setBuyHint(on: boolean): void {
    this.buyHint.hidden = !on;
  }

  /** Interaction prompt under the crosshair (e.g. weapon swap), or null to hide. */
  setPrompt(text: string | null): void {
    if (text === this.promptText) return;
    this.promptText = text;
    this.prompt.hidden = text === null;
    if (text !== null) this.prompt.replaceChildren(el('kbd', { text: 'E' }), ` ${text}`);
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
    if (this.clock > this.healUntil) this.healFlash.classList.remove('show');
    for (const f of this.feedEntries) {
      const age = this.clock - f.born;
      if (age > 6) f.node.style.opacity = String(Math.max(0, 1 - (age - 6)));
    }
    while (this.feedEntries.length && this.clock - this.feedEntries[this.feedEntries.length - 1].born > 7) {
      this.feedEntries.pop()!.node.remove();
    }
  }
}
