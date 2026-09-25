import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { GENERATED_CLIPS } from '../../devtools/characterRig';
import { buildSwatCharacter } from '../../devtools/swatCharacter';
import { makeActor, Team, type Actor, type TeamId } from '../../sim/Actor';
import { makeItem } from '../../weapons/Inventory';
import { BotRenderer } from '../BotRenderer';
import { CompositeActorRenderer } from '../CompositeActorRenderer';
import { prepareCharacter } from './CharacterAssets';
import { CharacterRenderer } from './CharacterRenderer';
import { BUDGET, characterUrl, PLAYER_FILE } from './characterSpec';
import { inspectCharacter } from './glbInspect';

/** The SWAT source and the committed output, read through Vite (the project has no Node types). */
const FILES = import.meta.glob<string>(['/art/characters/swat.glb', '/public/models/characters/player.glb'], { query: '?inline', import: 'default', eager: true });
function file(path: string): Uint8Array | null {
  const url = FILES[path];
  if (!url) return null;
  const bin = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const player = buildSwatCharacter(file('/art/characters/swat.glb')!);

async function loadPlayer() {
  const buf = player.buffer.slice(player.byteOffset, player.byteOffset + player.byteLength) as ArrayBuffer;
  return prepareCharacter(await new GLTFLoader().parseAsync(buf, ''));
}

function actor(id = 1, team: TeamId = Team.Player): Actor {
  const a = makeActor(id, 'p', team, 0, 0, 0);
  a.move.onGround = true;
  a.inv.primary = makeItem('ak47');
  a.inv.active = 'primary';
  return a;
}

const world = (root: THREE.Object3D, name: string) => root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());

describe('SWAT player model', () => {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  camera.position.set(0, 1.6, 4);

  it('passes the spec checks within budget', () => {
    const r = inspectCharacter(player);
    expect(r.errors).toEqual([]);
    expect(r.stats.clips.map((c) => c.name)).toEqual(GENERATED_CLIPS);
    expect(r.stats.height).toBeGreaterThan(1.7);
    expect(r.stats.height).toBeLessThan(1.8);
    expect(Math.abs(r.stats.minY)).toBeLessThan(0.01);
    expect(r.stats.materials.length).toBeLessThanOrEqual(BUDGET.materials);
    expect(r.stats.triangles).toBeLessThan(BUDGET.triangles);
    expect(r.warnings.filter((w) => w.includes('gear'))).toEqual([]);
  });

  it('keeps the committed player.glb in sync with its generator', () => {
    const committed = file(`/public/${PLAYER_FILE}`);
    expect(committed, `public/${PLAYER_FILE} missing: run npm run models:player`).not.toBeNull();
    expect(committed!.length === player.length && committed!.every((b, i) => b === player[i]), 'stale: run npm run models:player').toBe(true);
  });

  it('maps ?playermodel= to a file', () => {
    expect(characterUrl(null, '/', PLAYER_FILE)).toBe(`/${PLAYER_FILE}`);
    expect(characterUrl('player', '/game/')).toBe(`/game/${PLAYER_FILE}`);
    expect(characterUrl('none', '/', PLAYER_FILE)).toBeNull();
  });

  it('stands on its feet with the gun in the right hand and the gear toggling', async () => {
    const r = new CharacterRenderer([{ asset: await loadPlayer() }], camera, false);
    const a = actor();
    const run = (frames = 10) => {
      for (let i = 0; i < frames; i++) r.update([a], -1, 1, 5, 1 / 60);
      r.root.updateMatrixWorld(true);
      return r.root;
    };
    let root = run();
    // Ankles at their bind height, so the boots touch the ground.
    for (const side of ['L', 'R']) expect(world(root, `Foot_${side}`).y).toBeCloseTo(0.2, 1);
    const socket = world(root, 'Socket_Weapon');
    expect(socket.z).toBeLessThan(-0.15);
    expect(socket.x).toBeGreaterThan(0.02);
    // Shouldered: the top of the gun sits just under the eyes (the socket is at the grip).
    expect(socket.y).toBeGreaterThan(1.35);
    expect(socket.y).toBeLessThan(1.55);
    expect(world(root, 'Head').y).toBeGreaterThan(1.45);

    expect(root.getObjectByName('Helmet')!.visible).toBe(false);
    a.helmet = true;
    a.armor = 100;
    root = run();
    expect(root.getObjectByName('Helmet')!.visible).toBe(true);
    expect(root.getObjectByName('Vest')!.visible).toBe(true);

    // A pistol is held out at arm's length, lower and further forward than the shouldered rifle.
    a.inv.secondary = makeItem('glock');
    a.inv.active = 'secondary';
    const pistol = world(run(30), 'Socket_Weapon');
    expect(pistol.y).toBeLessThan(socket.y);
    expect(pistol.z).toBeLessThan(socket.z - 0.1);

    a.move.duckAmount = 1;
    expect(world(run(30), 'Head').y).toBeLessThan(1.25);
    r.dispose();
  });

  it('carries a long gun low on the move and brings it up to fire', async () => {
    const r = new CharacterRenderer([{ asset: await loadPlayer() }], camera, false);
    const a = actor();
    let t = 5;
    const step = (frames: number, speed: number) => {
      for (let i = 0; i < frames; i++) {
        a.prevPos.z = a.move.pos.z;
        a.move.pos.z -= speed / 60;
        t += 1 / 60;
        r.update([a], -1, 1, t, 1 / 60);
      }
      r.root.updateMatrixWorld(true);
      return world(r.root, 'Socket_Weapon').y - a.move.pos.y;
    };
    const aimed = step(30, 0);
    const ready = step(60, 3);
    expect(ready).toBeLessThan(aimed - 0.2);
    r.onEvent({ type: 'shot', shooterId: a.id, weapon: 'ak47', from: a.move.pos, to: a.move.pos, tracer: false });
    expect(step(30, 3)).toBeGreaterThan(aimed - 0.1);
    // Back to the ready carry once it stops firing.
    expect(step(90, 3)).toBeLessThan(aimed - 0.2);
    r.dispose();
  });

  it('draws players with the model and bots as box figures', async () => {
    const chars = new CharacterRenderer([{ asset: await loadPlayer() }], camera, false);
    const boxes = new BotRenderer(false);
    const r = new CompositeActorRenderer([
      { renderer: chars, accept: (a) => a.team === Team.Player },
      { renderer: boxes, accept: () => true },
    ]);
    r.update([actor(1), actor(2, Team.Bots), actor(3, Team.Bots)], -1, 1, 5, 1 / 60);
    expect(chars.root.children.filter((c) => c.type === 'Group').length).toBe(1);
    expect(r.root.children).toEqual([chars.root, boxes.root]);
    r.dispose();
  });
});
