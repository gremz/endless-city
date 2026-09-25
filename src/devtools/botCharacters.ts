import { GEAR, NODES } from '../render/characters/characterSpec';
import type { V3 } from './characterRig';
import { readGlbTriangles } from './glbReader';
import { buildStaticCharacter, type Target } from './staticCharacter';
import { SWAT_RIG } from './swatCharacter';

/**
 * The bot characters: the gang members and terrorists from art/characters/bots (made by
 * characters.py in Blender, static T-posed meshes built like the SWAT) put on the shared rig with
 * its clips. Written to public/models/characters/bots/ by `npm run models:bots`.
 *
 * characters.py uses the SWAT's joint positions, so the bots share its rig. A plate carrier (and
 * its pouches) becomes the Vest gear, hidden while the bot has no armour; chest rigs stay on.
 */

const SHOULDER = { x: 0.21, y: 1.385 };
const SPINE_SPLIT = 1.15;
/** Blender numbers repeated material names across a file ("Top.003"). */
const baseName = (mat: string) => mat.replace(/\.\d+$/, '');

/** Which bone (or gear piece) a part belongs to, from its material and centre. */
function classifier(hasCarrier: boolean) {
  return (material: string, c: V3): Target => {
    const mat = baseName(material);
    const side = c[0] >= 0 ? 'L' : 'R';
    const s = c[0] >= 0 ? 1 : -1;
    const ax = Math.abs(c[0]);
    if (mat === 'Carrier' || (mat === 'Pouch' && hasCarrier)) return { kind: 'gear', gear: GEAR.vest, bone: NODES.chest };
    if (ax >= 0.2 && c[1] > 1.3 && c[1] < 1.5) {
      // Tracksuit stripes run the arm's whole length and bend with the elbow.
      if (mat === 'Stripe') return { kind: 'arm', arm: s };
      const bone = ax < 0.495 ? 'UpperArm' : ax < 0.775 ? 'LowerArm' : 'Hand';
      return { kind: 'bone', bone: `${bone}_${side}`, arm: s };
    }
    if (c[1] > 1.5) return { kind: 'bone', bone: NODES.head };
    // Neck and bandana neck (collars and hoods sit lower, on the chest).
    if (ax < 0.07 && c[1] > 1.445) return { kind: 'bone', bone: 'Neck' };
    if (c[1] > 0.95) return { kind: 'torso' };
    // Pelvis, belt and the coat's skirt.
    if (c[1] > 0.8 || (ax < 0.06 && c[1] > 0.55)) return { kind: 'bone', bone: NODES.hips };
    if (c[1] > 0.55) return { kind: 'bone', bone: `UpperLeg_${side}` };
    if (c[1] > 0.1) return { kind: 'bone', bone: `LowerLeg_${side}` };
    return { kind: 'bone', bone: `Foot_${side}` };
  };
}

export function buildBotCharacter(src: Uint8Array, name: string): Uint8Array {
  const hasCarrier = readGlbTriangles(src).primitives.some((p) => baseName(p.material.name) === 'Carrier');
  return buildStaticCharacter(src, { rig: SWAT_RIG, shoulder: SHOULDER, spineSplit: SPINE_SPLIT, classify: classifier(hasCarrier), generator: 'owcs bot character', material: name });
}
