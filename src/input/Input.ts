import { clamp, DEG } from '../core/math';
import { BUTTON_KEYS, LAST_WEAPON_KEY, LOCKED_DUCK_KEYS, MOVE_KEYS, SLOT_KEYS } from './bindings';
import { Buttons, SELECT_LAST, SELECT_NEXT, SELECT_PREV, type UserCmd } from './UserCmd';

/** CS m_yaw / m_pitch: degrees per mouse count at sensitivity 1. */
const M_YAW = 0.022;
const MAX_PITCH = 89 * DEG;

type KeyHandler = (code: string, e: KeyboardEvent) => void;

/**
 * Keyboard + pointer-locked mouse. Mouse deltas are applied to the view angles immediately
 * (every event, not every tick), so aiming never waits for the simulation.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  sensitivity = 2;
  /** Multiplier applied to sensitivity (zoomed weapons). */
  sensScale = 1;
  invertY = false;
  locked = false;
  keyboardLocked = false;
  /** When false, game keys are ignored (menus). */
  enabled = true;
  /** Wheel impulses (+1 / -1) since the last cmd. */
  wheel = 0;

  private held = new Set<string>();
  private buttonsHeld = 0;
  private pressed = 0;
  private attackYaw = 0;
  private attackPitch = 0;
  private attackLatched = false;
  private weaponSelect = -1;
  private keyListeners: KeyHandler[] = [];
  private disposers: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      document.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => document.removeEventListener(type, fn as EventListener, opts));
    };
    on('keydown', (e) => this.onKey(e, true));
    on('keyup', (e) => this.onKey(e, false));
    on('mousemove', (e) => this.onMouseMove(e));
    on('mousedown', (e) => this.onMouseButton(e, true));
    on('mouseup', (e) => this.onMouseButton(e, false));
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    on('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseAll();
    });
    const blur = () => this.releaseAll();
    window.addEventListener('blur', blur);
    this.disposers.push(() => window.removeEventListener('blur', blur));
  }

  /** Subscribe to raw key presses (menus, debug toggles). */
  onKeyDown(fn: KeyHandler): () => void {
    this.keyListeners.push(fn);
    return () => {
      this.keyListeners = this.keyListeners.filter((f) => f !== fn);
    };
  }

  async requestLock(): Promise<void> {
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      // unadjustedMovement is not supported everywhere (e.g. Firefox, some Linux setups).
      await this.canvas.requestPointerLock();
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const code = e.code;
    if (this.locked) {
      // Keep browser shortcuts (F-keys, space scrolling, Tab) out of the way while playing.
      if (code.startsWith('F') && code.length <= 3) e.preventDefault();
      if (code === 'Space' || code === 'Tab' || code.startsWith('Arrow')) e.preventDefault();
      if (e.ctrlKey && this.keyboardLocked) e.preventDefault();
    }
    if (down) {
      if (e.repeat) return;
      this.held.add(code);
      for (const fn of this.keyListeners) fn(code, e);
    } else {
      this.held.delete(code);
    }
    if (!this.enabled && down) return;
    let b = BUTTON_KEYS[code] ?? 0;
    if (!b && this.keyboardLocked && LOCKED_DUCK_KEYS.includes(code)) b = Buttons.DUCK;
    if (b) {
      if (down) {
        this.buttonsHeld |= b;
        this.pressed |= b;
      } else {
        this.buttonsHeld &= ~b;
      }
    }
    if (down && code in SLOT_KEYS) this.weaponSelect = SLOT_KEYS[code];
    if (down && code === LAST_WEAPON_KEY) this.weaponSelect = SELECT_LAST;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked) return;
    // Guard against rare huge spikes some browsers emit when locking.
    const dx = clamp(e.movementX, -800, 800);
    const dy = clamp(e.movementY, -800, 800);
    const k = this.sensitivity * this.sensScale * M_YAW * DEG;
    this.yaw -= dx * k;
    this.pitch -= dy * k * (this.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -MAX_PITCH, MAX_PITCH);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  private onMouseButton(e: MouseEvent, down: boolean): void {
    if (!this.locked || !this.enabled) {
      if (!down) this.buttonsHeld &= ~(e.button === 0 ? Buttons.ATTACK : e.button === 2 ? Buttons.ATTACK2 : 0);
      return;
    }
    const b = e.button === 0 ? Buttons.ATTACK : e.button === 2 ? Buttons.ATTACK2 : 0;
    if (!b) return;
    if (down) {
      this.buttonsHeld |= b;
      this.pressed |= b;
      if (b === Buttons.ATTACK && !this.attackLatched) {
        this.attackYaw = this.yaw;
        this.attackPitch = this.pitch;
        this.attackLatched = true;
      }
    } else {
      this.buttonsHeld &= ~b;
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.locked) return;
    e.preventDefault();
    this.wheel += e.deltaY > 0 ? 1 : -1;
  }

  releaseAll(): void {
    this.held.clear();
    this.buttonsHeld = 0;
  }

  /** Fill a cmd from current input and consume the latched edges. */
  buildCmd(cmd: UserCmd): UserCmd {
    const h = this.held;
    const active = this.enabled && this.locked;
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    cmd.forward = active ? (h.has(MOVE_KEYS.forward) ? 1 : 0) - (h.has(MOVE_KEYS.back) ? 1 : 0) : 0;
    cmd.side = active ? (h.has(MOVE_KEYS.right) ? 1 : 0) - (h.has(MOVE_KEYS.left) ? 1 : 0) : 0;
    cmd.buttons = active ? this.buttonsHeld : 0;
    cmd.pressed = active ? this.pressed : 0;
    cmd.attackYaw = this.attackLatched ? this.attackYaw : this.yaw;
    cmd.attackPitch = this.attackLatched ? this.attackPitch : this.pitch;
    cmd.weaponSelect = active ? this.weaponSelect : -1;
    if (active && this.wheel !== 0) cmd.weaponSelect = this.wheel > 0 ? SELECT_NEXT : SELECT_PREV;
    this.pressed = 0;
    this.attackLatched = false;
    this.weaponSelect = -1;
    this.wheel = 0;
    return cmd;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.exitLock();
  }
}
