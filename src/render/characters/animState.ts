import { CLIP_BY_NAME, RUN_SPEED, WALK_SPEED } from './characterSpec';

/** What the character is doing this frame, as far as its legs are concerned. */
export interface PoseInput {
  /** Ground speed (m/s). */
  speed: number;
  /** Direction of travel relative to facing: 0 forward, +π/2 right, ±π back. */
  moveAngle: number;
  /** 0 standing .. 1 fully crouched. */
  crouch: number;
  /** Seconds off the ground (0 when grounded). */
  airTime: number;
}

export interface Pose {
  /** Target weight per clip; the weights sum to 1. */
  weights: Record<string, number>;
  /**
   * Locomotion cycles per second. Every `loco` clip shares one normalized phase, so feet stay in
   * step while blending; negative plays the cycle backwards (walking backwards without a
   * `*_Back` clip).
   */
  cycleRate: number;
}

/** Below this a moving actor still idles; fully moving from MOVE_FULL. */
const MOVE_START = 0.15;
const MOVE_FULL = 0.7;
/** How long off the ground before the jump pose kicks in (steps and kerbs don't count). */
const AIR_DELAY = 0.15;
/** Playback speed limits relative to the authored speed. */
const MIN_RATE = 0.4;
const MAX_RATE = 2;

const DIRS = [
  { suffix: '', cos: 1, sin: 0 },
  { suffix: '_Right', cos: 0, sin: 1 },
  { suffix: '_Back', cos: -1, sin: 0 },
  { suffix: '_Left', cos: 0, sin: -1 },
] as const;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Pick clip weights and the locomotion rate. `clips` maps each clip the model has to its
 * duration (s); missing optional clips fall back to the required ones.
 */
export function choosePose(input: PoseInput, clips: ReadonlyMap<string, number>): Pose {
  const weights: Record<string, number> = {};
  const add = (name: string, w: number) => {
    if (w > 1e-4) weights[name] = (weights[name] ?? 0) + w;
  };

  if (input.airTime > AIR_DELAY && clips.has('Jump')) {
    add('Jump', 1);
    return { weights, cycleRate: 0 };
  }

  const crouch = Math.min(1, Math.max(0, input.crouch));
  const stand = 1 - crouch;
  const move = smoothstep(MOVE_START, MOVE_FULL, input.speed);
  const runT = Math.min(1, Math.max(0, (input.speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED)));

  // Split the direction over the two nearest of forward/right/back/left.
  const c = Math.cos(input.moveAngle);
  const s = Math.sin(input.moveAngle);
  const dirW = DIRS.map((d) => Math.max(0, c * d.cos + s * d.sin));
  const dirSum = dirW.reduce((a, b) => a + b, 0) || 1;
  // Walking backwards without a back clip: play the forward cycle in reverse.
  const backMissing = !clips.has('Walk_Back') || !clips.has('Run_Back');
  const reverse = backMissing && dirW[2] / dirSum > 0.5;

  add('Idle', stand * (1 - move));
  for (let i = 0; i < DIRS.length; i++) {
    const dw = (dirW[i] / dirSum) * stand * move;
    if (dw <= 0) continue;
    const walk = `Walk${DIRS[i].suffix}`;
    const run = `Run${DIRS[i].suffix}`;
    // Both halves of a direction fall back together, so walk and run never mix directions.
    const has = clips.has(walk) && clips.has(run);
    add(has ? walk : 'Walk', dw * (1 - runT));
    add(has ? run : 'Run', dw * runT);
  }
  add('Crouch_Idle', crouch * (1 - move));
  add('Crouch_Walk', crouch * move);

  // Distance covered per cycle, blended over the locomotion clips in play.
  let locoW = 0;
  let stride = 0;
  let authored = 0;
  for (const [name, w] of Object.entries(weights)) {
    const spec = CLIP_BY_NAME.get(name);
    if (spec?.kind !== 'loco' || !spec.speed) continue;
    const duration = clips.get(name) ?? 1;
    locoW += w;
    stride += w * spec.speed * duration;
    authored += w * spec.speed;
  }
  if (locoW <= 0) return { weights, cycleRate: 0 };
  stride /= locoW;
  authored /= locoW;
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, input.speed / authored));
  const cycleRate = ((rate * authored) / stride) * (reverse ? -1 : 1);
  return { weights, cycleRate };
}
