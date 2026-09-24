import * as THREE from 'three';
import type { Door } from '../sim/Doors';
import { DoorState } from '../sim/Doors';
import type { Simulation } from '../sim/Simulation';
import { BRUSH_STRIDE, Material, type ChunkData } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';
import type { MaterialLibrary } from './materials';

const MAX_DOORS = 256;
/** Seconds a door takes to swing. */
const SWING = 0.25;
const DOOR_T = 0.06;

/**
 * Doors and window glass: they change at runtime, so they're drawn apart from the baked chunk
 * meshes. Doors are two InstancedMeshes (wood and metal leaves) rebuilt each frame from the
 * door system, swinging on their hinges; each chunk's panes are one transparent InstancedMesh
 * whose broken panes shrink to nothing.
 */
export class BreakablesRenderer implements StreamerListener {
  readonly root = new THREE.Group();
  private wood: THREE.InstancedMesh;
  private metal: THREE.InstancedMesh;
  private glassMat = new THREE.MeshLambertMaterial({ color: '#a9cfe0', emissive: '#1b2a33', transparent: true, opacity: 0.32, depthWrite: false });
  private paneGeo = new THREE.BoxGeometry(1, 1, 1);
  private panes = new Map<number, { mesh: THREE.InstancedMesh; index: Int32Array; matrices: THREE.Matrix4[] }>();
  private glassVersion = -1;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    private materials: MaterialLibrary,
    private shadows: boolean,
  ) {
    this.root.name = 'breakables';
    // Unit leaf with its hinge edge on the local Y axis, spanning +X.
    const leaf = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0);
    const make = (mat: number, color: string) => {
      const mesh = new THREE.InstancedMesh(leaf, new THREE.MeshLambertMaterial({ map: materials.get(mat).map, color }), MAX_DOORS);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      this.root.add(mesh);
      return mesh;
    };
    this.wood = make(Material.Wood, '#b08a64');
    this.metal = make(Material.Metal, '#8a9096');
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const mesh of [this.wood, this.metal]) mesh.castShadow = mesh.receiveShadow = on;
  }

  onChunkLoaded(d: ChunkData, visible: boolean): void {
    this.onChunkUnloaded(d.key);
    if (!d.glass.length) return;
    const n = d.glass.length;
    const mesh = new THREE.InstancedMesh(this.paneGeo, this.glassMat, n);
    const ox = d.cx * 64;
    const oz = d.cz * 64;
    const matrices: THREE.Matrix4[] = [];
    for (let k = 0; k < n; k++) {
      const o = d.glass[k] * BRUSH_STRIDE;
      const b = d.brushes;
      this.pos.set(ox + (b[o] + b[o + 3]) / 200, (b[o + 1] + b[o + 4]) / 200, oz + (b[o + 2] + b[o + 5]) / 200);
      this.scale.set((b[o + 3] - b[o]) / 100, (b[o + 4] - b[o + 1]) / 100, (b[o + 5] - b[o + 2]) / 100);
      const m = new THREE.Matrix4().compose(this.pos, this.q.identity(), this.scale);
      matrices.push(m);
      mesh.setMatrixAt(k, m);
    }
    mesh.visible = visible;
    mesh.renderOrder = 2;
    this.root.add(mesh);
    this.panes.set(d.key, { mesh, index: d.glass, matrices });
    this.glassVersion = -1;
  }

  onChunkUnloaded(key: number): void {
    const p = this.panes.get(key);
    if (!p) return;
    this.root.remove(p.mesh);
    p.mesh.dispose();
    this.panes.delete(key);
  }

  onChunkVisibility(key: number, visible: boolean): void {
    const p = this.panes.get(key);
    if (p) p.mesh.visible = visible;
  }

  update(sim: Simulation, simTime: number): void {
    // Glass: resync broken panes when anything broke.
    if (sim.glass.version !== this.glassVersion) {
      this.glassVersion = sim.glass.version;
      for (const [key, p] of this.panes) {
        for (let k = 0; k < p.index.length; k++) p.mesh.setMatrixAt(k, sim.glass.isBroken(key, p.index[k]) ? this.zero : p.matrices[k]);
        p.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    // Doors.
    let nw = 0;
    let nm = 0;
    for (const door of sim.doors.doors.values()) {
      if (door.state === DoorState.Broken) continue;
      const mesh = door.metal ? this.metal : this.wood;
      const i = door.metal ? nm++ : nw++;
      if (i >= MAX_DOORS) continue;
      this.leafMatrix(door, simTime);
      mesh.setMatrixAt(i, this.m);
    }
    this.wood.count = Math.min(nw, MAX_DOORS);
    this.metal.count = Math.min(nm, MAX_DOORS);
    this.wood.instanceMatrix.needsUpdate = true;
    this.metal.instanceMatrix.needsUpdate = true;
  }

  /** Hinged at the door's -X (or -Z) edge, swinging towards the side it opened to. */
  private leafMatrix(door: Door, simTime: number): void {
    const hw = door.width / 2;
    const dir = door.side * door.inward;
    const closedYaw = door.alongX ? 0 : -Math.PI / 2;
    const openYaw = door.alongX ? -dir * (Math.PI / 2) : closedYaw + dir * (Math.PI / 2);
    const t = Math.min(1, Math.max(0, (simTime - door.changedAt) / SWING));
    const e = t * t * (3 - 2 * t);
    const open = door.state === DoorState.Open;
    const yaw = open ? closedYaw + (openYaw - closedYaw) * e : openYaw + (closedYaw - openYaw) * e;
    this.q.setFromAxisAngle(this.up, yaw);
    if (door.alongX) this.pos.set(door.x - hw, door.y, door.z);
    else this.pos.set(door.x, door.y, door.z - hw);
    this.scale.set(door.width - 0.02, door.height - 0.02, DOOR_T);
    this.m.compose(this.pos, this.q, this.scale);
  }

  dispose(): void {
    for (const key of [...this.panes.keys()]) this.onChunkUnloaded(key);
    this.paneGeo.dispose();
    this.glassMat.dispose();
    for (const mesh of [this.wood, this.metal]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
