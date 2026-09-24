import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WeaponId } from '../../weapons/weaponDefs';

/**
 * Procedural first-person weapon models built from boxes and cylinders with vertex colors.
 * Local space: the gun points down -Z, origin at the grip, meters.
 */

export interface GunModel {
  geometry: THREE.BufferGeometry;
  /** Muzzle tip in model space. */
  muzzle: THREE.Vector3;
  /** Where the viewmodel sits relative to the camera. */
  offset: THREE.Vector3;
  /** Left hand grip point (model space), or null for one-handed. */
  leftHand: THREE.Vector3 | null;
}

type Part = THREE.BufferGeometry;

function colorize(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const cols = new Float32Array(n * 3);
  const nrm = g.getAttribute('normal');
  for (let i = 0; i < n; i++) {
    // Bake a little top-down shading so edges read even in flat light.
    const shade = 0.82 + 0.18 * Math.max(0, nrm.getY(i));
    cols[i * 3] = c.r * shade;
    cols[i * 3 + 1] = c.g * shade;
    cols[i * 3 + 2] = c.b * shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  if (g.index) {
    const ni = g.toNonIndexed();
    return ni;
  }
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: string, rx = 0, ry = 0, rz = 0): Part {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx);
  g.rotateY(ry);
  g.rotateZ(rz);
  g.translate(x, y, z);
  return colorize(g, color);
}

/** Cylinder along Z. */
function tube(r: number, len: number, x: number, y: number, z: number, color: string, seg = 10): Part {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return colorize(g, color);
}

/** Upright cylinder (along Y), optionally tapered. */
function cyl(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: string, seg = 12): Part {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  g.translate(x, y, z);
  return colorize(g, color);
}

function ball(r: number, x: number, y: number, z: number, color: string, sy = 1): Part {
  const g = new THREE.SphereGeometry(r, 12, 9);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return colorize(g, color);
}

/** Spoon, pin and ring shared by the pin grenades (sitting on top of a body of height h). */
function fuzeParts(top: number): Part[] {
  return [
    cyl(0.011, 0.013, 0.02, 0, top + 0.01, 0, METAL_LIGHT),
    box(0.012, 0.075, 0.006, 0.014, top - 0.02, 0, '#8c8f94', 0, 0, -0.12),
    box(0.02, 0.004, 0.004, -0.012, top + 0.012, 0, '#b9bec4'),
    tube(0.009, 0.003, -0.027, top + 0.012, 0, '#c9ced4', 8),
  ];
}

/** Hand-held grenade model: held in the palm, no second hand. */
function grenadeModel(parts: Part[]): GunModel {
  return {
    geometry: build(parts),
    muzzle: new THREE.Vector3(0, 0.05, -0.05),
    offset: new THREE.Vector3(0.14, -0.1, -0.34),
    leftHand: null,
  };
}

function build(parts: Part[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

const METAL = '#3c3e42';
const METAL_LIGHT = '#62656b';
const POLYMER = '#2e3033';
const WOOD = '#8a4a20';
const BAKELITE = '#5e2c12';

const MODELS: Record<WeaponId, () => GunModel> = {
  knife: () => ({
    geometry: build([
      box(0.028, 0.034, 0.12, 0, 0, 0.02, POLYMER),
      box(0.05, 0.012, 0.012, 0, 0, -0.045, METAL_LIGHT),
      box(0.006, 0.032, 0.17, 0, 0.004, -0.13, '#b9bec4'),
      box(0.004, 0.012, 0.05, 0, 0.022, -0.2, '#d8dde2', 0.5),
    ]),
    muzzle: new THREE.Vector3(0, 0, -0.22),
    offset: new THREE.Vector3(0.16, -0.16, -0.3),
    leftHand: null,
  }),
  glock: () => ({
    geometry: build([
      box(0.028, 0.03, 0.19, 0, 0.045, -0.06, POLYMER),
      box(0.026, 0.02, 0.15, 0, 0.02, -0.05, '#26282a'),
      box(0.026, 0.1, 0.045, 0, -0.03, 0.0, '#26282a', 0.2),
      box(0.008, 0.012, 0.006, 0, 0.066, -0.145, METAL_LIGHT),
      box(0.008, 0.01, 0.006, 0, 0.066, 0.025, METAL_LIGHT),
      tube(0.006, 0.02, 0, 0.045, -0.16, METAL),
    ]),
    muzzle: new THREE.Vector3(0, 0.045, -0.17),
    offset: new THREE.Vector3(0.13, -0.14, -0.3),
    leftHand: new THREE.Vector3(0, -0.03, 0.01),
  }),
  deagle: () => ({
    geometry: build([
      box(0.032, 0.04, 0.25, 0, 0.05, -0.08, '#9aa0a6'),
      box(0.03, 0.02, 0.2, 0, 0.022, -0.06, '#7e8388'),
      box(0.032, 0.11, 0.05, 0, -0.03, 0.01, '#1c1c1c', 0.18),
      tube(0.009, 0.02, 0, 0.05, -0.21, METAL),
      box(0.006, 0.014, 0.01, 0, 0.076, -0.19, METAL),
    ]),
    muzzle: new THREE.Vector3(0, 0.05, -0.22),
    offset: new THREE.Vector3(0.13, -0.15, -0.31),
    leftHand: new THREE.Vector3(0, -0.03, 0.02),
  }),
  mp9: () => ({
    geometry: build([
      box(0.04, 0.055, 0.25, 0, 0.03, -0.08, POLYMER),
      tube(0.009, 0.08, 0, 0.035, -0.24, METAL),
      box(0.03, 0.12, 0.04, 0, -0.045, 0.0, '#18191a', 0.12),
      box(0.025, 0.08, 0.03, 0, -0.03, -0.14, '#18191a'),
      box(0.02, 0.02, 0.16, 0, 0.02, 0.12, METAL),
      box(0.012, 0.02, 0.06, 0, 0.068, -0.1, METAL),
    ]),
    muzzle: new THREE.Vector3(0, 0.035, -0.28),
    offset: new THREE.Vector3(0.14, -0.15, -0.3),
    leftHand: new THREE.Vector3(0, -0.02, -0.14),
  }),
  ump45: () => ({
    geometry: build([
      box(0.045, 0.07, 0.34, 0, 0.03, -0.1, '#232426'),
      tube(0.01, 0.07, 0, 0.04, -0.3, METAL),
      box(0.032, 0.14, 0.05, 0, -0.07, -0.13, '#1b1c1d', -0.05),
      box(0.03, 0.09, 0.04, 0, -0.04, 0.03, POLYMER, 0.25),
      box(0.03, 0.05, 0.22, 0, 0.02, 0.17, POLYMER),
      box(0.012, 0.02, 0.1, 0, 0.075, -0.1, METAL),
    ]),
    muzzle: new THREE.Vector3(0, 0.04, -0.34),
    offset: new THREE.Vector3(0.14, -0.15, -0.32),
    leftHand: new THREE.Vector3(0, -0.01, -0.22),
  }),
  ak47: () => ({
    geometry: build([
      box(0.048, 0.065, 0.3, 0, 0.03, -0.1, METAL),
      box(0.05, 0.02, 0.28, 0, 0.068, -0.1, METAL_LIGHT),
      box(0.056, 0.055, 0.2, 0, 0.022, -0.34, WOOD),
      tube(0.013, 0.2, 0, 0.068, -0.35, METAL),
      tube(0.009, 0.32, 0, 0.035, -0.48, METAL),
      box(0.012, 0.035, 0.012, 0, 0.065, -0.6, METAL),
      tube(0.013, 0.05, 0, 0.035, -0.64, METAL),
      box(0.04, 0.075, 0.26, 0, 0.0, 0.17, WOOD, 0.1),
      box(0.034, 0.1, 0.04, 0, -0.045, 0.0, WOOD, 0.3),
      box(0.034, 0.075, 0.05, 0, -0.035, -0.1, BAKELITE, -0.12),
      box(0.034, 0.075, 0.05, 0, -0.1, -0.075, BAKELITE, -0.35),
      box(0.034, 0.07, 0.05, 0, -0.155, -0.035, BAKELITE, -0.6),
    ]),
    muzzle: new THREE.Vector3(0, 0.035, -0.67),
    offset: new THREE.Vector3(0.13, -0.14, -0.3),
    leftHand: new THREE.Vector3(0, 0.0, -0.34),
  }),
  m4a4: () => ({
    geometry: build([
      box(0.046, 0.07, 0.3, 0, 0.03, -0.1, '#2e3033'),
      box(0.03, 0.02, 0.26, 0, 0.074, -0.12, POLYMER),
      box(0.06, 0.06, 0.2, 0, 0.03, -0.34, POLYMER),
      tube(0.009, 0.3, 0, 0.035, -0.5, METAL),
      tube(0.014, 0.06, 0, 0.035, -0.66, METAL),
      box(0.012, 0.045, 0.012, 0, 0.078, -0.42, METAL),
      box(0.04, 0.055, 0.2, 0, 0.02, 0.17, POLYMER),
      tube(0.014, 0.12, 0, 0.03, 0.08, METAL),
      box(0.032, 0.1, 0.04, 0, -0.05, 0.0, POLYMER, 0.3),
      box(0.032, 0.13, 0.06, 0, -0.07, -0.1, '#3a3c3f', -0.05),
    ]),
    muzzle: new THREE.Vector3(0, 0.035, -0.69),
    offset: new THREE.Vector3(0.13, -0.14, -0.3),
    leftHand: new THREE.Vector3(0, 0.0, -0.34),
  }),
  awp: () => ({
    geometry: build([
      box(0.055, 0.075, 0.42, 0, 0.02, -0.12, '#4b5a38'),
      tube(0.012, 0.5, 0, 0.035, -0.58, METAL),
      tube(0.018, 0.06, 0, 0.035, -0.86, METAL),
      tube(0.022, 0.3, 0, 0.1, -0.12, '#151515', 14),
      tube(0.03, 0.06, 0, 0.1, -0.28, '#151515', 14),
      tube(0.028, 0.05, 0, 0.1, 0.04, '#151515', 14),
      box(0.012, 0.04, 0.02, 0, 0.07, -0.13, METAL),
      box(0.05, 0.1, 0.25, 0, -0.01, 0.2, '#4b5a38', 0.05),
      box(0.034, 0.1, 0.04, 0, -0.05, 0.0, '#3a452b', 0.35),
      box(0.03, 0.06, 0.07, 0, -0.035, -0.12, '#222'),
      box(0.012, 0.02, 0.05, 0.035, 0.05, 0.02, METAL_LIGHT, 0, 0, 0.5),
    ]),
    muzzle: new THREE.Vector3(0, 0.035, -0.9),
    offset: new THREE.Vector3(0.13, -0.15, -0.32),
    leftHand: new THREE.Vector3(0, -0.01, -0.3),
  }),
  hegrenade: () => grenadeModel([ball(0.03, 0, 0.03, 0, '#4d5a33', 1.15), ...fuzeParts(0.064)]),
  flashbang: () => grenadeModel([cyl(0.024, 0.024, 0.085, 0, 0.042, 0, '#8a9097'), cyl(0.025, 0.025, 0.012, 0, 0.02, 0, '#d9c24a'), ...fuzeParts(0.085)]),
  smokegrenade: () =>
    grenadeModel([cyl(0.026, 0.026, 0.1, 0, 0.05, 0, '#4a4f4a'), cyl(0.027, 0.027, 0.014, 0, 0.07, 0, '#b8bdb0'), ...fuzeParts(0.1)]),
  molotov: () =>
    grenadeModel([
      cyl(0.032, 0.03, 0.1, 0, 0.05, 0, '#6b3d12'),
      cyl(0.012, 0.03, 0.035, 0, 0.117, 0, '#6b3d12'),
      cyl(0.011, 0.011, 0.03, 0, 0.149, 0, '#6b3d12'),
      box(0.02, 0.045, 0.02, 0.004, 0.18, 0, '#d8cfb0', 0, 0, 0.25),
      cyl(0.033, 0.031, 0.03, 0, 0.04, 0, '#e6dcc0'),
    ]),
};

const cache = new Map<WeaponId, GunModel>();

export function getGunModel(id: WeaponId): GunModel {
  let m = cache.get(id);
  if (!m) {
    m = MODELS[id]();
    cache.set(id, m);
  }
  return m;
}

/** Arm geometry: a forearm box running from the hand back and down towards the camera edge. */
export function makeArmGeometry(): THREE.BufferGeometry {
  return build([
    box(0.07, 0.07, 0.34, 0, 0, 0.17, '#3d4636'),
    box(0.075, 0.075, 0.05, 0, 0, 0.345, '#343d2e'),
    box(0.06, 0.05, 0.07, 0, 0.005, -0.02, '#1e1e1e'),
  ]);
}

export function disposeGunModels(): void {
  for (const m of cache.values()) m.geometry.dispose();
  cache.clear();
}
