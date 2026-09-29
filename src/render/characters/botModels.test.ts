import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { buildBotCharacter } from '../../devtools/botCharacters';
import { makeActor, Team, type Actor } from '../../sim/Actor';
import { makeItem } from '../../weapons/Inventory';
import { prepareCharacter } from './CharacterAssets';
import { CharacterRenderer } from './CharacterRenderer';
import { BOT_MODELS, botModelUrls, characterUrl, GEAR } from './characterSpec';
import { inspectCharacter } from './glbInspect';
import { pickVariant } from './variants';

/** The static sources and the committed outputs, read through Vite (the project has no Node types). */
const FILES = import.meta.glob<string>(['/art/characters/bots/*.glb', '/public/models/characters/bots/*.glb'], { query: '?inline', import: 'default', eager: true });
function file(path: string): Uint8Array | null {
  const url = FILES[path];
  if (!url) return null;
  const bin = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const built = new Map(BOT_MODELS.map((m) => [m.id, buildBotCharacter(file(`/art/characters/bots/${m.source}.glb`)!, m.source)]));

async function load(id: string) {
  const bytes = built.get(id)!;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return prepareCharacter(await new GLTFLoader().parseAsync(buf, ''));
}

function bot(id: number, armor: number): Actor {
  const a = makeActor(id, 'b', Team.Bots, 0, 0, 0);
  a.move.onGround = true;
  a.armor = armor;
  a.inv.primary = makeItem('ak47');
  a.inv.active = 'primary';
  return a;
}

describe('bot models', () => {
  it.each(BOT_MODELS.map((m) => m.id))('%s matches the spec with its arms down', async (id) => {
    const r = inspectCharacter(built.get(id)!);
    expect(r.errors).toEqual([]);
    const asset = await load(id);
    const body = asset.template.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    body.geometry.computeBoundingBox();
    const box = body.geometry.boundingBox!;
    // Out of the T-pose: nothing reaches past the hanging hands.
    expect(Math.max(-box.min.x, box.max.x)).toBeLessThan(0.4);
    // Every limb bone carries part of the body.
    const skin = body.geometry.getAttribute('skinIndex');
    const used = new Set<string>();
    for (let i = 0; i < skin.count; i++) used.add(body.skeleton.bones[skin.getX(i)].name);
    for (const side of ['L', 'R']) for (const b of ['UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot']) expect(used, `${b}_${side}`).toContain(`${b}_${side}`);
    for (const b of ['Hips', 'Spine', 'Chest', 'Neck', 'Head']) expect(used, b).toContain(b);
    asset.dispose();
  });

  it('keeps the committed files in sync with the generator', () => {
    for (const m of BOT_MODELS) {
      const committed = file(`/public/${m.file}`);
      const bytes = built.get(m.id)!;
      expect(committed, `public/${m.file} missing: run npm run models:bots`).not.toBeNull();
      expect(committed!.length === bytes.length && committed!.every((b, i) => b === bytes[i]), `${m.file} stale: run npm run models:bots`).toBe(true);
    }
  });

  it('turns plate carriers (only) into the vest', async () => {
    for (const m of BOT_MODELS) {
      const asset = await load(m.id);
      expect(!!asset.template.getObjectByName(GEAR.vest), m.id).toBe(m.id === 'terrorist_urban' || m.id === 'terrorist_desert');
      expect(asset.template.getObjectByName(GEAR.helmet), m.id).toBeUndefined();
      asset.dispose();
    }
  });

  it('picks gang models for unarmoured bots, terrorists for armoured ones and civilians for pedestrians, stably by id', () => {
    const groups = BOT_MODELS.map((m) => m.group);
    const picks = new Set<number>();
    for (let id = 1; id <= 64; id++) {
      const plain = pickVariant({ id, armor: 0 }, groups);
      expect(groups[plain]).toBe('gang');
      expect(groups[pickVariant({ id, armor: 100 }, groups)]).toBe('terrorist');
      expect(pickVariant({ id, armor: 0 }, groups)).toBe(plain);
      picks.add(plain);
    }
    expect(picks.size).toBe(4);
    // Civilians only ever get civilian models, and the gang's when there are none.
    for (let id = 1; id <= 64; id++) {
      expect(groups[pickVariant({ id, armor: 0, team: Team.Civilian }, groups)]).toBe('civilian');
      const noCivs = groups.filter((g) => g !== 'civilian');
      expect(noCivs[pickVariant({ id, armor: 0, team: Team.Civilian }, noCivs)]).toBe('gang');
    }
    // A group with no models falls back to all of them.
    expect(pickVariant({ id: 3, armor: 100 }, ['gang', undefined])).toBeLessThan(2);
    expect(pickVariant({ id: 3, armor: 0 }, [undefined])).toBe(0);
  });

  it('draws each bot with its group and keeps the model when the armour breaks', async () => {
    const variants = await Promise.all(BOT_MODELS.map(async (m) => ({ asset: await load(m.id), group: m.group })));
    const groups = variants.map((v) => v.group);
    const r = new CharacterRenderer(variants, new THREE.PerspectiveCamera(), false);
    // An armoured bot that lands on a plate-carrier model.
    let id = 1;
    while (!['terrorist_urban', 'terrorist_desert'].includes(BOT_MODELS[pickVariant({ id, armor: 100 }, groups)].id)) id++;
    const gang = bot(id + 1000, 0);
    const armoured = bot(id, 100);
    const models = () => r.root.children.filter((c) => c.name !== 'character-torch');
    r.update([gang, armoured], -1, 1, 0, 0.016);
    const [gangModel, terroristModel] = models();
    expect(gangModel.getObjectByName(GEAR.vest)).toBeUndefined();
    expect(terroristModel.getObjectByName(GEAR.vest)!.visible).toBe(true);
    armoured.armor = 0;
    r.update([gang, armoured], -1, 1, 0.1, 0.016);
    expect(models()[1]).toBe(terroristModel);
    expect(terroristModel.getObjectByName(GEAR.vest)!.visible).toBe(false);
    r.dispose();
    for (const v of variants) v.asset.dispose();
  });

  it('maps ?charmodel= to the bot models', () => {
    expect(botModelUrls(null, '/g/')).toEqual(BOT_MODELS.map((m) => ({ url: `/g/${m.file}`, group: m.group })));
    expect(botModelUrls('gang_biker', '/')).toEqual([{ url: '/models/characters/bots/gang_biker.glb' }]);
    expect(botModelUrls('none', '/')).toBeNull();
    expect(characterUrl('terrorist_desert', '/')).toBe('/models/characters/bots/terrorist_desert.glb');
  });
});
