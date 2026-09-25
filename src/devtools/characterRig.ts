import { CROUCH_WALK_SPEED, NODES, RUN_SPEED, WALK_SPEED } from '../render/characters/characterSpec';
import { GlbBuilder } from './glbWriter';

/**
 * The rig and procedural clips shared by the generated characters (the placeholder box soldier
 * and the SWAT player): a named bone tree, the weapon and torch sockets, and every required clip
 * plus a few optional ones, posed with simple two-bone IK. Proportions come from a `RigDims`, so
 * each body keeps its feet on the ground and its hands on the rifle.
 *
 * glTF space: +Y up, the character faces +Z (Blender's -Y front after the Y-up export), so its
 * right hand is on -X. In the bind pose every bone is unrotated and the limbs hang straight down.
 */

export type V3 = [number, number, number];
type Q = [number, number, number, number];

const Q_ID: Q = [0, 0, 0, 1];
const DOWN: V3 = [0, -1, 0];
const DEG = Math.PI / 180;

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpV = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qConj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
function qAxis(axis: V3, angle: number): Q {
  const s = Math.sin(angle / 2);
  const n = norm(axis);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}
const qX = (a: number) => qAxis([1, 0, 0], a);
const qY = (a: number) => qAxis([0, 1, 0], a);
const qZ = (a: number) => qAxis([0, 0, 1], a);
/** Shortest rotation taking unit vector a to unit vector b. */
function qFromTo(a: V3, b: V3): Q {
  const d = dot(a, b);
  if (d < -0.999999) {
    const axis = Math.abs(a[0]) < 0.9 ? cross([1, 0, 0], a) : cross([0, 1, 0], a);
    return qAxis(axis, Math.PI);
  }
  const c = cross(a, b);
  const q: Q = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qSlerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Q = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const q: Q = [lerp(a[0], bb[0], t), lerp(a[1], bb[1], t), lerp(a[2], bb[2], t), lerp(a[3], bb[3], t)];
    const l = Math.hypot(...q);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

// ---- Rig ----

export interface BoneDef {
  name: string;
  parent: string | null;
  /** Bind-pose position (m). */
  at: V3;
}

/** A body's proportions. The poses were authored for the placeholder's and are scaled to fit. */
export interface RigDims {
  /** Hips, Spine, Chest, Neck, Head and {UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot}_{L,R}. */
  bones: BoneDef[];
  upperArm: number;
  lowerArm: number;
  thigh: number;
  shin: number;
  /** Ankle height with the foot flat on the ground. */
  ankleY: number;
  /** Grip below the wrist, in hand space. */
  grip: V3;
  /** Added to every chest-space hand target (to follow a higher or lower shoulder). */
  armShift: V3;
}

/** Bone tree with the given joint positions, limbs hanging straight down. */
export function humanoidBones(o: { hips: number; spine: number; chest: number; neck: number; head: number; shoulder: V3; elbowY: number; wristY: number; hip: V3; kneeY: number; ankleY: number }): BoneDef[] {
  return [
    { name: NODES.hips, parent: null, at: [0, o.hips, 0] },
    { name: NODES.spine, parent: NODES.hips, at: [0, o.spine, 0] },
    { name: NODES.chest, parent: NODES.spine, at: [0, o.chest, 0] },
    { name: 'Neck', parent: NODES.chest, at: [0, o.neck, 0] },
    { name: NODES.head, parent: 'Neck', at: [0, o.head, 0] },
    ...(['L', 'R'] as const).flatMap((side) => {
      const s = side === 'L' ? 1 : -1;
      const x = o.shoulder[0] * s;
      const lx = o.hip[0] * s;
      return [
        { name: `UpperArm_${side}`, parent: NODES.chest, at: [x, o.shoulder[1], o.shoulder[2]] as V3 },
        { name: `LowerArm_${side}`, parent: `UpperArm_${side}`, at: [x, o.elbowY, o.shoulder[2]] as V3 },
        { name: `Hand_${side}`, parent: `LowerArm_${side}`, at: [x, o.wristY, o.shoulder[2]] as V3 },
        { name: `UpperLeg_${side}`, parent: NODES.hips, at: [lx, o.hip[1], o.hip[2]] as V3 },
        { name: `LowerLeg_${side}`, parent: `UpperLeg_${side}`, at: [lx, o.kneeY, o.hip[2]] as V3 },
        { name: `Foot_${side}`, parent: `LowerLeg_${side}`, at: [lx, o.ankleY, o.hip[2]] as V3 },
      ];
    }),
  ];
}

/** Socket axes: +Y along the barrel (+Z, forward), +Z out of the top (+Y, up). */
const SOCKET_ROT: Q = [0, Math.SQRT1_2, Math.SQRT1_2, 0];
/** The leg length (hip joint to ankle) and heights the poses were authored for. */
const REF_LEG = 0.84;
const REF_ANKLE = 0.08;
const REF_HIPS = 0.95;

/** Chest-space wrist targets for the rifle hold: shouldered, the top of the gun near eye level. */
const HOLD_R: V3 = [-0.11, 0.22, 0.28];
const HOLD_L: V3 = [-0.04, 0.24, 0.47];
/** Pistol: both arms out straight in front at shoulder height, hands together. */
const PISTOL_R: V3 = [-0.04, 0.15, 0.5];
const PISTOL_L: V3 = [0.0, 0.13, 0.47];
/** Knife: blade hand low and forward, the other hand up as a guard. */
const KNIFE_R: V3 = [-0.2, -0.28, 0.18];
const KNIFE_L: V3 = [0.15, -0.16, 0.2];
/** Grenade: held out straight in front, the free arm relaxed at the side. */
const GRENADE_R: V3 = [-0.12, 0.13, 0.5];
const GRENADE_L: V3 = [0.26, -0.34, 0.08];
/** Low ready (long guns while moving): gun across the chest, muzzle angled down. */
const READY_R: V3 = [-0.1, 0.0, 0.28];
const READY_L: V3 = [0.0, -0.08, 0.42];
const READY_PITCH = 25 * DEG;

/** Local rotation per bone plus the hips' position. */
interface Pose {
  rot: Map<string, Q>;
  hips: V3;
}

export interface ClipDef {
  name: string;
  duration: number;
  loop: boolean;
  pose: (t: number, phase: number) => Pose;
  /** Only these bones are keyed (overlays key the upper body). */
  bones?: string[];
}

/** Every generated clip, posed for the given body. */
export function clipDefs(r: RigDims): ClipDef[] {
  const BONES = r.bones;
  const BONE = new Map(BONES.map((b) => [b.name, b]));
  const local = (name: string): V3 => {
    const b = BONE.get(name)!;
    return b.parent ? sub(b.at, BONE.get(b.parent)!.at) : b.at;
  };
  const bindHips = BONE.get(NODES.hips)!.at[1];
  const k = (r.thigh + r.shin) / REF_LEG;
  /** Authored ankle height → this body's. */
  const ay = (y: number) => r.ankleY + (y - REF_ANKLE) * k;
  /** Authored hips height → this body's (same knee bend). */
  const hy = (y: number) => bindHips + (y - REF_HIPS) * k;

  // The weapon socket is keyed too, so a hand can bend while the gun stays level.
  const newPose = (hips: V3 = [0, bindHips, 0]): Pose => ({ rot: new Map([...BONES.map((b): [string, Q] => [b.name, Q_ID]), [NODES.weapon, SOCKET_ROT]]), hips });

  /**
   * Two-bone IK in the parent's space: rotations for the upper and lower bone (and the end bone
   * kept level with the parent) so the chain starting at `root` reaches `target`, bending towards
   * `pole`.
   */
  function ik(pose: Pose, upper: string, lower: string, end: string, root: V3, target: V3, a: number, b: number, pole: V3): void {
    const toT = sub(target, root);
    const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, len(toT)));
    const dir = norm(toT);
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const bend = norm(sub(pole, scale(dir, dot(pole, dir))));
    const elbow = add(root, add(scale(dir, a * cosA), scale(bend, a * sinA)));
    const hand = add(root, scale(dir, d));
    const qUpper = qFromTo(DOWN, norm(sub(elbow, root)));
    const qLowerP = qFromTo(DOWN, norm(sub(hand, elbow)));
    const qLower = qMul(qConj(qUpper), qLowerP);
    pose.rot.set(upper, qUpper);
    pose.rot.set(lower, qLower);
    pose.rot.set(end, qConj(qLowerP));
  }

  /**
   * Put the wrists on chest-space targets. Both hands line up with their forearms (the grip in
   * one palm, the handguard in the other); the socket turns back so the gun stays level with the
   * chest, or dips by `gunPitch`.
   */
  function arms(pose: Pose, right: V3 = HOLD_R, left: V3 = HOLD_L, gunPitch = 0): void {
    const chest = BONE.get(NODES.chest)!.at;
    ik(pose, 'UpperArm_R', 'LowerArm_R', 'Hand_R', sub(BONE.get('UpperArm_R')!.at, chest), add(right, r.armShift), r.upperArm, r.lowerArm, [-0.8, -1, -0.3]);
    ik(pose, 'UpperArm_L', 'LowerArm_L', 'Hand_L', sub(BONE.get('UpperArm_L')!.at, chest), add(left, r.armShift), r.upperArm, r.lowerArm, [0.6, -1, -0.4]);
    pose.rot.set('Hand_R', Q_ID);
    pose.rot.set('Hand_L', Q_ID);
    const forearm = qMul(pose.rot.get('UpperArm_R')!, pose.rot.get('LowerArm_R')!);
    pose.rot.set(NODES.weapon, qMul(qConj(forearm), qMul(qX(gunPitch), SOCKET_ROT)));
  }

  /** Put the ankles at world positions (authored heights; the hips must be unrotated). */
  function legs(pose: Pose, footL: V3, footR: V3): void {
    for (const [side, foot] of [['L', footL], ['R', footR]] as const) {
      const hip = add(pose.hips, local(`UpperLeg_${side}`));
      ik(pose, `UpperLeg_${side}`, `LowerLeg_${side}`, `Foot_${side}`, hip, [foot[0], ay(foot[1]), foot[2]], r.thigh, r.shin, [0, 0, 1]);
    }
  }

  /** Ankle position through a gait cycle: planted and sliding back, then swung forward. */
  function gait(phase: number, x: number, half: number, stance: number, lift: number): V3 {
    const p = ((phase % 1) + 1) % 1;
    if (p < stance) return [x, 0.08, half * (1 - (2 * p) / stance)];
    const u = (p - stance) / (1 - stance);
    return [x, 0.08 + lift * Math.sin(Math.PI * u), -half + 2 * half * (0.5 - 0.5 * Math.cos(Math.PI * u))];
  }

  function standing(): Pose {
    const p = newPose([0, hy(0.935), 0]);
    arms(p);
    legs(p, [0.12, 0.08, 0.08], [-0.12, 0.08, -0.06]);
    return p;
  }

  /** Locomotion cycle with the left foot planting at phase 0 (the same in every cycle clip). */
  function cycle(phase: number, o: { speed: number; duration: number; stance: number; lift: number; hipY: number; bob: number; lean: number }): Pose {
    const half = (o.speed * o.duration * o.stance) / 2;
    const p = newPose([0, hy(o.hipY) + o.bob * Math.cos(4 * Math.PI * phase), 0]);
    p.rot.set(NODES.hips, qY(4 * DEG * Math.cos(2 * Math.PI * phase)));
    legs(p, gait(phase, 0.1, half, o.stance, o.lift), gait(phase + 0.5, -0.1, half, o.stance, o.lift));
    p.rot.set(NODES.spine, qMul(qX(o.lean), qY(-4 * DEG * Math.cos(2 * Math.PI * phase))));
    p.rot.set(NODES.chest, qX(-o.lean * 0.6));
    arms(p);
    return p;
  }

  const WALK = { speed: WALK_SPEED, duration: 0.9, stance: 0.5, lift: 0.1, hipY: 0.9, bob: 0.015, lean: 3 * DEG };
  const RUN = { speed: RUN_SPEED, duration: 0.6, stance: 0.25, lift: 0.25, hipY: 0.85, bob: 0.03, lean: 14 * DEG };
  const CROUCH_WALK = { speed: CROUCH_WALK_SPEED, duration: 1.0, stance: 0.5, lift: 0.1, hipY: 0.52, bob: 0.01, lean: 30 * DEG };

  function crouched(phase: number): Pose {
    const p = newPose([0, hy(0.5) + 0.004 * Math.sin(2 * Math.PI * phase), 0]);
    legs(p, [0.13, 0.08, 0.2], [-0.12, 0.08, -0.14]);
    p.rot.set(NODES.spine, qX(30 * DEG));
    p.rot.set(NODES.chest, qX(-18 * DEG));
    arms(p);
    return p;
  }

  function idle(phase: number): Pose {
    const p = standing();
    const breath = Math.sin(2 * Math.PI * phase);
    p.hips = [0, hy(0.935) - 0.004 * breath, 0];
    p.rot.set(NODES.chest, qX(-1.2 * DEG * breath));
    p.rot.set(NODES.head, qY(3 * DEG * Math.sin(2 * Math.PI * phase)));
    return p;
  }

  function jump(phase: number): Pose {
    const p = newPose([0, hy(0.95), 0]);
    const tuck = 0.3 + 0.03 * Math.sin(2 * Math.PI * phase);
    legs(p, [0.12, tuck, 0.14], [-0.12, tuck + 0.05, 0.02]);
    arms(p);
    return p;
  }

  /** Falls onto its back: knees buckle, hips rotate back and drop, arms fling out. */
  function death(t: number): Pose {
    const start = standing();
    // Lying down, the hips' height is the body's thickness, not the legs'.
    const end = newPose([0, 0.13, -0.35]);
    end.rot.set(NODES.hips, qX(-90 * DEG));
    end.rot.set(NODES.head, qY(25 * DEG));
    end.rot.set('UpperArm_L', qZ(75 * DEG));
    end.rot.set('UpperArm_R', qMul(qZ(-60 * DEG), qX(-20 * DEG)));
    end.rot.set('LowerArm_L', qX(-25 * DEG));
    end.rot.set('LowerArm_R', qX(-40 * DEG));
    end.rot.set('UpperLeg_L', qX(-12 * DEG));
    end.rot.set('LowerLeg_L', qX(20 * DEG));
    end.rot.set('UpperLeg_R', qZ(-8 * DEG));
    const fall = Math.min(1, t / 0.6);
    const kk = fall * fall;
    const buckle = Math.sin(Math.PI * Math.min(1, t / 0.7)) * (1 - kk);
    const p = newPose(lerpV(start.hips, end.hips, kk));
    for (const b of BONES) p.rot.set(b.name, qSlerp(start.rot.get(b.name)!, end.rot.get(b.name)!, b.name === NODES.hips ? kk : Math.min(1, t / 0.8)));
    // Knees give way first.
    for (const side of ['L', 'R']) {
      p.rot.set(`UpperLeg_${side}`, qMul(p.rot.get(`UpperLeg_${side}`)!, qX(-35 * DEG * buckle)));
      p.rot.set(`LowerLeg_${side}`, qMul(p.rot.get(`LowerLeg_${side}`)!, qX(60 * DEG * buckle)));
    }
    // A small settle bounce at the end.
    if (t > 0.6) p.hips = add(p.hips, [0, 0.03 * Math.max(0, Math.sin(Math.PI * Math.min(1, (t - 0.6) / 0.25))), 0]);
    return p;
  }

  // Overlays start and end on the idle hold; the game adds them on top of the current pose.

  function shoot(t: number): Pose {
    const p = standing();
    const kick = t < 0.04 ? t / 0.04 : Math.max(0, 1 - (t - 0.04) / 0.14);
    p.rot.set(NODES.chest, qX(-5 * DEG * kick));
    p.rot.set(NODES.head, qX(2 * DEG * kick));
    return p;
  }

  function hit(t: number): Pose {
    const p = standing();
    const kh = t < 0.08 ? t / 0.08 : Math.max(0, 1 - (t - 0.08) / 0.27);
    p.rot.set(NODES.spine, qMul(qX(-10 * DEG * kh), qZ(6 * DEG * kh)));
    p.rot.set(NODES.head, qX(-16 * DEG * kh));
    return p;
  }

  function reload(t: number): Pose {
    const p = standing();
    const mag = add(HOLD_R, [0.02, -0.14, 0.04]);
    const belt: V3 = [0.12, -0.42, 0.1];
    const keys: [number, V3][] = [[0, HOLD_L], [0.3, mag], [0.6, belt], [0.9, mag], [1.2, HOLD_L], [1.4, HOLD_L]];
    let left = HOLD_L;
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, a] = keys[i];
      const [t1, b] = keys[i + 1];
      if (t >= t0 && t <= t1) {
        const u = (t - t0) / (t1 - t0);
        left = lerpV(a, b, u * u * (3 - 2 * u));
      }
    }
    const cant = Math.sin(Math.PI * Math.min(1, t / 1.3));
    arms(p, add(HOLD_R, [0.03 * cant, 0.02 * cant, 0]), left);
    p.rot.set('Hand_R', qMul(p.rot.get('Hand_R')!, qZ(-25 * DEG * cant)));
    return p;
  }

  function throwNade(t: number): Pose {
    const p = standing();
    const back: V3 = [-0.18, 0.3, -0.16];
    const out: V3 = [-0.1, 0.12, 0.55];
    let right = HOLD_R;
    if (t < 0.3) right = lerpV(HOLD_R, back, t / 0.3);
    else if (t < 0.45) right = lerpV(back, out, (t - 0.3) / 0.15);
    else right = lerpV(out, HOLD_R, Math.min(1, (t - 0.45) / 0.25));
    arms(p, right, HOLD_L);
    // Wind up (turn the throwing shoulder back), unwind through the throw, settle.
    const twist = t < 0.3 ? t / 0.3 : t < 0.45 ? 1 - (2 * (t - 0.3)) / 0.15 : Math.min(0, -1 + (t - 0.45) / 0.25);
    p.rot.set(NODES.chest, qY(-15 * DEG * twist));
    return p;
  }

  /** Standing with the arms on other targets (hold clips: two identical keys), both hands straight. */
  function holding(right: V3, left: V3, gunPitch = 0): Pose {
    const p = standing();
    arms(p, right, left, gunPitch);
    return p;
  }

  const UPPER = BONES.filter((b) => {
    for (let p: string | null = b.name; p; p = BONE.get(p)?.parent ?? null) if (p === NODES.spine) return true;
    return false;
  }).map((b) => b.name);

  return [
    { name: 'Idle', duration: 3, loop: true, pose: (_t, ph) => idle(ph) },
    { name: 'Walk', duration: WALK.duration, loop: true, pose: (_t, ph) => cycle(ph, WALK) },
    { name: 'Run', duration: RUN.duration, loop: true, pose: (_t, ph) => cycle(ph, RUN) },
    { name: 'Crouch_Idle', duration: 3, loop: true, pose: (_t, ph) => crouched(ph) },
    { name: 'Crouch_Walk', duration: CROUCH_WALK.duration, loop: true, pose: (_t, ph) => cycle(ph, CROUCH_WALK) },
    { name: 'Death', duration: 1.2, loop: false, pose: (t) => death(t) },
    { name: 'Jump', duration: 1, loop: true, pose: (_t, ph) => jump(ph) },
    { name: 'Shoot', duration: 0.18, loop: false, pose: (t) => shoot(t), bones: UPPER },
    { name: 'Hit', duration: 0.35, loop: false, pose: (t) => hit(t), bones: UPPER },
    { name: 'Reload', duration: 1.4, loop: false, pose: (t) => reload(t), bones: UPPER },
    { name: 'Throw', duration: 0.7, loop: false, pose: (t) => throwNade(t), bones: UPPER },
    { name: 'Hold_Pistol', duration: 1, loop: true, pose: () => holding(PISTOL_R, PISTOL_L), bones: UPPER },
    { name: 'Hold_Knife', duration: 1, loop: true, pose: () => holding(KNIFE_R, KNIFE_L), bones: UPPER },
    { name: 'Hold_Grenade', duration: 1, loop: true, pose: () => holding(GRENADE_R, GRENADE_L), bones: UPPER },
    { name: 'Hold_Ready', duration: 1, loop: true, pose: () => { const p = standing(); arms(p, READY_R, READY_L, READY_PITCH); return p; }, bones: UPPER },
  ];
}

/** Clip names every generated character provides. */
export const GENERATED_CLIPS = ['Idle', 'Walk', 'Run', 'Crouch_Idle', 'Crouch_Walk', 'Death', 'Jump', 'Shoot', 'Hit', 'Reload', 'Throw', 'Hold_Pistol', 'Hold_Knife', 'Hold_Grenade', 'Hold_Ready'];

// ---- Build ----

/**
 * A GLB under construction with the rig in it: a root node, the bone tree and the sockets. Add
 * meshes (skinned body via `skinned`, rigid gear via `attach`), then `finish` writes the skin and
 * the clips.
 */
export class RiggedGlb {
  readonly g = new GlbBuilder();
  readonly ids = new Map<string, number>();
  readonly joints: string[];
  readonly jointIndex: Map<string, number>;
  private root: number;
  private bone: Map<string, BoneDef>;
  private dims: RigDims;

  constructor(dims: RigDims) {
    this.dims = dims;
    const j = this.g.json;
    this.bone = new Map(dims.bones.map((b) => [b.name, b]));
    this.root = this.g.node({ name: 'Soldier', children: [] });
    j.scenes[0].nodes.push(this.root);
    for (const b of dims.bones) {
      const id = this.g.node({ name: b.name, translation: b.parent ? sub(b.at, this.bone.get(b.parent)!.at) : b.at });
      this.ids.set(b.name, id);
      const parent = b.parent ? j.nodes[this.ids.get(b.parent)!] : j.nodes[this.root];
      (parent.children ??= []).push(id);
    }
    const socket = this.g.node({ name: NODES.weapon, translation: dims.grip, rotation: SOCKET_ROT, children: [] });
    this.ids.set(NODES.weapon, socket);
    (j.nodes[this.ids.get('Hand_R')!].children ??= []).push(socket);
    // Torch under the barrel: 0.55 m along +Y, 5 cm below (-Z) in socket space.
    j.nodes[socket].children.push(this.g.node({ name: NODES.torch, translation: [0, 0.55, -0.05] }));
    this.joints = dims.bones.map((b) => b.name);
    this.jointIndex = new Map(this.joints.map((n, i) => [n, i]));
  }

  /** Bind-pose position of a bone. */
  at(bone: string): V3 {
    return this.bone.get(bone)!.at;
  }

  /** Hang a plain (unskinned) node off a bone; its mesh is in the bone's space. */
  attach(bone: string, node: Record<string, unknown>): number {
    const id = this.g.node(node);
    (this.g.json.nodes[this.ids.get(bone)!].children ??= []).push(id);
    return id;
  }

  /** Add the skinned body (a mesh whose primitives carry JOINTS_0/WEIGHTS_0 in `joints` order). */
  skinned(name: string, mesh: number): void {
    const { g, joints } = this;
    const ibm = new Float32Array(joints.length * 16);
    joints.forEach((n, i) => {
      const at = this.at(n);
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -at[0], -at[1], -at[2], 1], i * 16);
    });
    g.json.skins.push({ name: 'Armature', joints: joints.map((n) => this.ids.get(n)!), skeleton: this.ids.get(NODES.hips), inverseBindMatrices: g.accessor(ibm, 'MAT4') });
    const body = g.node({ name, mesh, skin: g.json.skins.length - 1 });
    g.json.nodes[this.root].children.push(body);
  }

  /** Sample the clips at 30 fps and write the file. */
  finish(): Uint8Array {
    const { g, ids, joints } = this;
    const FPS = 30;
    for (const def of clipDefs(this.dims)) {
      const frames = Math.max(2, Math.round(def.duration * FPS) + 1);
      const times = new Float32Array(frames);
      const keyed = [...(def.bones ?? joints), NODES.weapon];
      const rots = new Map(keyed.map((n) => [n, new Float32Array(frames * 4)]));
      const hips = new Float32Array(frames * 3);
      const last = new Map<string, Q>();
      for (let f = 0; f < frames; f++) {
        const t = (f / (frames - 1)) * def.duration;
        times[f] = t;
        const pose = def.pose(t, def.loop ? t / def.duration : 0);
        for (const n of keyed) {
          let q = pose.rot.get(n)!;
          // Keep neighbouring keys in the same hemisphere so linear interpolation takes the short way.
          const prev = last.get(n);
          if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
          last.set(n, q);
          rots.get(n)!.set(q, f * 4);
        }
        hips.set(pose.hips, f * 3);
      }
      const input = g.accessor(times, 'SCALAR', { minMax: true });
      const samplers: { input: number; output: number; interpolation: string }[] = [];
      const channels: { sampler: number; target: { node: number; path: string } }[] = [];
      for (const n of keyed) {
        samplers.push({ input, output: g.accessor(rots.get(n)!, 'VEC4'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: ids.get(n)!, path: 'rotation' } });
      }
      if (!def.bones) {
        samplers.push({ input, output: g.accessor(hips, 'VEC3'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: ids.get(NODES.hips)!, path: 'translation' } });
      }
      g.json.animations.push({ name: def.name, samplers, channels });
    }
    return g.finish();
  }
}
