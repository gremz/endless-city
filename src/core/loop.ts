import { MAX_TICKS_PER_FRAME } from './config';

/**
 * Fixed-timestep accumulator. Call `advance(frameDt, tick)` once per frame; it runs `tick`
 * 0..MAX_TICKS_PER_FRAME times and returns the interpolation alpha for rendering.
 */
export class FixedLoop {
  private acc = 0;
  ticksLastFrame = 0;

  constructor(public tickDt: number) {}

  reset(): void {
    this.acc = 0;
  }

  /** Seconds of frame time still needed before the next tick runs. */
  get untilNextTick(): number {
    return Math.max(0, this.tickDt - this.acc);
  }

  advance(frameDt: number, tick: () => void): number {
    // Frame timestamps can run backwards around a long task (e.g. building the game).
    this.acc += Math.max(0, Math.min(frameDt, 0.25));
    let n = 0;
    while (this.acc >= this.tickDt && n < MAX_TICKS_PER_FRAME) {
      tick();
      this.acc -= this.tickDt;
      n++;
    }
    // Spiral-of-death guard: drop the backlog rather than trying to catch up forever.
    if (n === MAX_TICKS_PER_FRAME) this.acc = 0;
    this.ticksLastFrame = n;
    return this.acc / this.tickDt;
  }
}
