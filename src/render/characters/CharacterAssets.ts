import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { CLIPS, MATERIALS, NODES, REQUIRED_NODES, UNIFORM_TINT, type LookId } from './characterSpec';

const LOOK_IDS = Object.keys(UNIFORM_TINT) as LookId[];

/** A loaded, validated character ready to be cloned per actor. */
export interface CharacterAsset {
  /** Facing -Z like everything else in the game (the glTF faces +Z). */
  template: THREE.Group;
  /** Base clips as exported; overlays trimmed to the upper body and made additive. */
  clips: Map<string, THREE.AnimationClip>;
  /** Every clip exactly as exported (for previewing). */
  sourceClips: Map<string, THREE.AnimationClip>;
  /** Clip durations, for choosePose. */
  durations: Map<string, number>;
  /** Material to use per look, keyed by the template material's uuid. */
  looks: Map<string, Record<LookId, THREE.Material>>;
  dispose(): void;
}

/** Load a character .glb and check it against the spec (rejects with the reasons). */
export async function loadCharacterAsset(url: string): Promise<CharacterAsset> {
  const res = await fetch(url);
  // Vite's dev server answers a missing file with the index page.
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) throw new Error('file not found');
  const gltf = await new GLTFLoader().parseAsync(await res.arrayBuffer(), THREE.LoaderUtils.extractUrlBase(url));
  return prepareCharacter(gltf);
}

/** Swap glTF's PBR materials for Lambert (what the rest of the game uses) and build the tints. */
function toLambert(m: THREE.Material): THREE.MeshLambertMaterial {
  const src = m as THREE.MeshStandardMaterial;
  const out = new THREE.MeshLambertMaterial({
    name: src.name,
    color: src.color ?? new THREE.Color('#ffffff'),
    map: src.map ?? null,
    vertexColors: src.vertexColors,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    side: src.side,
  });
  if (src.emissive && src.emissiveIntensity > 0 && src.emissive.getHex() !== 0) {
    out.emissive.copy(src.emissive);
    out.emissiveMap = src.emissiveMap ?? null;
  }
  return out;
}

export function prepareCharacter(gltf: GLTF): CharacterAsset {
  const problems: string[] = [];
  const scene = gltf.scene;
  for (const name of REQUIRED_NODES) if (!scene.getObjectByName(name)) problems.push(`missing node "${name}"`);
  const byName = new Map(gltf.animations.map((c) => [c.name, c]));
  for (const c of CLIPS) if (c.required && !byName.has(c.name)) problems.push(`missing clip "${c.name}"`);
  let skinned = false;
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  if (!skinned) problems.push('no skinned mesh');
  if (problems.length) throw new Error(`character model doesn't match the spec: ${problems.join('; ')}`);

  // Upper body: Spine and everything under it.
  const upper = new Set<string>();
  scene.getObjectByName(NODES.spine)!.traverse((o) => upper.add(o.name));

  const clips = new Map<string, THREE.AnimationClip>();
  const durations = new Map<string, number>();
  for (const spec of CLIPS) {
    const clip = byName.get(spec.name);
    if (!clip) continue;
    if (spec.kind === 'overlay' || spec.kind === 'hold') {
      const c = clip.clone();
      c.tracks = c.tracks.filter((t) => upper.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName));
      // Overlays are measured against their own first frame, holds against the idle rifle hold.
      THREE.AnimationUtils.makeClipAdditive(c, 0, spec.kind === 'hold' ? byName.get('Idle')! : c);
      clips.set(spec.name, c);
    } else {
      clips.set(spec.name, clip);
    }
    durations.set(spec.name, clip.duration);
  }

  // Materials: one Lambert per original, and a tinted copy of Uniform per look.
  const looks = new Map<string, Record<LookId, THREE.Material>>();
  const converted = new Map<string, THREE.Material>();
  const owned: THREE.Material[] = [];
  const convert = (m: THREE.Material): THREE.Material => {
    let base = converted.get(m.uuid);
    if (base) return base;
    const lambert = toLambert(m);
    base = lambert;
    owned.push(lambert);
    const perLook = {} as Record<LookId, THREE.Material>;
    for (const look of LOOK_IDS) {
      if (m.name === MATERIALS.uniform) {
        const tinted = lambert.clone();
        tinted.color.multiply(new THREE.Color(UNIFORM_TINT[look]));
        owned.push(tinted);
        perLook[look] = tinted;
      } else {
        perLook[look] = lambert;
      }
    }
    looks.set(lambert.uuid, perLook);
    converted.set(m.uuid, lambert);
    m.dispose();
    return lambert;
  };
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    // Skinned bounds come from the bind pose; the renderer culls per character instead.
    mesh.frustumCulled = false;
  });

  const template = new THREE.Group();
  template.name = 'character';
  scene.rotation.y = Math.PI;
  template.add(scene);

  return {
    template,
    clips,
    sourceClips: byName,
    durations,
    looks,
    dispose() {
      const textures = new Set<THREE.Texture>();
      for (const m of owned) {
        const l = m as THREE.MeshLambertMaterial;
        if (l.map) textures.add(l.map);
        if (l.emissiveMap) textures.add(l.emissiveMap);
        m.dispose();
      }
      for (const t of textures) t.dispose();
      template.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    },
  };
}
