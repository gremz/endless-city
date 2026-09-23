import { el } from './dom';

export interface DebugStats {
  lines: [string, string][];
}

/** F3 overlay: frame timing, render stats, streaming, player state. Updated a few times per second. */
export class DebugOverlay {
  readonly root: HTMLDivElement;
  private body: HTMLPreElement;
  private speedo: HTMLDivElement;
  private frames: number[] = [];
  private lastUpdate = 0;
  visible: boolean;

  constructor(parent: HTMLElement, visible: boolean) {
    this.body = el('pre.debug-body');
    this.root = el('div.debug-overlay', {}, [this.body]);
    this.speedo = el('div.speedo');
    parent.append(this.root, this.speedo);
    this.visible = visible;
    this.apply();
  }

  toggle(): void {
    this.visible = !this.visible;
    this.apply();
  }

  private apply(): void {
    this.root.hidden = !this.visible;
    this.speedo.hidden = !this.visible;
  }

  /** Record a frame time (ms). */
  frame(ms: number): void {
    this.frames.push(ms);
    if (this.frames.length > 240) this.frames.shift();
  }

  frameStats(): { fps: number; avg: number; p99: number; max: number } {
    const f = this.frames;
    if (!f.length) return { fps: 0, avg: 0, p99: 0, max: 0 };
    const sorted = [...f].sort((a, b) => a - b);
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    return {
      fps: 1000 / avg,
      avg,
      p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))],
      max: sorted[sorted.length - 1],
    };
  }

  setSpeed(huPerSec: number, onGround: boolean): void {
    if (!this.visible) return;
    this.speedo.textContent = `${Math.round(huPerSec)}`;
    this.speedo.classList.toggle('air', !onGround);
  }

  /** Returns true when it's time to refresh (caller then builds lines). */
  due(now: number): boolean {
    if (!this.visible || now - this.lastUpdate < 200) return false;
    this.lastUpdate = now;
    return true;
  }

  set(lines: [string, string][]): void {
    const w = Math.max(...lines.map(([k]) => k.length));
    this.body.textContent = lines.map(([k, v]) => (k ? `${k.padEnd(w)}  ${v}` : '')).join('\n');
  }
}
