import { Buttons } from './UserCmd';

/** Key code → held button. */
export const BUTTON_KEYS: Record<string, number> = {
  Space: Buttons.JUMP,
  KeyC: Buttons.DUCK,
  ShiftLeft: Buttons.WALK,
  ShiftRight: Buttons.WALK,
  KeyR: Buttons.RELOAD,
  KeyE: Buttons.USE,
  KeyF: Buttons.INSPECT,
  KeyB: Buttons.BUY,
};

/** Keys that also crouch when the keyboard is locked (fullscreen), where Ctrl+W is safe. */
export const LOCKED_DUCK_KEYS = ['ControlLeft'];

export const MOVE_KEYS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
} as const;

/** Number keys select weapon slots / buy menu entries. */
export const SLOT_KEYS: Record<string, number> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
  Digit7: 7,
  Digit8: 8,
  Digit9: 9,
  Digit0: 0,
};

export const LAST_WEAPON_KEY = 'KeyQ';

/** Debug keys (F5 is avoided on purpose: it reloads the page if not intercepted). */
export const DEBUG_KEYS = {
  overlay: 'F3',
  brushes: 'F4',
  nav: 'F6',
  bots: 'F7',
  hitboxes: 'F8',
  noclip: 'F9',
  slowmo: 'F10',
  spawnSquad: 'F2',
} as const;
