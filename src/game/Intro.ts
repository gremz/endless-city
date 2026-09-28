import type { Vec3 } from '../core/math';

/** Where the camera is and which way it looks (radians, same convention as the player's view). */
export interface CamPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** What the intro films, looked up every frame (the scene's cast can turn up a moment late). */
export interface IntroAnchors {
  /** The player's eye: where the camera ends up. */
  eye: Vec3;
  /** The kneeling officer (or the opening area's middle until he's there). */
  scene: Vec3;
}

/** Pulls a camera spot in towards `from` so it stays out of walls (identity by default). */
export type ClearSpot = (from: Vec3, to: Vec3) => Vec3;

/** Seconds the whole intro takes. */
export const INTRO_LENGTH = 18;
/** Seconds a skip takes to get the camera home. */
export const SKIP_BLEND = 0.6;
/** Key times: the title pose, high over the scene, down beside it, round it, back at your eyes. */
const KEY_TIMES = [0, 5, 10, 14.5, INTRO_LENGTH] as const;
/** The radio call: which line, when (seconds into the intro). */
export const INTRO_CUES: readonly { t: number; line: string }[] = [
  { t: 0.8, line: 'dispatch_intro_1' },
  { t: 10, line: 'dispatch_intro_2' },
  { t: 16.1, line: 'dispatch_intro_3' },
];
/** The last line is said even when skipped: it's the order. */
const LAST_CUE = INTRO_CUES[INTRO_CUES.length - 1].line;
/** Point looked at: the officer's chest. */
const LOOK_UP = 1;

/** Heading and pitch that look from `from` to `to`. */
export function lookAt(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(to.y - from.y, Math.hypot(dx, dz)) };
}

/**
 * The title screen's camera: a slow circle high over the spawn plaza, looking down at the
 * opening scene. `t` in seconds.
 */
export function titleOrbit(t: number, center: Vec3, look: Vec3): CamPose {
  const a = (t / 90) * Math.PI * 2 + 0.6;
  const pos = { x: center.x + Math.sin(a) * 70, y: center.y + 45, z: center.z + Math.cos(a) * 70 };
  return { ...pos, ...lookAt(pos, look) };
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Catmull-Rom through p1..p2 (p0 and p3 shape the curve). */
function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** `v` (x, z) turned by `a` radians. */
function turn(x: number, z: number, a: number): { x: number; z: number } {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - z * s, z: x * s + z * c };
}

export interface IntroFrame {
  pose: CamPose;
  /** Lines to play this frame. */
  cues: string[];
  /** Seconds into the intro (for the HUD's title card and skip hint). */
  t: number;
  done: boolean;
}

/**
 * The opening's intro cinematic, before the player gets control: the camera carries on from the
 * title screen's orbit, drops down to the execution scene while the radio calls it in, circles
 * it, then pulls back into the player's eyes, facing it. Pure: the game feeds it the anchors and
 * places the camera where it says.
 */
export class Intro {
  t = 0;
  private cue = 0;
  /** Skipping: the pose it left from and seconds since. */
  private skipFrom: CamPose | null = null;
  private skipT = 0;
  private last: CamPose;

  constructor(
    /** The title camera's pose when Play was pressed. */
    private start: CamPose,
    private clear: ClearSpot = (_from, to) => to,
  ) {
    this.last = { ...start };
  }

  get skipping(): boolean {
    return this.skipFrom !== null;
  }

  /** Hurry home: a short blend to the eye, no more lines but the last. */
  skip(): void {
    if (this.skipFrom) return;
    this.skipFrom = { ...this.last };
  }

  update(dt: number, a: IntroAnchors): IntroFrame {
    const cues: string[] = [];
    const end = this.endPose(a);
    if (this.skipFrom) {
      this.skipT += dt;
      const k = smooth(this.skipT / SKIP_BLEND);
      const f = this.skipFrom;
      const pose = {
        x: f.x + (end.x - f.x) * k,
        y: f.y + (end.y - f.y) * k,
        z: f.z + (end.z - f.z) * k,
        yaw: f.yaw + wrap(end.yaw - f.yaw) * k,
        pitch: f.pitch + (end.pitch - f.pitch) * k,
      };
      const done = this.skipT >= SKIP_BLEND;
      if (done && this.cue < INTRO_CUES.length) {
        this.cue = INTRO_CUES.length;
        cues.push(LAST_CUE);
      }
      this.last = pose;
      return { pose, cues, t: this.t, done };
    }
    this.t += dt;
    while (this.cue < INTRO_CUES.length && this.t >= INTRO_CUES[this.cue].t) cues.push(INTRO_CUES[this.cue++].line);
    const done = this.t >= INTRO_LENGTH;
    const pose = done ? end : this.poseAt(this.t, a);
    this.last = pose;
    return { pose, cues, t: this.t, done };
  }

  /** The player's view at the hand-off: from the eye, looking at the officer. */
  endPose(a: IntroAnchors): CamPose {
    return { ...a.eye, ...lookAt(a.eye, { x: a.scene.x, y: a.scene.y + LOOK_UP, z: a.scene.z }) };
  }

  /** Camera spots at the key times, for these anchors. */
  keys(a: IntroAnchors): Vec3[] {
    const s = a.scene;
    // Out from the scene towards the player (the officer kneels facing that way).
    let ux = a.eye.x - s.x;
    let uz = a.eye.z - s.z;
    const l = Math.hypot(ux, uz) || 1;
    ux /= l;
    uz /= l;
    const at = (ang: number, dist: number, up: number): Vec3 => {
      const d = turn(ux, uz, ang);
      const from = { x: s.x, y: s.y + 1.5, z: s.z };
      return this.clear(from, { x: s.x + d.x * dist, y: s.y + up, z: s.z + d.z * dist });
    };
    return [
      { x: this.start.x, y: this.start.y, z: this.start.z },
      at(0.9, 38, 24),
      at(0.45, 12, 3.5),
      at(-0.35, 9, 2.4),
      { ...a.eye },
    ];
  }

  private poseAt(t: number, a: IntroAnchors): CamPose {
    const k = this.keys(a);
    let i = 0;
    while (i < KEY_TIMES.length - 2 && t >= KEY_TIMES[i + 1]) i++;
    let u = (t - KEY_TIMES[i]) / (KEY_TIMES[i + 1] - KEY_TIMES[i]);
    // Ease out of the title orbit and into the eye; the middle keeps moving.
    if (i === 0) u = easeIn(u);
    if (i === KEY_TIMES.length - 2) u = smooth(u);
    const p0 = k[Math.max(0, i - 1)];
    const p1 = k[i];
    const p2 = k[i + 1];
    const p3 = k[Math.min(k.length - 1, i + 2)];
    const pos = { x: catmull(p0.x, p1.x, p2.x, p3.x, u), y: catmull(p0.y, p1.y, p2.y, p3.y, u), z: catmull(p0.z, p1.z, p2.z, p3.z, u) };
    // Look at the officer throughout, easing over from wherever the title camera was looking.
    const look = lookAt(pos, { x: a.scene.x, y: a.scene.y + LOOK_UP, z: a.scene.z });
    const w = smooth(t / 2.5);
    return {
      ...pos,
      yaw: this.start.yaw + wrap(look.yaw - this.start.yaw) * w,
      pitch: this.start.pitch + (look.pitch - this.start.pitch) * w,
    };
  }
}

/** Accelerate away from rest (the title camera was drifting slowly). */
function easeIn(u: number): number {
  return u * u * (2 - u);
}
