import { el } from './dom';

export interface MenuCallbacks {
  onPlay(fullscreen: boolean): void;
  onSettings(): void;
}

const CONTROLS: [string, string][] = [
  ['WASD', 'Move'],
  ['Mouse', 'Aim / shoot (LMB), scope (RMB)'],
  ['Space', 'Jump'],
  ['C', 'Crouch (Ctrl in fullscreen)'],
  ['Shift', 'Walk (silent)'],
  ['R', 'Reload'],
  ['1-5 / Q / wheel', 'Weapons'],
  ['B', 'Buy menu (in cleared zones)'],
  ['F', 'Inspect'],
  ['Esc', 'Pause'],
  ['F3', 'Debug overlay'],
];

/** Title screen and pause screen (same panel, different heading/buttons). */
export class MainMenu {
  readonly root: HTMLDivElement;
  private status: HTMLDivElement;
  private heading: HTMLHeadingElement;
  private playBtn: HTMLButtonElement;
  private fsBtn: HTMLButtonElement;
  private seedLine: HTMLDivElement;

  constructor(parent: HTMLElement, cb: MenuCallbacks) {
    this.heading = el('h1.menu-title', { text: 'ENDLESS CITY' });
    const sub = el('div.menu-sub', { text: 'An open-world, endlessly generated tactical shooter' });
    this.playBtn = el('button.btn.primary', { text: 'Play' });
    this.fsBtn = el('button.btn', { text: 'Play fullscreen' });
    const settingsBtn = el('button.btn', { text: 'Settings' });
    this.status = el('div.menu-status');
    this.seedLine = el('div.menu-seed');
    const controls = el(
      'div.controls',
      {},
      CONTROLS.map(([k, v]) => el('div.control', {}, [el('kbd', { text: k }), el('span', { text: v })])),
    );
    this.playBtn.addEventListener('click', () => cb.onPlay(false));
    this.fsBtn.addEventListener('click', () => cb.onPlay(true));
    settingsBtn.addEventListener('click', () => cb.onSettings());
    const panel = el('div.menu-panel', {}, [
      this.heading,
      sub,
      el('div.menu-buttons', {}, [this.playBtn, this.fsBtn, settingsBtn]),
      this.status,
      controls,
      this.seedLine,
    ]);
    this.root = el('div.menu', {}, [panel]);
    parent.append(this.root);
  }

  show(mode: 'title' | 'paused'): void {
    this.root.hidden = false;
    this.heading.textContent = mode === 'title' ? 'ENDLESS CITY' : 'PAUSED';
    this.playBtn.textContent = mode === 'title' ? 'Play' : 'Resume';
    this.fsBtn.textContent = mode === 'title' ? 'Play fullscreen' : 'Resume fullscreen';
  }

  hide(): void {
    this.root.hidden = true;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setReady(ready: boolean): void {
    this.playBtn.disabled = !ready;
    this.fsBtn.disabled = !ready;
  }

  setSeed(seed: string): void {
    this.seedLine.textContent = `World seed: ${seed}`;
  }
}
