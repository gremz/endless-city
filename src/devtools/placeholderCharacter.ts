import { CLIPS, GEAR, MATERIALS, NODES } from '../render/characters/characterSpec';
import { GENERATED_CLIPS, humanoidBones, RiggedGlb, type RigDims, type V3 } from './characterRig';

/**
 * A stand-in soldier that follows the character spec exactly: a jointed box figure on the shared
 * generated rig (characterRig.ts) with helmet and vest gear. Written to
 * public/models/characters/placeholder.glb by `npm run models:placeholder`; it doubles as a
 * template to open in Blender for the bone names and socket axes.
 */

export const PLACEHOLDER_RIG: RigDims = {
  bones: humanoidBones({ hips: 0.95, spine: 1.05, chest: 1.3, neck: 1.52, head: 1.58, shoulder: [0.22, 1.47, 0], elbowY: 1.17, wristY: 0.9, hip: [0.1, 0.92, 0], kneeY: 0.5, ankleY: 0.08 }),
  upperArm: 0.3,
  lowerArm: 0.27,
  thigh: 0.42,
  shin: 0.42,
  ankleY: 0.08,
  grip: [0, -0.06, 0],
  armShift: [0, 0, 0],
};

// ---- Mesh ----

interface Box {
  bone: string;
  mat: number;
  c: V3;
  h: V3;
}

const MAT_UNIFORM = 0;
const MAT_SKIN = 1;
const MAT_GEAR = 2;

/** Body boxes in bind-pose world space, each rigidly bound to one bone. */
function bodyBoxes(): Box[] {
  const b: Box[] = [
    { bone: NODES.head, mat: MAT_SKIN, c: [0, 1.665, 0.005], h: [0.1, 0.12, 0.11] },
    { bone: NODES.head, mat: MAT_GEAR, c: [0, 1.69, 0.11], h: [0.085, 0.022, 0.012] },
    { bone: 'Neck', mat: MAT_SKIN, c: [0, 1.55, 0], h: [0.05, 0.05, 0.05] },
    { bone: NODES.chest, mat: MAT_UNIFORM, c: [0, 1.29, 0], h: [0.2, 0.19, 0.12] },
    { bone: NODES.spine, mat: MAT_UNIFORM, c: [0, 1.0, 0], h: [0.165, 0.11, 0.11] },
    { bone: NODES.hips, mat: MAT_UNIFORM, c: [0, 0.86, 0], h: [0.175, 0.08, 0.115] },
    { bone: NODES.hips, mat: MAT_GEAR, c: [0, 0.92, 0], h: [0.18, 0.025, 0.12] },
  ];
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    b.push(
      { bone: `UpperArm_${side}`, mat: MAT_UNIFORM, c: [0.22 * s, 1.33, 0], h: [0.055, 0.15, 0.06] },
      { bone: `LowerArm_${side}`, mat: MAT_UNIFORM, c: [0.22 * s, 1.04, 0], h: [0.05, 0.135, 0.055] },
      { bone: `Hand_${side}`, mat: MAT_GEAR, c: [0.22 * s, 0.855, 0], h: [0.042, 0.05, 0.05] },
      { bone: `UpperLeg_${side}`, mat: MAT_UNIFORM, c: [0.1 * s, 0.71, 0], h: [0.085, 0.21, 0.095] },
      { bone: `LowerLeg_${side}`, mat: MAT_UNIFORM, c: [0.1 * s, 0.3, 0], h: [0.072, 0.2, 0.082] },
      { bone: `Foot_${side}`, mat: MAT_GEAR, c: [0.1 * s, 0.05, 0.04], h: [0.068, 0.05, 0.125] },
      { bone: `LowerLeg_${side}`, mat: MAT_GEAR, c: [0.1 * s, 0.47, 0.07], h: [0.06, 0.05, 0.03] },
    );
  }
  return b;
}

/** Positions, normals and indices for boxes (24 vertices each, flat shaded). */
function boxGeometry(boxes: { c: V3; h: V3 }[]) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const faces: [V3, V3, V3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const { c, h } of boxes) {
    for (const [n, u, v] of faces) {
      const base = pos.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        for (let k = 0; k < 3; k++) pos.push(c[k] + (n[k] + u[k] * su + v[k] * sv) * h[k]);
        nrm.push(...n);
      }
      // u × v = n, so (0,1,2) winds counter-clockwise seen from outside.
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { pos, nrm, idx };
}

// ---- Build ----

export function buildPlaceholderCharacter(): Uint8Array {
  const rig = new RiggedGlb(PLACEHOLDER_RIG);
  const { g, jointIndex } = rig;
  const j = g.json;
  j.materials.push(
    { name: MATERIALS.uniform, pbrMetallicRoughness: { baseColorFactor: [0.82, 0.82, 0.78, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
    { name: MATERIALS.skin, pbrMetallicRoughness: { baseColorFactor: [0.72, 0.55, 0.42, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
    { name: 'Gear', pbrMetallicRoughness: { baseColorFactor: [0.16, 0.17, 0.15, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
  );

  const gearMesh = (name: string, boxes: { c: V3; h: V3 }[]) => {
    const geo = boxGeometry(boxes);
    const mesh = j.meshes.push({
      name,
      primitives: [
        {
          attributes: { POSITION: g.accessor(new Float32Array(geo.pos), 'VEC3', { minMax: true, target: 'vertex' }), NORMAL: g.accessor(new Float32Array(geo.nrm), 'VEC3', { target: 'vertex' }) },
          indices: g.accessor(new Uint16Array(geo.idx), 'SCALAR', { target: 'index' }),
          material: MAT_GEAR,
        },
      ],
    }) - 1;
    return mesh;
  };
  // Gear hangs off bones as plain (unskinned) children, in the bone's space.
  rig.attach(NODES.head, { name: GEAR.helmet, mesh: gearMesh(GEAR.helmet, [{ c: [0, 0.195, 0], h: [0.118, 0.06, 0.128] }, { c: [0, 0.14, 0.02], h: [0.125, 0.012, 0.135] }]) });
  rig.attach(NODES.chest, {
    name: GEAR.vest,
    mesh: gearMesh(GEAR.vest, [
      { c: [0, -0.05, 0], h: [0.215, 0.18, 0.14] },
      { c: [-0.1, -0.12, 0.15], h: [0.05, 0.06, 0.025] },
      { c: [0, -0.12, 0.15], h: [0.04, 0.06, 0.025] },
      { c: [0.1, -0.12, 0.15], h: [0.05, 0.06, 0.025] },
    ]),
  });

  // Skinned body, one primitive per material.
  const boxes = bodyBoxes();
  const primitives = [];
  for (const mat of [MAT_UNIFORM, MAT_SKIN, MAT_GEAR]) {
    const mine = boxes.filter((b) => b.mat === mat);
    const geo = boxGeometry(mine);
    const jw = new Uint8Array((geo.pos.length / 3) * 4);
    const ww = new Float32Array((geo.pos.length / 3) * 4);
    mine.forEach((b, i) => {
      for (let v = 0; v < 24; v++) {
        jw[(i * 24 + v) * 4] = jointIndex.get(b.bone)!;
        ww[(i * 24 + v) * 4] = 1;
      }
    });
    primitives.push({
      attributes: {
        POSITION: g.accessor(new Float32Array(geo.pos), 'VEC3', { minMax: true, target: 'vertex' }),
        NORMAL: g.accessor(new Float32Array(geo.nrm), 'VEC3', { target: 'vertex' }),
        JOINTS_0: g.accessor(jw, 'VEC4', { target: 'vertex' }),
        WEIGHTS_0: g.accessor(ww, 'VEC4', { target: 'vertex' }),
      },
      indices: g.accessor(new Uint16Array(geo.idx), 'SCALAR', { target: 'index' }),
      material: mat,
    });
  }
  rig.skinned('Body', j.meshes.push({ name: 'Body', primitives }) - 1);
  return rig.finish();
}

/** Clip names the placeholder provides (for tests). */
export const PLACEHOLDER_CLIPS = GENERATED_CLIPS;
/** Spec clips it deliberately leaves out, so the game's fallbacks get exercised. */
export const PLACEHOLDER_MISSING = CLIPS.filter((c) => !PLACEHOLDER_CLIPS.includes(c.name)).map((c) => c.name);
