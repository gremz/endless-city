import { el } from './dom';

export interface MenuCallbacks {
  onPlay(fullscreen: boolean): void;
  onSettings(): void;
  /** Load the saved game (title: Continue, pause: Load save). */
  onLoad(): void;
  /** Save now (pause menu). */
  onSave(): void;
  /** Host a co-op game in this city, or continuing the save. */
  onHost?(name: string, fromSave: boolean): void;
  /** Join a friend's co-op game by room code. */
  onJoin?(code: string, name: string): void;
  /** Leave the co-op game. */
  onLeave?(): void;
}

const NAME_KEY = 'endless-city.name';
/** How long the title takes to fade out when the intro starts (matches .menu.leaving in ui.css). */
const MENU_FADE_MS = 600;

export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage blocked */
  }
}

const CONTROLS: [string, string][] = [
  ['WASD', 'Move'],
  ['Mouse', 'Aim / shoot (LMB), scope (RMB)'],
  ['Space', 'Jump (hold at a ledge to climb up)'],
  ['C', 'Crouch (Ctrl in fullscreen)'],
  ['Shift', 'Walk (silent)'],
  ['R', 'Reload'],
  ['1-5 / Q / wheel', 'Weapons'],
  ['B', 'Buy menu (in cleared zones)'],
  ['E', 'Door (run + E kicks) / car / swap weapon'],
  ['H', 'Use medkit'],
  ['M', 'City map'],
  ['F', 'Inspect'],
  ['Esc', 'Pause'],
  ['Enter / Tab', 'Chat / scores (co-op)'],
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
  private controls: HTMLDetailsElement;
  private fadeTimer = 0;
  private hasSave = false;
  private canSave = false;
  private coop: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private codeInput: HTMLInputElement;
  private hostBtn: HTMLButtonElement;
  private hostSaveBtn: HTMLButtonElement;
  private joinBtn: HTMLButtonElement;
  private canLoad = true;
  private room: HTMLDivElement;
  private roomCode: HTMLSpanElement;
  private roomPlayers: HTMLDivElement;
  private leaveBtn: HTMLButtonElement;
  private coopEnabled = false;
  private online = false;

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
    this.nameInput = el('input.menu-input', { placeholder: 'Your name', maxlength: '20', value: savedName() });
    this.codeInput = el('input.menu-input.code', { placeholder: 'Room code', maxlength: '80' });
    this.hostBtn = el('button.btn', { text: 'Host co-op game' });
    this.hostSaveBtn = el('button.btn', { text: 'Host from save' });
    this.joinBtn = el('button.btn', { text: 'Join' });
    const name = () => {
      const n = this.nameInput.value.trim() || 'Player';
      storeName(n);
      return n;
    };
    this.hostBtn.addEventListener('click', () => cb.onHost?.(name(), false));
    this.hostSaveBtn.addEventListener('click', () => cb.onHost?.(name(), true));
    const join = () => cb.onJoin?.(this.codeInput.value, name());
    this.joinBtn.addEventListener('click', join);
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    this.coop = el('div.menu-coop', {}, [
      el('div.menu-coop-title', { text: 'Co-op · up to 4 players' }),
      el('div.menu-coop-row', {}, [this.nameInput, this.hostBtn]),
      el('div.menu-coop-row', {}, [this.codeInput, this.joinBtn]),
      el('div.menu-coop-row.right', {}, [this.hostSaveBtn]),
    ]);
    this.roomCode = el('span.room-code');
    const copyBtn = el('button.btn.small', { text: 'Copy invite link' });
    copyBtn.addEventListener('click', () => {
      const code = this.roomCode.textContent ?? '';
      const link = `${location.origin}${location.pathname}?join=${code}`;
      navigator.clipboard?.writeText(link).then(
        () => this.setStatus('Invite link copied.'),
        () => this.setStatus(link),
      );
    });
    this.roomPlayers = el('div.room-players');
    this.room = el('div.menu-room', {}, [el('div', {}, [el('span', { text: 'Room code ' }), this.roomCode, copyBtn]), this.roomPlayers]);
    this.leaveBtn = el('button.btn', { text: 'Leave game' });
    this.leaveBtn.addEventListener('click', () => cb.onLeave?.());
    this.controls = el('details.menu-controls', {}, [
      el('summary', { text: 'Controls' }),
      el(
        'div.controls',
        {},
        CONTROLS.map(([k, v]) => el('div.control', {}, [el('kbd', { text: k }), el('span', { text: v })])),
      ),
    ]);
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
      el('div.menu-buttons', {}, [this.playBtn, this.fsBtn, this.continueBtn, this.saveBtn, this.loadBtn, settingsBtn, this.leaveBtn]),
      this.saveLine,
      this.room,
      this.coop,
      this.status,
      this.controls,
      this.seedLine,
    ]);
    this.root = el('div.menu.title', {}, [panel]);
    parent.append(this.root);
    this.updateSaveButtons();
  }

  show(mode: 'title' | 'paused', heading = mode === 'title' ? 'ENDLESS CITY' : 'PAUSED'): void {
    this.mode = mode;
    clearTimeout(this.fadeTimer);
    this.root.classList.remove('leaving');
    this.root.hidden = false;
    // The title is a slim column over the city; the pause menu a panel in the middle, controls open.
    this.root.classList.toggle('title', mode === 'title');
    this.controls.open = mode === 'paused';
    this.heading.textContent = heading;
    this.playBtn.textContent = mode === 'title' ? 'Play' : 'Resume';
    this.fsBtn.textContent = mode === 'title' ? 'Play fullscreen' : 'Resume fullscreen';
    this.updateSaveButtons();
  }

  /** Describe the save slot (null = empty), whether this game can be saved, and loaded from here. */
  setSave(summary: string | null, canSave: boolean, canLoad = true): void {
    this.hasSave = summary !== null;
    this.canSave = canSave;
    this.canLoad = canLoad;
    this.saveLine.textContent = summary ? `Save: ${summary}` : '';
    this.updateSaveButtons();
  }

  private updateSaveButtons(): void {
    this.continueBtn.hidden = this.mode !== 'title' || !this.hasSave;
    this.saveBtn.hidden = this.mode !== 'paused' || !this.canSave;
    this.loadBtn.hidden = this.mode !== 'paused' || !this.hasSave || !this.canLoad;
    this.coop.hidden = this.mode !== 'title' || !this.coopEnabled || this.online;
    this.hostSaveBtn.hidden = !this.hasSave;
    this.leaveBtn.hidden = !this.online;
    this.room.hidden = !this.online || !this.roomCode.textContent;
  }

  /** Offer hosting and joining (title screen of a solo city game). */
  setCoop(enabled: boolean, joinCode = ''): void {
    this.coopEnabled = enabled;
    if (joinCode) this.codeInput.value = joinCode;
    this.updateSaveButtons();
  }

  /** In a co-op game: the room code to share and who's playing. */
  setOnline(code: string | null, host: boolean): void {
    this.online = true;
    this.roomCode.textContent = code ?? '';
    this.leaveBtn.textContent = host ? 'End game' : 'Leave game';
    this.updateSaveButtons();
  }

  setPlayers(names: readonly string[]): void {
    const text = `Players: ${names.join(', ')}`;
    if (this.roomPlayers.textContent !== text) this.roomPlayers.textContent = text;
  }

  /** Block the co-op buttons while connecting. */
  setBusy(busy: boolean): void {
    this.hostBtn.disabled = busy;
    this.hostSaveBtn.disabled = busy;
    this.joinBtn.disabled = busy;
  }

  /** Hide the menu; `fade` lets it fade out over the game (leaving the title for the intro). */
  hide(fade = false): void {
    clearTimeout(this.fadeTimer);
    if (!fade || this.root.hidden) {
      this.root.hidden = true;
      return;
    }
    this.root.classList.add('leaving');
    this.fadeTimer = window.setTimeout(() => {
      this.root.hidden = true;
      this.root.classList.remove('leaving');
    }, MENU_FADE_MS);
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
