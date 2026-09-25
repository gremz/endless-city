import { BUDGET, CLIPS, GEAR, MATERIALS, NODES, OPTIONAL_NODES, REQUIRED_NODES } from './characterSpec';

/**
 * Reads a .glb's JSON (no three.js, no decoding of the binary chunk) and checks it against the
 * character spec. Used by `npm run models:check` and the tests.
 */

interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
}
interface GltfAccessor {
  count: number;
  min?: number[];
  max?: number[];
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}
export interface GltfJson {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  materials?: { name?: string }[];
  skins?: { joints: number[]; skeleton?: number }[];
  accessors?: GltfAccessor[];
  animations?: { name?: string; channels: { sampler: number; target: { node?: number; path: string } }[]; samplers: { input: number; output: number }[] }[];
  images?: unknown[];
}

export interface CharacterReport {
  errors: string[];
  warnings: string[];
  stats: {
    bytes: number;
    triangles: number;
    materials: string[];
    bones: number;
    height: number;
    minY: number;
    clips: { name: string; duration: number }[];
  };
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/** Pull the JSON chunk out of a .glb. */
export function readGlbJson(bytes: Uint8Array): GltfJson {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a .glb file (export as glTF Binary)');
  if (view.getUint32(4, true) !== 2) throw new Error(`glTF version ${view.getUint32(4, true)}, expected 2`);
  const len = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('first chunk is not JSON');
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as GltfJson;
}

type Mat = number[];
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major local matrix of a node. */
function localMatrix(n: GltfNode): Mat {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mul(a: Mat, b: Mat): Mat {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

export function inspectCharacter(bytes: Uint8Array): CharacterReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: CharacterReport['stats'] = { bytes: bytes.byteLength, triangles: 0, materials: [], bones: 0, height: 0, minY: 0, clips: [] };
  let json: GltfJson;
  try {
    json = readGlbJson(bytes);
  } catch (e) {
    errors.push((e as Error).message);
    return { errors, warnings, stats };
  }
  const nodes = json.nodes ?? [];
  const accessors = json.accessors ?? [];

  // World matrices of the default scene, and which nodes are in it.
  const world = new Map<number, Mat>();
  const parent = new Map<number, number>();
  const walk = (i: number, m: Mat) => {
    const w = mul(m, localMatrix(nodes[i]));
    world.set(i, w);
    for (const c of nodes[i].children ?? []) {
      parent.set(c, i);
      walk(c, w);
    }
  };
  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) walk(root, IDENTITY);

  // Names.
  const byName = new Map<string, number>();
  for (const [i, n] of nodes.entries()) {
    if (!n.name) continue;
    if (n.name.includes('.')) warnings.push(`node "${n.name}" has a dot in its name; three.js strips dots, use underscores`);
    byName.set(n.name, i);
  }
  for (const name of REQUIRED_NODES) if (!byName.has(name)) errors.push(`missing required node "${name}"`);
  for (const name of OPTIONAL_NODES) if (!byName.has(name)) warnings.push(`optional node "${name}" not found`);
  const isUnder = (i: number, ancestor: number) => {
    for (let p = parent.get(i); p !== undefined; p = parent.get(p)) if (p === ancestor) return true;
    return false;
  };
  const spine = byName.get(NODES.spine);
  const head = byName.get(NODES.head);
  const socket = byName.get(NODES.weapon);
  if (spine !== undefined && head !== undefined && !isUnder(head, spine)) errors.push(`"${NODES.head}" must be a descendant of "${NODES.spine}"`);
  if (spine !== undefined && socket !== undefined && !isUnder(socket, spine)) errors.push(`"${NODES.weapon}" must be under the arm, below "${NODES.spine}"`);

  // Skin.
  const skins = json.skins ?? [];
  if (!skins.length) errors.push('no skin: parent the mesh to the armature with automatic weights');
  const joints = new Set(skins.flatMap((s) => s.joints));
  stats.bones = joints.size;
  if (stats.bones > BUDGET.bones) warnings.push(`${stats.bones} bones (budget ${BUDGET.bones})`);
  for (const name of [NODES.hips, NODES.spine, NODES.head]) {
    const i = byName.get(name);
    if (i !== undefined && skins.length && !joints.has(i)) errors.push(`"${name}" is not a bone of the skin`);
  }

  // Meshes: triangles, materials, bind-pose bounds.
  const usedMaterials = new Set<number>();
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [i, n] of nodes.entries()) {
    if (n.mesh === undefined || !world.has(i)) continue;
    const mesh = json.meshes?.[n.mesh];
    for (const p of mesh?.primitives ?? []) {
      const mode = p.mode ?? 4;
      if (mode !== 4) continue;
      const count = p.indices !== undefined ? accessors[p.indices]?.count : accessors[p.attributes.POSITION]?.count;
      stats.triangles += Math.floor((count ?? 0) / 3);
      if (p.material !== undefined) usedMaterials.add(p.material);
      const pos = accessors[p.attributes.POSITION];
      if (!pos?.min || !pos.max) continue;
      // Skinned vertices are in bind space (the node transform is ignored); others use the node's.
      const m = n.skin !== undefined ? IDENTITY : world.get(i)!;
      for (const x of [pos.min[0], pos.max[0]]) for (const y of [pos.min[1], pos.max[1]]) for (const z of [pos.min[2], pos.max[2]]) {
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy);
      }
    }
  }
  stats.materials = [...usedMaterials].map((m) => json.materials?.[m]?.name ?? `#${m}`);
  if (stats.triangles === 0) errors.push('no triangles found');
  if (stats.triangles > BUDGET.triangles) warnings.push(`${stats.triangles} triangles (budget ${BUDGET.triangles})`);
  if (stats.materials.length > BUDGET.materials) warnings.push(`${stats.materials.length} materials (budget ${BUDGET.materials}); each is a draw call per character`);
  if (!stats.materials.includes(MATERIALS.uniform)) warnings.push(`no "${MATERIALS.uniform}" material: characters won't be tinted per team`);
  if (Number.isFinite(minY)) {
    stats.minY = minY;
    stats.height = maxY - minY;
    if (Math.abs(minY) > 0.05) warnings.push(`feet at y=${minY.toFixed(2)}; put the feet on the origin`);
    if (stats.height < BUDGET.minHeight || stats.height > BUDGET.maxHeight) {
      warnings.push(`bind-pose height ${stats.height.toFixed(2)} m, expected ${BUDGET.minHeight}-${BUDGET.maxHeight} (1 unit = 1 m, transforms applied?)`);
    }
  }
  for (const gear of [GEAR.helmet, GEAR.vest]) if (!byName.has(gear)) warnings.push(`optional gear "${gear}" not found`);
  if (bytes.byteLength > BUDGET.bytes) warnings.push(`${(bytes.byteLength / 1048576).toFixed(1)} MB (budget ${BUDGET.bytes / 1048576} MB)`);

  // Clips.
  for (const a of json.animations ?? []) {
    let duration = 0;
    for (const s of a.samplers) duration = Math.max(duration, accessors[s.input]?.max?.[0] ?? 0);
    stats.clips.push({ name: a.name ?? '(unnamed)', duration });
  }
  const have = new Map(stats.clips.map((c) => [c.name, c.duration]));
  for (const c of CLIPS) {
    const d = have.get(c.name);
    if (d === undefined) (c.required ? errors : warnings).push(`${c.required ? 'missing required' : 'optional'} clip "${c.name}"${c.required ? '' : ' not found'}`);
    else if (d <= 0) errors.push(`clip "${c.name}" has no length`);
  }
  const known = new Set(CLIPS.map((c) => c.name));
  for (const c of stats.clips) if (!known.has(c.name)) warnings.push(`clip "${c.name}" isn't used by the game (typo?)`);
  // Root motion: a translating Hips in a loop drifts; Death and Jump may move.
  const hips = byName.get(NODES.hips);
  for (const a of json.animations ?? []) {
    const spec = CLIPS.find((c) => c.name === a.name);
    if (spec?.kind !== 'loco' && a.name !== 'Idle') continue;
    for (const ch of a.channels) {
      if (ch.target.node !== hips || ch.target.path !== 'translation') continue;
      const acc = accessors[a.samplers[ch.sampler].output];
      if (acc?.min && acc.max) {
        const dx = acc.max[0] - acc.min[0];
        const dz = acc.max[2] - acc.min[2];
        if (Math.max(dx, dz) > 0.3) warnings.push(`clip "${a.name}" moves Hips ${Math.max(dx, dz).toFixed(2)} m sideways: make cycles in place`);
      }
    }
  }
  return { errors, warnings, stats };
}

/** Human-readable report for the CLI. */
export function formatReport(file: string, r: CharacterReport): string {
  const s = r.stats;
  const lines = [
    `${file}`,
    `  ${(s.bytes / 1024).toFixed(0)} KB, ${s.triangles} triangles, ${s.bones} bones, materials: ${s.materials.join(', ') || 'none'}`,
    `  height ${s.height.toFixed(2)} m (feet at ${s.minY.toFixed(2)})`,
    `  clips: ${s.clips.map((c) => `${c.name} ${c.duration.toFixed(2)}s`).join(', ') || 'none'}`,
  ];
  for (const e of r.errors) lines.push(`  ✗ ${e}`);
  for (const w of r.warnings) lines.push(`  ! ${w}`);
  lines.push(r.errors.length ? `  FAILED (${r.errors.length} error${r.errors.length > 1 ? 's' : ''})` : '  OK');
  return lines.join('\n');
}
