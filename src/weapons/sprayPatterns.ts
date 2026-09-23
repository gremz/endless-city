import { hash3, sfc32 } from '../core/rng';

/**
 * Spray patterns: cumulative [pitch°, yaw°] offset of shot n from the crosshair, built from a
 * few control points per weapon plus a small deterministic jitter. Positive pitch = up,
 * positive yaw = left. Recoil index 0 is the first shot (no offset).
 */
type Ctrl = [shot: number, pitch: number, yaw: number];

const CONTROL: Record<string, Ctrl[]> = {
  none: [[0, 0, 0]],
  // Up ~9 shots, swing left, then right, then back left: the classic "7".
  ak: [
    [0, 0, 0],
    [1, 0.25, 0],
    [2, 0.8, 0.05],
    [3, 1.6, 0.1],
    [4, 2.5, 0.05],
    [5, 3.35, -0.1],
    [6, 4.1, -0.25],
    [7, 4.75, -0.15],
    [8, 5.25, 0.15],
    [9, 5.6, 0.55],
    [11, 5.9, 1.5],
    [13, 6.05, 2.5],
    [15, 6.2, 2.8],
    [17, 6.3, 1.5],
    [19, 6.4, -0.3],
    [21, 6.5, -1.8],
    [23, 6.7, -2.6],
    [25, 6.85, -2.0],
    [27, 7.0, -0.6],
    [29, 7.15, 0.5],
  ],
  m4: [
    [0, 0, 0],
    [1, 0.2, 0],
    [2, 0.65, 0.05],
    [3, 1.3, 0.05],
    [4, 2.0, -0.05],
    [5, 2.7, -0.15],
    [6, 3.3, -0.1],
    [7, 3.8, 0.1],
    [8, 4.15, 0.4],
    [10, 4.45, 1.2],
    [12, 4.6, 1.9],
    [14, 4.7, 1.6],
    [16, 4.8, 0.4],
    [18, 4.9, -0.9],
    [20, 5.0, -1.8],
    [22, 5.1, -1.6],
    [25, 5.25, -0.4],
    [29, 5.4, 0.6],
  ],
  mp9: [
    [0, 0, 0],
    [2, 0.6, 0.1],
    [5, 1.8, -0.2],
    [9, 2.8, 0.6],
    [13, 3.3, 1.2],
    [18, 3.6, -0.6],
    [23, 3.8, -1.1],
    [29, 4.0, 0.3],
  ],
  ump: [
    [0, 0, 0],
    [2, 0.7, 0],
    [5, 2.0, 0.2],
    [9, 3.1, -0.5],
    [13, 3.6, -1.2],
    [18, 3.9, 0.3],
    [24, 4.1, 1.0],
  ],
  pistol: [
    [0, 0, 0],
    [1, 0.5, 0],
    [3, 1.3, 0.1],
    [6, 2.2, -0.2],
    [10, 2.8, 0.3],
    [19, 3.3, 0],
  ],
  deagle: [
    [0, 0, 0],
    [1, 2.2, 0.1],
    [2, 4.0, -0.2],
    [4, 6.0, 0.3],
    [6, 7.0, 0],
  ],
  awp: [
    [0, 0, 0],
    [1, 3.0, 0],
    [4, 4.0, 0],
  ],
};

export interface SprayPattern {
  pitch: Float32Array;
  yaw: Float32Array;
}

const cache = new Map<string, SprayPattern>();

export function getPattern(id: string, length = 40): SprayPattern {
  const hit = cache.get(id);
  if (hit) return hit;
  const ctrl = CONTROL[id] ?? CONTROL.none;
  const pitch = new Float32Array(length);
  const yaw = new Float32Array(length);
  const r = sfc32(hash3(0x5eed, id.length, id.charCodeAt(0), 77));
  for (let i = 0; i < length; i++) {
    let k = 0;
    while (k < ctrl.length - 1 && ctrl[k + 1][0] < i) k++;
    const a = ctrl[k];
    const b = ctrl[Math.min(k + 1, ctrl.length - 1)];
    let p: number;
    let y: number;
    if (b[0] === a[0] || i >= b[0]) {
      // Past the last control point: keep climbing slowly.
      const extra = Math.max(0, i - b[0]);
      p = b[1] + extra * 0.05;
      y = b[2];
    } else {
      const t = (i - a[0]) / (b[0] - a[0]);
      p = a[1] + (b[1] - a[1]) * t;
      y = a[2] + (b[2] - a[2]) * t;
    }
    const jitter = i === 0 ? 0 : 0.06;
    pitch[i] = p + (r() - 0.5) * jitter;
    yaw[i] = y + (r() - 0.5) * jitter;
  }
  const pat = { pitch, yaw };
  cache.set(id, pat);
  return pat;
}

/** Interpolated pattern offset at a fractional recoil index. */
export function patternAt(p: SprayPattern, index: number, out: { pitch: number; yaw: number }): void {
  if (index <= 0) {
    out.pitch = 0;
    out.yaw = 0;
    return;
  }
  const n = p.pitch.length - 1;
  const i = Math.min(Math.floor(index), n);
  const j = Math.min(i + 1, n);
  const t = Math.min(1, index - i);
  out.pitch = p.pitch[i] + (p.pitch[j] - p.pitch[i]) * t;
  out.yaw = p.yaw[i] + (p.yaw[j] - p.yaw[i]) * t;
}
