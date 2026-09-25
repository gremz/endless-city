import { GEAR, NODES } from '../render/characters/characterSpec';
import { humanoidBones, type RigDims, type V3 } from './characterRig';
import { buildStaticCharacter, type Target } from './staticCharacter';

/**
 * The player character: the SWAT officer from art/characters/swat.glb (made by swat.py in
 * Blender, a static T-posed mesh) put on the shared generated rig with its clips. Written to
 * public/models/characters/player.glb by `npm run models:player`.
 *
 * See staticCharacter.ts for how the parts are bound; helmet and vest parts become the spec's
 * gear objects. Players keep the navy uniform (no `Uniform` material, so no team tint).
 */

/** Joint positions read off swat.py (its Blender Z is glTF Y). */
export const SWAT_RIG: RigDims = {
  bones: humanoidBones({ hips: 0.95, spine: 1.05, chest: 1.25, neck: 1.42, head: 1.53, shoulder: [0.21, 1.385, 0], elbowY: 1.095, wristY: 0.835, hip: [0.105, 0.92, 0], kneeY: 0.52, ankleY: 0.2 }),
  upperArm: 0.29,
  lowerArm: 0.26,
  thigh: 0.4,
  shin: 0.32,
  ankleY: 0.2,
  grip: [0, -0.08, 0],
  // Its shoulders sit 3.5 cm lower above the chest bone than the placeholder's.
  armShift: [0, -0.035, 0],
};

/** T-pose shoulder pivot (|x|, y) the arms swing down around. */
const SHOULDER = { x: 0.21, y: 1.385 };
const SPINE_SPLIT = 1.15;

/** Which bone (or gear piece) a part belongs to, from its material and centre. */
function classify(mat: string, c: V3): Target {
  const side = c[0] >= 0 ? 'L' : 'R';
  const s = c[0] >= 0 ? 1 : -1;
  const ax = Math.abs(c[0]);
  if ((mat === 'Helmet' || mat === 'Pads') && c[1] > 1.62) return { kind: 'gear', gear: GEAR.helmet, bone: NODES.head };
  if (mat === 'Vest' || mat === 'Label' || (mat === 'Pouch' && c[1] > 1.0)) return { kind: 'gear', gear: GEAR.vest, bone: NODES.chest };
  if (ax >= 0.2 && c[1] > 1.3 && c[1] < 1.5) {
    const bone = ax < 0.495 ? 'UpperArm' : ax < 0.775 ? 'LowerArm' : 'Hand';
    return { kind: 'bone', bone: `${bone}_${side}`, arm: s };
  }
  if (c[1] > 1.5) return { kind: 'bone', bone: NODES.head };
  if (mat === 'Balaclava') return { kind: 'bone', bone: 'Neck' };
  if (c[1] > 0.95) return { kind: 'torso' };
  if (c[1] > 0.8) return { kind: 'bone', bone: NODES.hips };
  if (c[1] > 0.55) return { kind: 'bone', bone: `UpperLeg_${side}` };
  if (c[1] > 0.1) return { kind: 'bone', bone: `LowerLeg_${side}` };
  return { kind: 'bone', bone: `Foot_${side}` };
}

export function buildSwatCharacter(src: Uint8Array): Uint8Array {
  return buildStaticCharacter(src, { rig: SWAT_RIG, shoulder: SHOULDER, spineSplit: SPINE_SPLIT, classify, generator: 'owcs swat character', material: 'SWAT' });
}
