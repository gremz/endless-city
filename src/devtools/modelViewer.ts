import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { STAND_BOXES } from '../ai/hitboxes';
import type { SimEvent } from '../core/events';
import { vec3 } from '../core/math';
import { MOVE } from '../player/movementConfig';
import { makeActor, Team } from '../sim/Actor';
import { makeItem } from '../weapons/Inventory';
import { WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import { loadCharacterAsset, type CharacterAsset } from '../render/characters/CharacterAssets';
import { CharacterRenderer } from '../render/characters/CharacterRenderer';
import { BOT_MODELS, characterUrl, CLIPS } from '../render/characters/characterSpec';
import { inspectCharacter } from '../render/characters/glbInspect';

/**
 * Dev page (/models.html) for checking a character export: drives the real CharacterRenderer
 * with a stand-in actor (speed, direction, crouch, aim, weapon, gear, look, overlays), or plays
 * one clip raw; shows the hitboxes the game uses, and the models:check report for the file.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a3038');
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
camera.position.set(2.2, 1.7, -3.2);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);

scene.add(new THREE.HemisphereLight('#cfe3ff', '#6b5a48', 1.35));
const sun = new THREE.DirectionalLight('#fff1d8', 2.6);
sun.position.set(4, 8, -3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -4;
sun.shadow.camera.right = sun.shadow.camera.top = 4;
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: '#50565c' }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
const grid = new THREE.GridHelper(400, 400, '#8a939c', '#6a7178');
grid.position.y = 0.002;
scene.add(ground, grid);

// Hitboxes and collision hull, following the actor like the game's (yaw-aligned, crouch-scaled).
const hitboxes = new THREE.Group();
for (const b of STAND_BOXES) {
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2)), new THREE.LineBasicMaterial({ color: b.group === 0 ? '#ff5a5a' : '#ffd24a' }));
  box.userData.box = b;
  hitboxes.add(box);
}
const hull = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#5ad1ff' }));
scene.add(hitboxes, hull);

const actor = makeActor(1, 'model', Team.Bots, 0, 0, 0);
actor.move.onGround = true;
const torches = new Set<number>();
let asset: CharacterAsset | null = null;
let chars: CharacterRenderer | null = null;
let raw: { obj: THREE.Object3D; mixer: THREE.AnimationMixer; action: THREE.AnimationAction | null } | null = null;
let time = 10;

// The bot models, before "other path…".
const modelSel = $<HTMLSelectElement>('model');
for (const m of BOT_MODELS) modelSel.add(new Option(`${m.id}.glb (${m.group})`, m.id), modelSel.options.length - 1);

const weaponSel = $<HTMLSelectElement>('weapon');
for (const id of Object.keys(WEAPONS) as WeaponId[]) weaponSel.append(new Option(WEAPONS[id].name, id));
weaponSel.value = 'ak47';

function modelUrl(): string {
  const choice = $<HTMLSelectElement>('model').value;
  $('customRow').hidden = choice !== 'custom';
  const param = choice === 'custom' ? $<HTMLInputElement>('custom').value.trim() || null : choice || null;
  return characterUrl(param, import.meta.env.BASE_URL)!;
}

async function load(): Promise<void> {
  const url = `${modelUrl()}?v=${Date.now()}`;
  const report = $('report');
  report.textContent = 'loading…';
  chars?.dispose();
  if (chars) scene.remove(chars.root);
  if (raw) scene.remove(raw.obj);
  asset?.dispose();
  chars = null;
  raw = null;
  asset = null;
  // The same checks as `npm run models:check`.
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    if (res.headers.get('content-type')?.includes('text/html')) throw new Error('file not found (export it there, then Reload)');
    const r = inspectCharacter(new Uint8Array(await res.arrayBuffer()));
    const s = r.stats;
    report.innerHTML = '';
    const line = (text: string, cls = '') => report.append(Object.assign(document.createElement('div'), { textContent: text, className: cls }));
    line(`${(s.bytes / 1024).toFixed(0)} KB · ${s.triangles} tris · ${s.bones} bones · ${s.height.toFixed(2)} m`);
    line(`materials: ${s.materials.join(', ')}`);
    for (const e of r.errors) line(`✗ ${e}`, 'err');
    for (const w of r.warnings) line(`! ${w}`, 'warn');
    if (!r.errors.length) line('✓ matches the spec');
  } catch (err) {
    report.textContent = `Couldn't read ${url.split('?')[0]}: ${(err as Error).message}`;
    return;
  }
  try {
    asset = await loadCharacterAsset(url);
  } catch (err) {
    $('report').append(Object.assign(document.createElement('div'), { textContent: `✗ ${(err as Error).message}`, className: 'err' }));
    return;
  }
  chars = new CharacterRenderer([{ asset }], camera, true);
  scene.add(chars.root);
  const clipSel = $<HTMLSelectElement>('clip');
  clipSel.innerHTML = '';
  for (const c of CLIPS) if (asset.clips.has(c.name)) clipSel.append(new Option(`${c.name} (${asset.durations.get(c.name)!.toFixed(2)}s)`, c.name));
  const obj = cloneSkinned(asset.template);
  obj.traverse((o) => (o.castShadow = (o as THREE.Mesh).isMesh));
  raw = { obj, mixer: new THREE.AnimationMixer(obj), action: null };
  scene.add(obj);
  applyMode();
}

function applyMode(): void {
  const clipMode = $<HTMLSelectElement>('mode').value === 'clip';
  $('clipRow').hidden = !clipMode;
  if (chars) chars.root.visible = !clipMode;
  if (!raw || !asset) return;
  raw.obj.visible = clipMode;
  raw.action?.stop();
  raw.action = null;
  if (!clipMode) return;
  const name = $<HTMLSelectElement>('clip').value;
  // Overlays are stored additive for the game; show them as exported here.
  const clip = asset.sourceClips.get(name);
  if (!clip) return;
  raw.action = raw.mixer.clipAction(clip);
  raw.action.play();
}

function equip(id: WeaponId): void {
  const inv = actor.inv;
  const slot = WEAPONS[id].slot;
  if (slot === 'knife') inv.knife = makeItem(id);
  else inv[slot] = makeItem(id);
  inv.active = slot;
}

function overlay(type: string): void {
  const at = vec3(0, 0, 0);
  const events: Record<string, SimEvent> = {
    shot: { type: 'shot', shooterId: actor.id, weapon: weaponSel.value, from: at, to: at, tracer: false },
    reload: { type: 'reload', actorId: actor.id, weapon: weaponSel.value },
    nade_throw: { type: 'nade_throw', actorId: actor.id, weapon: 'hegrenade' },
    hit: { type: 'hit', attackerId: 0, victimId: actor.id, damage: 10, group: 1, pos: at, helmetHit: false, killed: false },
  };
  chars?.onEvent(events[type]);
}

function num(id: string, fmt: (v: number) => string): number {
  const v = Number($<HTMLInputElement>(id).value);
  $(`${id}Out`).textContent = fmt(v);
  return v;
}

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const rate = num('rate', (v) => `${v.toFixed(2)}×`);
  const dt = (Math.min(0.1, (now - last) / 1000)) * rate;
  last = now;
  time += dt;

  const speed = num('speed', (v) => v.toFixed(2));
  const dir = num('dir', (v) => `${v}°`) * THREE.MathUtils.DEG2RAD;
  const crouch = num('crouch', (v) => v.toFixed(2));
  const pitch = num('pitch', (v) => `${v}°`) * THREE.MathUtils.DEG2RAD;
  const a = actor;
  const m = a.move;
  const look = $<HTMLSelectElement>('look').value;
  a.team = look === 'ally' ? Team.Player : Team.Bots;
  a.dummy = look === 'dummy';
  if (look === 'elite') {
    $<HTMLInputElement>('helmet').checked = true;
    $<HTMLInputElement>('vest').checked = true;
  }
  a.helmet = $<HTMLInputElement>('helmet').checked;
  a.armor = $<HTMLInputElement>('vest').checked ? 100 : 0;
  a.pitch = pitch;
  m.duckAmount = crouch;
  m.onGround = !$<HTMLInputElement>('air').checked;
  torches.clear();
  if ($<HTMLInputElement>('torch').checked) torches.add(a.id);
  // Walk the actor across the grid (facing -Z at yaw 0) so foot sliding shows against it.
  a.prevPos.x = m.pos.x;
  a.prevPos.z = m.pos.z;
  a.prevYaw = a.yaw;
  const heading = a.yaw + dir;
  m.pos.x += -Math.sin(heading) * speed * dt;
  m.pos.z += -Math.cos(heading) * speed * dt;
  if (Math.hypot(m.pos.x, m.pos.z) > 60) m.pos.x = m.pos.z = a.prevPos.x = a.prevPos.z = 0;

  chars?.update([a], -1, 1, time, dt, torches, 1);
  const clipMode = $<HTMLSelectElement>('mode').value === 'clip';
  if (raw && clipMode) {
    raw.obj.position.set(0, 0, 0);
    raw.mixer.update(dt);
  }
  const base = clipMode ? new THREE.Vector3() : new THREE.Vector3(m.pos.x, m.pos.y, m.pos.z);

  const k = 1 + (MOVE.duckEye / MOVE.standEye - 1) * crouch;
  hitboxes.visible = $<HTMLInputElement>('hitboxes').checked;
  hitboxes.position.copy(base);
  hitboxes.rotation.y = a.yaw;
  for (const box of hitboxes.children) {
    const b = box.userData.box as (typeof STAND_BOXES)[number];
    box.position.y = b.cy * k;
    box.scale.y = k;
  }
  hull.visible = $<HTMLInputElement>('hull').checked;
  const hullH = MOVE.standHeight + (MOVE.duckHeight - MOVE.standHeight) * crouch;
  hull.scale.set(MOVE.halfWidth * 2, hullH, MOVE.halfWidth * 2);
  hull.position.set(base.x, base.y + hullH / 2, base.z);

  if ($<HTMLInputElement>('follow').checked) {
    const delta = base.clone().setY(1).sub(controls.target);
    controls.target.add(delta);
    camera.position.add(delta);
  }
  sun.position.set(base.x + 4, 8, base.z - 3);
  sun.target.position.copy(base);
  controls.update();

  const weights = chars?.debugWeights(a.id);
  $('weights').textContent = weights && !clipMode
    ? [...weights].filter(([, v]) => v > 0.005).map(([n, v]) => `${n.padEnd(12)} ${(v * 100).toFixed(0).padStart(3)}%`).join('\n')
    : '';
  renderer.render(scene, camera);
}

$('model').addEventListener('change', () => void load());
$('custom').addEventListener('change', () => void load());
$('reload').addEventListener('click', () => void load());
$('mode').addEventListener('change', applyMode);
$('clip').addEventListener('change', applyMode);
weaponSel.addEventListener('change', () => equip(weaponSel.value as WeaponId));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-overlay]')) b.addEventListener('click', () => overlay(b.dataset.overlay!));
$('die').addEventListener('click', () => {
  actor.alive = !actor.alive;
  actor.diedAt = time;
  $('die').textContent = actor.alive ? 'Die' : 'Revive';
});
equip('ak47');
// `?model=player` (or placeholder, a bot id, or a path) picks the model to open.
const startModel = new URLSearchParams(location.search).get('model');
if (startModel) {
  const sel = $<HTMLSelectElement>('model');
  if ([...sel.options].some((o) => o.value === startModel)) sel.value = startModel;
  else {
    sel.value = 'custom';
    $<HTMLInputElement>('custom').value = startModel;
  }
}
void load();
requestAnimationFrame(frame);
