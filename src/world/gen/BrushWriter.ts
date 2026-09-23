import { Contents, Ramp, SOLID, type RampDir } from '../../physics/brush';
import { BRUSH_STRIDE, packBrushWord } from './ChunkData';

/** Growable brush buffer. Inputs are chunk-local meters, stored as integer centimeters. */
export class BrushWriter {
  private data: Int32Array;
  count = 0;

  constructor(capacity = 512) {
    this.data = new Int32Array(capacity * BRUSH_STRIDE);
  }

  /** Add an axis-aligned box brush. Degenerate boxes are skipped. */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    material: number,
    contents: number = SOLID,
    tint = 128,
    ramp: RampDir = Ramp.None,
  ): void {
    const ax = Math.round(Math.min(x0, x1) * 100);
    const bx = Math.round(Math.max(x0, x1) * 100);
    const ay = Math.round(Math.min(y0, y1) * 100);
    const by = Math.round(Math.max(y0, y1) * 100);
    const az = Math.round(Math.min(z0, z1) * 100);
    const bz = Math.round(Math.max(z0, z1) * 100);
    if (bx - ax < 1 || by - ay < 1 || bz - az < 1) return;
    if (this.count * BRUSH_STRIDE >= this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count * BRUSH_STRIDE;
    const d = this.data;
    d[o] = ax;
    d[o + 1] = ay;
    d[o + 2] = az;
    d[o + 3] = bx;
    d[o + 4] = by;
    d[o + 5] = bz;
    d[o + 6] = packBrushWord(ramp, material, contents);
    d[o + 7] = tint & 255;
    this.count++;
  }

  /** Wedge rising towards `dir` from y0 to y1. */
  ramp(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    dir: RampDir,
    material: number,
    contents: number = SOLID | Contents.FLOOR,
    tint = 128,
  ): void {
    this.box(x0, y0, z0, x1, y1, z1, material, contents, tint, dir);
  }

  /**
   * CS-style stairs: visible, bullet-solid steps plus an invisible player-clip ramp so
   * movement over them is smooth. Rises from y0 to y1 towards dir.
   */
  stairs(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    dir: RampDir,
    material: number,
    stepHeight = 0.25,
    tint = 128,
    /** Whether the clip ramp counts as navigable floor for the bot nav bake. */
    nav = true,
  ): void {
    const rise = y1 - y0;
    const steps = Math.max(1, Math.round(rise / stepHeight));
    const along = dir === Ramp.PosX || dir === Ramp.NegX;
    const len = along ? x1 - x0 : z1 - z0;
    const tread = len / steps;
    const stepContents = Contents.SOLID_BULLET | Contents.VISIBLE;
    for (let i = 0; i < steps; i++) {
      const top = y0 + (rise * (i + 1)) / steps;
      // Step i is a column one tread wide (non-overlapping, so no coplanar faces).
      let a0: number;
      let a1: number;
      if (dir === Ramp.PosX || dir === Ramp.PosZ) {
        a0 = (along ? x0 : z0) + tread * i;
        a1 = a0 + tread;
      } else {
        a1 = (along ? x1 : z1) - tread * i;
        a0 = a1 - tread;
      }
      if (along) this.box(a0, y0, z0, a1, top, z1, material, stepContents, tint);
      else this.box(x0, y0, a0, x1, top, a1, material, stepContents, tint);
    }
    // Invisible clip ramp through the step nosings (it starts one tread before the first
    // step), plus a flat clip block on the top tread.
    const clip = Contents.SOLID_PLAYER | (nav ? Contents.FLOOR : 0);
    switch (dir) {
      case Ramp.PosX:
        this.box(x0 - tread, y0, z0, x1 - tread, y1, z1, material, clip, tint, dir);
        this.box(x1 - tread, y0, z0, x1, y1, z1, material, clip, tint);
        break;
      case Ramp.NegX:
        this.box(x0 + tread, y0, z0, x1 + tread, y1, z1, material, clip, tint, dir);
        this.box(x0, y0, z0, x0 + tread, y1, z1, material, clip, tint);
        break;
      case Ramp.PosZ:
        this.box(x0, y0, z0 - tread, x1, y1, z1 - tread, material, clip, tint, dir);
        this.box(x0, y0, z1 - tread, x1, y1, z1, material, clip, tint);
        break;
      default:
        this.box(x0, y0, z0 + tread, x1, y1, z1 + tread, material, clip, tint, dir);
        this.box(x0, y0, z0, x1, y1, z0 + tread, material, clip, tint);
        break;
    }
  }

  /** Tread length the stairs() call will use (callers leave this much clearance in front). */
  static treadFor(rise: number, length: number, stepHeight = 0.25): number {
    return length / Math.max(1, Math.round(rise / stepHeight));
  }

  finish(): Int32Array {
    return this.data.slice(0, this.count * BRUSH_STRIDE);
  }
}
