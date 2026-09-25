import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { STAND_BOXES } from '../../ai/hitboxes';
import { buildPlaceholderCharacter, PLACEHOLDER_CLIPS, PLACEHOLDER_MISSING } from '../../devtools/placeholderCharacter';
import { hitboxReferenceObj } from '../../devtools/hitboxReference';
import { makeActor, Team, type Actor } from '../../sim/Actor';
import { makeItem } from '../../weapons/Inventory';
import { getGunModel } from '../viewmodel/gunMeshes';
import { prepareCharacter, type CharacterAsset } from './CharacterAssets';
import { CharacterRenderer } from './CharacterRenderer';
import { CHARACTER_FILE, characterUrl, CLIP_BY_NAME, CLIPS, PLACEHOLDER_FILE, UNIFORM_TINT } from './characterSpec';
import { inspectCharacter, readGlbJson } from './glbInspect';

const placeholder = buildPlaceholderCharacter();

/** The committed model files, read through Vite (the project has no Node types). */
const MODELS = import.meta.glob<string>('/public/models/characters/*.glb', { query: '?inline', import: 'default', eager: true });
function modelFile(file: string): Uint8Array | null {
  const url = MODELS[`/public/${file}`];
  if (!url) return null;
  const bin = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Rebuild a .glb from edited JSON and the original binary chunk. */
function repack(glb: Uint8Array, edit: (json: ReturnType<typeof readGlbJson>) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = view.getUint32(12, true);
  const bin = glb.subarray(20 + jsonLen);
  const json = readGlbJson(glb);
  edit(json);
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(20 + text.length + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.set(bin, 20 + text.length);
  return out;
}

async function loadAsset(bytes: Uint8Array): Promise<CharacterAsset> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return prepareCharacter(await new GLTFLoader().parseAsync(buf, ''));
}

describe('character spec', () => {
  it('maps ?charmodel= to a file', () => {
    expect(characterUrl(null, '/')).toBe(`/${CHARACTER_FILE}`);
    expect(characterUrl('placeholder', '/game/')).toBe(`/game/${PLACEHOLDER_FILE}`);
    expect(characterUrl('none', '/')).toBeNull();
    expect(characterUrl('/x/y.glb', '/game/')).toBe('/x/y.glb');
    expect(characterUrl('models/mine.glb', '/')).toBe('/models/mine.glb');
  });

  it('gives every locomotion clip an authored speed', () => {
    for (const c of CLIPS) expect(c.kind === 'loco', c.name).toBe(c.speed !== undefined);
  });

  it('writes a hitbox reference matching the real hitboxes', () => {
    const obj = hitboxReferenceObj();
    for (const name of ['Hitbox_Head', 'Hitbox_Chest', 'Hitbox_Stomach', 'Hitbox_Legs', 'Collision_Standing', 'Forward']) expect(obj).toContain(`o ${name}`);
    const head = STAND_BOXES[0];
    expect(obj).toContain(`v ${head.hx.toFixed(4)} ${(head.cy + head.hy).toFixed(4)} ${head.hz.toFixed(4)}`);
  });
});

describe('glb inspection', () => {
  it('accepts the placeholder', () => {
    const r = inspectCharacter(placeholder);
    expect(r.errors).toEqual([]);
    expect(r.stats.clips.map((c) => c.name)).toEqual(PLACEHOLDER_CLIPS);
    expect(r.stats.height).toBeGreaterThan(1.75);
    expect(r.stats.height).toBeLessThan(1.9);
    expect(Math.abs(r.stats.minY)).toBeLessThan(0.01);
    // Only optional clips are left out.
    for (const name of PLACEHOLDER_MISSING) expect(CLIP_BY_NAME.get(name)!.required).toBe(false);
  });

  it('keeps the committed placeholder in sync with its generator', () => {
    const committed = modelFile(PLACEHOLDER_FILE);
    expect(committed, `public/${PLACEHOLDER_FILE} missing: run npm run models:placeholder`).not.toBeNull();
    expect(committed!.length === placeholder.length && committed!.every((b, i) => b === placeholder[i]), 'stale: run npm run models:placeholder').toBe(true);
  });

  it('reports missing clips, missing bones and dotted names', () => {
    const broken = repack(placeholder, (json) => {
      json.animations = json.animations!.filter((a) => a.name !== 'Death');
      for (const n of json.nodes!) if (n.name === 'Spine') n.name = 'Spine.001';
    });
    const r = inspectCharacter(broken);
    expect(r.errors.some((e) => e.includes('"Death"'))).toBe(true);
    expect(r.errors.some((e) => e.includes('"Spine"'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('dot'))).toBe(true);
  });

  it('rejects files that are not binary glTF', () => {
    expect(inspectCharacter(new TextEncoder().encode('{"asset":{}}')).errors[0]).toMatch(/not a \.glb/);
  });

  it('checks the real soldier when it exists', () => {
    const soldier = modelFile(CHARACTER_FILE);
    if (!soldier) return;
    expect(inspectCharacter(soldier).errors).toEqual([]);
  });
});

describe('CharacterRenderer (placeholder model, headless)', () => {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  camera.position.set(0, 1.6, 4);

  function actor(id = 1): Actor {
    const a = makeActor(id, 'bot', Team.Bots, 0, 0, 0);
    a.move.onGround = true;
    a.inv.primary = makeItem('ak47');
    a.inv.active = 'primary';
    return a;
  }

  /** Run a few frames and return the scene-graph after the last. */
  function run(r: CharacterRenderer, a: Actor, frames = 10, time = 5): THREE.Group {
    for (let i = 0; i < frames; i++) r.update([a], -1, 1, time, 1 / 60);
    r.root.updateMatrixWorld(true);
    return r.root;
  }
  const world = (root: THREE.Object3D, name: string) => root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());

  it('loads the placeholder as an asset', async () => {
    const asset = await loadAsset(placeholder);
    expect([...asset.clips.keys()].sort()).toEqual([...PLACEHOLDER_CLIPS].sort());
    expect(asset.clips.get('Shoot')!.blendMode).toBe(THREE.AdditiveAnimationBlendMode);
    // Overlays keep only upper-body tracks.
    for (const t of asset.clips.get('Reload')!.tracks) expect(t.name).not.toMatch(/Leg|Foot|Hips/);
  });

  it('refuses a model missing required clips', async () => {
    const broken = repack(placeholder, (json) => {
      json.animations = json.animations!.filter((a) => a.name !== 'Walk');
    });
    await expect(loadAsset(broken)).rejects.toThrow(/Walk/);
  });

  it('holds the gun in the right hand, pointing where the actor faces', async () => {
    const r = new CharacterRenderer([{ asset: await loadAsset(placeholder) }], camera, false);
    const a = actor();
    const root = run(r, a);
    const socket = world(root, 'Socket_Weapon');
    expect(socket.z).toBeLessThan(-0.15); // in front (yaw 0 faces -Z)
    expect(socket.x).toBeGreaterThan(0.02); // right side is +X
    expect(socket.y).toBeGreaterThan(1.3); // shouldered
    expect(socket.y).toBeLessThan(1.65);
    const gun = root.getObjectByName('Socket_Weapon')!.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(gun.visible).toBe(true);
    expect(gun.geometry).toBe(getGunModel('ak47').geometry);
    const barrel = new THREE.Vector3(0, 0, -1).transformDirection(gun.matrixWorld);
    expect(barrel.z).toBeLessThan(-0.9);

    a.yaw = a.prevYaw = Math.PI / 2; // now facing -X
    run(r, a);
    expect(world(root, 'Socket_Weapon').x).toBeLessThan(-0.15);
    r.dispose();
  });

  it('bends the aim up and down with pitch', async () => {
    const r = new CharacterRenderer([{ asset: await loadAsset(placeholder) }], camera, false);
    const a = actor();
    const level = world(run(r, a), 'Socket_Torch').y;
    a.pitch = 0.8;
    const up = world(run(r, a), 'Socket_Torch').y;
    a.pitch = -0.8;
    const down = world(run(r, a), 'Socket_Torch').y;
    expect(up).toBeGreaterThan(level + 0.15);
    expect(down).toBeLessThan(level - 0.15);
    r.dispose();
  });

  it('crouches, dies and sinks', async () => {
    const r = new CharacterRenderer([{ asset: await loadAsset(placeholder) }], camera, false);
    const a = actor();
    const standing = world(run(r, a), 'Head').y;
    a.move.duckAmount = 1;
    const crouched = world(run(r, a, 30), 'Head').y;
    expect(standing).toBeGreaterThan(1.45);
    expect(crouched).toBeLessThan(1.25);
    a.move.duckAmount = 0;
    a.alive = false;
    a.diedAt = 3;
    expect(world(run(r, a, 30, 5), 'Head').y).toBeLessThan(0.45);
    // Dead bodies that dropped their guns hold nothing.
    a.inv.primary = null;
    a.inv.secondary = null;
    const root = run(r, a, 2, 5);
    expect(root.getObjectByName('Socket_Weapon')!.children.some((c) => (c as THREE.Mesh).isMesh && c.visible)).toBe(false);
    // Gone after 12 s.
    run(r, a, 1, 16);
    expect(root.getObjectByName('Socket_Weapon')).toBeUndefined();
    r.dispose();
  });

  it('shows gear by loadout and tints by team', async () => {
    const asset = await loadAsset(placeholder);
    const r = new CharacterRenderer([{ asset }], camera, false);
    const a = actor();
    let root = run(r, a);
    expect(root.getObjectByName('Helmet')!.visible).toBe(false);
    expect(root.getObjectByName('Vest')!.visible).toBe(false);
    a.helmet = true;
    a.armor = 100;
    root = run(r, a);
    expect(root.getObjectByName('Helmet')!.visible).toBe(true);
    expect(root.getObjectByName('Vest')!.visible).toBe(true);

    const uniformColor = () => {
      let color: THREE.Color | null = null;
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
        if (m && !Array.isArray(m) && m.name === 'Uniform') color = m.color;
      });
      return color!;
    };
    const elite = uniformColor().clone();
    a.team = Team.Player;
    root = run(r, a);
    const ally = uniformColor();
    expect(ally.equals(elite)).toBe(false);
    expect(ally.b).toBeGreaterThan(ally.r); // blue-ish
    expect(new THREE.Color(UNIFORM_TINT.ally).b).toBeGreaterThan(new THREE.Color(UNIFORM_TINT.ally).r);
    r.dispose();
  });

  it('reuses instances as actors come and go', async () => {
    const r = new CharacterRenderer([{ asset: await loadAsset(placeholder) }], camera, false);
    const a = actor(1);
    const b = actor(2);
    r.update([a, b], -1, 1, 5, 1 / 60);
    expect(r.root.children.filter((c) => c.type === 'Group').length).toBe(2);
    r.update([a], -1, 1, 5, 1 / 60);
    expect(r.root.children.filter((c) => c.type === 'Group').length).toBe(1);
    // The local player and drivers aren't drawn.
    a.vehicle = 3;
    r.update([a, b], 2, 1, 5, 1 / 60);
    expect(r.root.children.filter((c) => c.type === 'Group').length).toBe(0);
    r.dispose();
  });
});
