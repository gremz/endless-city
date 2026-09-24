import { el } from './dom';

export interface MenuCallbacks {
  onPlay(fullscreen: boolean): void;
  onSettings(): void;
  /** Load the saved game (title: Continue, pause: Load save). */
  onLoad(): void;
  /** Save now (pause menu). */
  onSave(): void;
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
  ['E', 'Pick up / swap weapon'],
  ['H', 'Use medkit'],
  ['M', 'City map'],
  ['F', 'Inspect'],
  ['Esc', 'Pause'],
  ['F3', 'Debug overlay'],
];

/** Title screen and pause screen (same panel, different heading/buttons), with save/load. */
export class MainMenu {
  readonly root: HTMLDivElement;
  private status: HTMLDivElement;
  private heading: HTMLHeadingElement;
  private playBtn: HTMLButtonElement;
  private fsBtn: HTMLButtonElement;
  private seedLine: HTMLDivElement;
  private continueBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private loadBtn: HTMLButtonElement;
  private saveLine: HTMLDivElement;
  private mode: 'title' | 'paused' = 'title';
  private hasSave = false;
  private canSave = false;

  constructor(parent: HTMLElement, cb: MenuCallbacks) {
    this.heading = el('h1.menu-title', { text: 'ENDLESS CITY' });
    const sub = el('div.menu-sub', { text: 'An open-world, endlessly generated tactical shooter' });
    this.playBtn = el('button.btn.primary', { text: 'Play' });
    this.fsBtn = el('button.btn', { text: 'Play fullscreen' });
    const settingsBtn = el('button.btn', { text: 'Settings' });
    this.continueBtn = el('button.btn', { text: 'Continue' });
    this.saveBtn = el('button.btn', { text: 'Save game' });
    this.loadBtn = el('button.btn', { text: 'Load save' });
    this.saveLine = el('div.menu-save');
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
    this.continueBtn.addEventListener('click', () => cb.onLoad());
    this.saveBtn.addEventListener('click', () => cb.onSave());
    this.loadBtn.addEventListener('click', () => {
      if (confirm('Load your save? Progress since then will be lost.')) cb.onLoad();
    });
    const panel = el('div.menu-panel', {}, [
      this.heading,
      sub,
      el('div.menu-buttons', {}, [this.playBtn, this.fsBtn, this.continueBtn, this.saveBtn, this.loadBtn, settingsBtn]),
      this.saveLine,
      this.status,
      controls,
      this.seedLine,
    ]);
    this.root = el('div.menu', {}, [panel]);
    parent.append(this.root);
    this.updateSaveButtons();
  }

  show(mode: 'title' | 'paused', heading = mode === 'title' ? 'ENDLESS CITY' : 'PAUSED'): void {
    this.mode = mode;
    this.root.hidden = false;
    this.heading.textContent = heading;
    this.playBtn.textContent = mode === 'title' ? 'Play' : 'Resume';
    this.fsBtn.textContent = mode === 'title' ? 'Play fullscreen' : 'Resume fullscreen';
    this.updateSaveButtons();
  }

  /** Describe the save slot (null = empty) and whether this game can be saved at all. */
  setSave(summary: string | null, canSave: boolean): void {
    this.hasSave = summary !== null;
    this.canSave = canSave;
    this.saveLine.textContent = summary ? `Save: ${summary}` : '';
    this.updateSaveButtons();
  }

  private updateSaveButtons(): void {
    this.continueBtn.hidden = this.mode !== 'title' || !this.hasSave;
    this.saveBtn.hidden = this.mode !== 'paused' || !this.canSave;
    this.loadBtn.hidden = this.mode !== 'paused' || !this.hasSave;
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
