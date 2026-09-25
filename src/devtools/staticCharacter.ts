import { NODES } from '../render/characters/characterSpec';
import { RiggedGlb, sub, type RigDims, type V3 } from './characterRig';
import { readGlbTriangles } from './glbReader';

/**
 * Puts a static, T-posed character from art/characters (built in Blender from rigid parts:
 * boxes, tapered cylinders, blobs) on the shared generated rig with its clips. Used for the SWAT
 * player and the gang/terrorist bots.
 *
 * Each part is found as a connected island and bound whole to one bone (or split between Spine
 * and Chest for the torso); the arms are swung down from the T-pose into the rig's arms-hanging
 * bind pose. Gear parts become separate rigid nodes under a bone. All original colours are kept
 * as vertex colours on a single material (one draw call); there is no `Uniform` material, so the
 * characters keep their own colours instead of a team tint.
 */

/**
 * - `bone`: the whole part on one bone (`arm` swings it down with that arm, 1 left, -1 right).
 * - `torso`: split per vertex between Spine and Chest.
 * - `arm`: a part running along the T-posed arm (a sleeve stripe), split per vertex between
 *   UpperArm, LowerArm and Hand at `elbowX` and `wristX`, so it bends with the elbow.
 * - `gear`: a rigid node under `bone`, named `gear`.
 */
export type Target =
  | { kind: 'bone'; bone: string; arm?: 1 | -1 }
  | { kind: 'torso' }
  | { kind: 'arm'; arm: 1 | -1 }
  | { kind: 'gear'; gear: string; bone: string };

export interface StaticCharacterDef {
  rig: RigDims;
  /** T-pose shoulder pivot (|x|, y) the arms swing down around. */
  shoulder: { x: number; y: number };
  /** Torso vertices below this height go to Spine, the rest to Chest. */
  spineSplit: number;
  /** T-pose |x| where `arm` parts switch from UpperArm to LowerArm, and LowerArm to Hand. */
  elbowX?: number;
  wristX?: number;
  /** Which bone (or gear piece) a part belongs to, from its material name and centre. */
  classify: (mat: string, centre: V3) => Target;
  generator: string;
  material: string;
}

/**
 * Split a primitive's triangles into parts. Triangles are joined across an edge only when
 * exactly two triangles share it, so parts that happen to touch (a thigh's end cap on the shin's
 * start cap) stay apart.
 */
function islands(pos: Float32Array, idx: Uint32Array): number[] {
  const tris = idx.length / 3;
  const key = (v: number) => `${Math.round(pos[v * 3] * 1e4)},${Math.round(pos[v * 3 + 1] * 1e4)},${Math.round(pos[v * 3 + 2] * 1e4)}`;
  const edges = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    for (let e = 0; e < 3; e++) {
      const a = key(idx[t * 3 + e]);
      const b = key(idx[t * 3 + ((e + 1) % 3)]);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      let list = edges.get(k);
      if (!list) edges.set(k, (list = []));
      list.push(t);
    }
  }
  const parent = Array.from({ length: tris }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const list of edges.values()) if (list.length === 2) parent[find(list[0])] = find(list[1]);
  return Array.from({ length: tris }, (_, i) => find(i));
}

interface Out {
  pos: number[];
  nrm: number[];
  col: number[];
  joint: number[];
}
const newOut = (): Out => ({ pos: [], nrm: [], col: [], joint: [] });

export function buildStaticCharacter(src: Uint8Array, def: StaticCharacterDef): Uint8Array {
  const { shoulder } = def;
  const rig = new RiggedGlb(def.rig);
  const { g, jointIndex } = rig;
  const j = g.json;
  j.asset.generator = def.generator;
  j.materials.push({ name: def.material, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 } });

  const body = newOut();
  const gear = new Map<string, { bone: string; out: Out }>();

  for (const prim of readGlbTriangles(src).primitives) {
    const { positions: pos, normals: nrm, indices: idx } = prim;
    const part = islands(pos, idx);
    // Part centres (mean of triangle corners).
    const sum = new Map<number, [number, number, number, number]>();
    for (let t = 0; t < idx.length / 3; t++) {
      const acc = sum.get(part[t]) ?? [0, 0, 0, 0];
      for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) acc[k] += pos[idx[t * 3 + c] * 3 + k];
      acc[3] += 3;
      sum.set(part[t], acc);
    }
    const targets = new Map<number, Target>();
    for (const [id, a] of sum) targets.set(id, def.classify(prim.material.name, [a[0] / a[3], a[1] / a[3], a[2] / a[3]]));

    // Every triangle gets its own three vertices, so each part can be moved and bound on its own.
    for (let t = 0; t < idx.length / 3; t++) {
      const target = targets.get(part[t])!;
      let out = body;
      let origin: V3 = [0, 0, 0];
      if (target.kind === 'gear') {
        let entry = gear.get(target.gear);
        if (!entry) gear.set(target.gear, (entry = { bone: target.bone, out: newOut() }));
        out = entry.out;
        origin = rig.at(target.bone);
      }
      for (let c = 0; c < 3; c++) {
        const v = idx[t * 3 + c];
        let p: V3 = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
        let n: V3 = nrm ? [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]] : [0, 1, 0];
        let bone = target.kind === 'bone' ? target.bone : '';
        if (target.kind === 'arm') {
          const ax = Math.abs(p[0]);
          const side = target.arm > 0 ? 'L' : 'R';
          bone = `${ax < (def.elbowX ?? 0.5) ? 'UpperArm' : ax < (def.wristX ?? 0.775) ? 'LowerArm' : 'Hand'}_${side}`;
        }
        if ((target.kind === 'bone' || target.kind === 'arm') && target.arm) {
          // Swing the arm down: along the arm becomes down, up becomes outwards.
          const s = target.arm;
          const dx = p[0] - shoulder.x * s;
          const dy = p[1] - shoulder.y;
          p = [shoulder.x * s + s * dy, shoulder.y - s * dx, p[2]];
          n = [s * n[1], -s * n[0], n[2]];
        }
        out.pos.push(...sub(p, origin));
        out.nrm.push(...n);
        out.col.push(...prim.material.color);
        if (target.kind !== 'gear') {
          if (target.kind === 'torso') bone = p[1] < def.spineSplit ? NODES.spine : NODES.chest;
          out.joint.push(jointIndex.get(bone)!);
        }
      }
    }
  }

  const attributes = (o: Out) => ({
    POSITION: g.accessor(new Float32Array(o.pos), 'VEC3', { minMax: true, target: 'vertex' }),
    NORMAL: g.accessor(new Float32Array(o.nrm), 'VEC3', { target: 'vertex' }),
    COLOR_0: g.accessor(new Float32Array(o.col), 'VEC3', { target: 'vertex' }),
  });
  const indices = (o: Out) => g.accessor(Uint16Array.from({ length: o.pos.length / 3 }, (_, i) => i), 'SCALAR', { target: 'index' });

  for (const [name, { bone, out }] of gear) {
    const mesh = j.meshes.push({ name, primitives: [{ attributes: attributes(out), indices: indices(out), material: 0 }] }) - 1;
    rig.attach(bone, { name, mesh });
  }

  const count = body.pos.length / 3;
  const jw = new Uint8Array(count * 4);
  const ww = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    jw[i * 4] = body.joint[i];
    ww[i * 4] = 1;
  }
  const primitive = {
    attributes: { ...attributes(body), JOINTS_0: g.accessor(jw, 'VEC4', { target: 'vertex' }), WEIGHTS_0: g.accessor(ww, 'VEC4', { target: 'vertex' }) },
    indices: indices(body),
    material: 0,
  };
  rig.skinned('Body', j.meshes.push({ name: 'Body', primitives: [primitive] }) - 1);
  return rig.finish();
}
