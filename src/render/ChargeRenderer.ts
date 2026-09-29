import * as THREE from 'three';
import type { ChargeSystem } from '../sim/breach';

const MAX_CHARGES = 16;

/**
 * Live breaching charges, straight from the simulation: a grey block stuck to the wall with a red
 * light that blinks faster as the fuse runs down (in step with the beeps).
 */
export class ChargeRenderer {
  readonly root = new THREE.Group();
  private blocks: THREE.InstancedMesh;
  private lights: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private n = new THREE.Vector3();
  private zAxis = new THREE.Vector3(0, 0, 1);
  private one = new THREE.Vector3(1, 1, 1);

  constructor() {
    const block = new THREE.BoxGeometry(0.32, 0.22, 0.08);
    this.blocks = new THREE.InstancedMesh(block, new THREE.MeshLambertMaterial({ color: '#7d8087' }), MAX_CHARGES);
    const led = new THREE.SphereGeometry(0.025, 8, 6).translate(0.1, 0.06, 0.045);
    this.lights = new THREE.InstancedMesh(led, new THREE.MeshBasicMaterial({ color: '#ff2a1a' }), MAX_CHARGES);
    for (const mesh of [this.blocks, this.lights]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.root.add(mesh);
    }
    this.root.name = 'charges';
  }

  update(charges: ChargeSystem, simTime: number): void {
    let n = 0;
    let lit = 0;
    for (const c of charges.active) {
      if (n >= MAX_CHARGES) break;
      this.p.set(c.pos.x, c.pos.y, c.pos.z);
      this.n.set(c.normal.x, c.normal.y, c.normal.z);
      this.q.setFromUnitVectors(this.zAxis, this.n);
      this.m.compose(this.p, this.q, this.one);
      this.blocks.setMatrixAt(n++, this.m);
      // Blink with the beeps: from twice a second to a rapid flicker.
      const left = Math.max(0, c.detonateAt - simTime);
      const rate = 2 + (1 - Math.min(1, left / 3)) * 8;
      if ((simTime * rate) % 1 < 0.35) this.lights.setMatrixAt(lit++, this.m);
    }
    this.blocks.count = n;
    this.lights.count = lit;
    this.blocks.instanceMatrix.needsUpdate = true;
    this.lights.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.blocks, this.lights]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
