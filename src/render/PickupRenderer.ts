import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Pickup } from '../sim/Pickups';
import { WEAPONS, type WeaponId } from '../weapons/weaponDefs';
import { getGunModel } from './viewmodel/gunMeshes';

const MAX = 96;
/** Guns of one kind on the ground at once. */
const MAX_GUNS = 32;
const RED = '#d8262c';

/**
 * Draws health packs as instanced white cases with a red cross, bobbing and turning slowly, and
 * dropped guns lying on their side (one InstancedMesh per weapon, sharing the viewmodel
 * geometry). Drops blink during their last seconds; the death stash gets a light beam.
 */
export class PickupRenderer {
  readonly root = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private clock = 0;
  private gunMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: '#202020' });
  private guns = new Map<WeaponId, THREE.InstancedMesh>();
  private gunCounts = new Map<WeaponId, number>();
  private beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private lying = new THREE.Quaternion();
  private shadows: boolean;

  constructor(shadows: boolean) {
    this.shadows = shadows;
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.35, 7, 16, 1, true).translate(0, 3.5, 0),
      new THREE.MeshBasicMaterial({ color: '#7fd4ff', transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.beam.visible = false;
    this.beam.name = 'stash-beam';
    this.root.add(this.beam);
    const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    // Case, then the cross: one bar pair on the lid and one on each long side.
    const parts: [THREE.BufferGeometry, string, string][] = [
      [box(0.42, 0.26, 0.32, 0, 0.13, 0), '#f2f2ee', '#303030'],
      [
        mergeGeometries([
          box(0.2, 0.012, 0.06, 0, 0.266, 0),
          box(0.06, 0.012, 0.2, 0, 0.266, 0),
          box(0.16, 0.05, 0.012, 0, 0.13, 0.166),
          box(0.05, 0.16, 0.012, 0, 0.13, 0.166),
          box(0.16, 0.05, 0.012, 0, 0.13, -0.166),
          box(0.05, 0.16, 0.012, 0, 0.13, -0.166),
        ])!,
        RED,
        '#5a0808',
      ],
    ];
    for (const [geo, color, emissive] of parts) {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color, emissive }), MAX);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = shadows;
      mesh.frustumCulled = false;
      mesh.name = 'pickup';
      this.meshes.push(mesh);
      this.root.add(mesh);
    }
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const m of this.meshes) m.castShadow = on;
    for (const m of this.guns.values()) m.castShadow = on;
  }

  private gunMesh(id: WeaponId): THREE.InstancedMesh {
    let mesh = this.guns.get(id);
    if (!mesh) {
      mesh = new THREE.InstancedMesh(getGunModel(id).geometry, this.gunMaterial, MAX_GUNS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = this.shadows;
      mesh.frustumCulled = false;
      mesh.name = `dropped-${id}`;
      this.guns.set(id, mesh);
      this.root.add(mesh);
    }
    return mesh;
  }

  update(items: readonly Pickup[], time: number, frameDt: number): void {
    this.clock += frameDt;
    let n = 0;
    this.gunCounts.clear();
    let stash: Pickup | null = null;
    for (const it of items) {
      const left = it.expiresAt - time;
      if (left < 5 && Math.floor(left * 6) % 2 === 0) continue;
      const pop = Math.min(1, (time - it.spawnedAt) / 0.3);
      if (it.stash) stash = it;
      if (it.item.kind === 'weapon') {
        const id = it.item.weapon;
        const k = this.gunCounts.get(id) ?? 0;
        if (k >= MAX_GUNS) continue;
        this.gunCounts.set(id, k + 1);
        // On its side (roll 90°) at its heading, resting on the floor.
        this.lying.setFromEuler(this.e.set(0, it.yaw, Math.PI / 2, 'YXZ'));
        const lift = WEAPONS[id].category === 'pistol' ? 0.02 : 0.035;
        this.v.set(it.pos.x, it.pos.y + lift, it.pos.z);
        this.m.compose(this.v, this.lying, this.s.setScalar(Math.max(0.01, pop)));
        this.gunMesh(id).setMatrixAt(k, this.m);
        continue;
      }
      if (it.item.kind === 'grenade') {
        // Grenades stand upright and turn slowly, a bit larger so they read on the ground.
        const id = it.item.grenade;
        const k = this.gunCounts.get(id) ?? 0;
        if (k >= MAX_GUNS) continue;
        this.gunCounts.set(id, k + 1);
        this.q.setFromEuler(this.e.set(0, this.clock * 0.7 + it.id, 0));
        this.v.set(it.pos.x, it.pos.y + 0.01, it.pos.z);
        this.m.compose(this.v, this.q, this.s.setScalar(Math.max(0.01, pop) * 1.4));
        this.gunMesh(id).setMatrixAt(k, this.m);
        continue;
      }
      if (n >= MAX) continue;
      const phase = it.id * 1.7;
      this.q.setFromEuler(this.e.set(0, this.clock * 0.9 + phase, 0));
      this.v.set(it.pos.x, it.pos.y + 0.12 + Math.sin(this.clock * 2.2 + phase) * 0.06, it.pos.z);
      this.m.compose(this.v, this.q, this.s.setScalar(Math.max(0.01, pop)));
      for (const mesh of this.meshes) mesh.setMatrixAt(n, this.m);
      n++;
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [id, mesh] of this.guns) {
      mesh.count = this.gunCounts.get(id) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.beam.visible = !!stash;
    if (stash) {
      this.beam.position.set(stash.pos.x, stash.pos.y, stash.pos.z);
      this.beam.material.opacity = 0.16 + 0.1 * Math.sin(this.clock * 2.5);
    }
  }

  dispose(): void {
    // Gun geometries belong to the shared gun model cache.
    for (const m of this.guns.values()) m.dispose();
    this.gunMaterial.dispose();
    this.beam.geometry.dispose();
    this.beam.material.dispose();
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}
