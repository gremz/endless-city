import * as THREE from 'three';
import { lerp, wrapAngle } from '../core/math';
import { CAR } from '../sim/vehicle/carPhysics';
import { SMOKE_HEALTH, type Vehicle } from '../sim/vehicle/Vehicle';
import { BrushWriter } from '../world/gen/BrushWriter';
import { bakeMeshes } from '../world/gen/meshBake';
import { carBrushes, CAR_L, CAR_W, type CarLook } from '../world/gen/streets';
import { Billboards, makePuffTexture } from './fx/Effects';
import { meshGeometry } from './ChunkRenderer';
import type { MaterialLibrary } from './materials';

interface Model {
  parts: { geometry: THREE.BufferGeometry; material: number }[];
}

interface CarView {
  group: THREE.Group;
  body: THREE.Group;
  key: string;
  brake: THREE.Mesh;
  head: THREE.Mesh;
}

const PUFFS = 10;

/**
 * Draws the driveable cars: the same brush-built model the city's parked wrecks use (baked once
 * per paint and body type), placed at each car's interpolated pose. Brake and head lights glow,
 * the local driver gets real headlights at night, and damaged cars smoke.
 */
export class VehicleRenderer {
  readonly root = new THREE.Group();
  private models = new Map<string, Model>();
  private views = new Map<number, CarView>();
  private lightMat = {
    brake: new THREE.MeshBasicMaterial({ color: '#ff2a1a', transparent: true, opacity: 0.9, depthWrite: false }),
    head: new THREE.MeshBasicMaterial({ color: '#fff4d8', transparent: true, opacity: 0.95, depthWrite: false }),
  };
  private brakeGeo: THREE.BufferGeometry;
  private headGeo: THREE.BufferGeometry;
  private headlight: THREE.SpotLight;
  private smoke: Billboards;
  private clock = 0;
  private seen = new Set<number>();

  constructor(
    private materials: MaterialLibrary,
    private shadows: boolean,
  ) {
    this.root.name = 'vehicles';
    // Two lamp quads per end, facing out of the car (local -Z is the front).
    this.brakeGeo = lampPair(0.615, 0.77, CAR_L / 2 - 0.08, 0.33, 0.14, 1);
    this.headGeo = lampPair(0.575, 0.75, -CAR_L / 2 + 0.08, 0.35, 0.14, -1);
    this.headlight = new THREE.SpotLight('#fff1d6', 0, 45, 0.55, 0.45, 1.2);
    this.headlight.castShadow = false;
    this.root.add(this.headlight, this.headlight.target);
    this.smoke = new Billboards(PUFFS * 16, makePuffTexture(11), false);
    this.smoke.mesh.renderOrder = 2;
    this.root.add(this.smoke.mesh);
  }

  private model(paint: number, hatch: boolean, look: CarLook): Model {
    const key = `${paint}|${hatch}|${look}`;
    let m = this.models.get(key);
    if (m) return m;
    const w = new BrushWriter(64);
    // Centered on the origin, front towards -Z (yaw 0).
    carBrushes(w, { paint, hatch, flip: false, look }, false, -CAR_W / 2, -CAR_L / 2, 0);
    m = { parts: bakeMeshes(w.finish()).map((d) => ({ geometry: meshGeometry(d), material: d.material })) };
    this.models.set(key, m);
    return m;
  }

  private view(v: Vehicle): CarView {
    let view = this.views.get(v.id);
    const look: CarLook = v.destroyed ? 'burnt' : 'intact';
    const key = `${v.paint}|${v.hatch}|${look}`;
    if (!view) {
      const group = new THREE.Group();
      const body = new THREE.Group();
      const brake = new THREE.Mesh(this.brakeGeo, this.lightMat.brake);
      const head = new THREE.Mesh(this.headGeo, this.lightMat.head);
      body.add(brake, head);
      group.add(body);
      this.root.add(group);
      view = { group, body, key: '', brake, head };
      this.views.set(v.id, view);
    }
    if (view.key !== key) {
      for (const c of [...view.body.children]) if (c !== view.brake && c !== view.head) view.body.remove(c);
      for (const p of this.model(v.paint, v.hatch, look).parts) {
        const mesh = new THREE.Mesh(p.geometry, this.materials.get(p.material));
        mesh.castShadow = this.shadows;
        mesh.receiveShadow = this.shadows;
        view.body.add(mesh);
      }
      view.key = key;
    }
    return view;
  }

  /**
   * Place every car. `localCar` is the id of the car this screen's player drives (-1 if none);
   * `darkness` 0..1 turns lights on.
   */
  update(vehicles: readonly Vehicle[], alpha: number, time: number, frameDt: number, localCar: number, darkness: number): void {
    this.clock += frameDt;
    const seen = this.seen;
    seen.clear();
    this.headlight.intensity = 0;
    this.smoke.begin();
    const lightsOn = darkness > 0.25;
    for (const v of vehicles) {
      seen.add(v.id);
      const view = this.view(v);
      const c = v.car;
      const g = view.group;
      g.position.set(lerp(v.prevPos.x, c.pos.x, alpha), lerp(v.prevPos.y, c.pos.y, alpha), lerp(v.prevPos.z, c.pos.z, alpha));
      g.rotation.set(0, v.prevYaw + wrapAngle(c.yaw - v.prevYaw) * alpha, 0);
      // Tilt with the ground, plus a little body roll in corners and dive under braking.
      const lean = Math.max(-0.05, Math.min(0.05, c.yawRate * Math.hypot(c.vel.x, c.vel.z) * 0.004));
      view.body.rotation.set(c.pitch + (c.braking ? -0.015 : 0), 0, -c.roll - lean, 'YXZ');
      const driven = v.driver >= 0 && !v.destroyed;
      view.brake.visible = !v.destroyed && (c.braking || (driven && lightsOn));
      view.head.visible = driven && lightsOn;
      if (v.id === localCar && driven && lightsOn) this.aimHeadlight(g);
      if (v.destroyed || v.health < SMOKE_HEALTH) this.smokeFrom(v, g, time);
    }
    this.smoke.end();
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      this.root.remove(view.group);
      this.views.delete(id);
    }
  }

  private aimHeadlight(g: THREE.Group): void {
    const yaw = g.rotation.y;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    this.headlight.intensity = 60;
    this.headlight.position.set(g.position.x + fx * 2.1, g.position.y + 0.75, g.position.z + fz * 2.1);
    this.headlight.target.position.set(g.position.x + fx * 14, g.position.y - 0.4, g.position.z + fz * 14);
    this.headlight.target.updateMatrixWorld();
  }

  /** A column of puffs from under the bonnet: grey when damaged, black while burning. */
  private smokeFrom(v: Vehicle, g: THREE.Group, time: number): void {
    const burning = v.destroyed && time < v.burnUntil;
    const yaw = g.rotation.y;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const bx = g.position.x + fx * (v.destroyed ? 0 : CAR.wheelbase * 0.45);
    const bz = g.position.z + fz * (v.destroyed ? 0 : CAR.wheelbase * 0.45);
    const shade = burning ? 0.12 : v.destroyed ? 0.3 : 0.55;
    const n = v.destroyed && !burning ? PUFFS / 2 : PUFFS;
    for (let i = 0; i < n; i++) {
      const k = (this.clock * 0.45 + i / n + v.id * 0.37) % 1;
      const drift = k * k * 1.5;
      this.smoke.push(
        bx + Math.sin(i * 2.3 + v.id) * 0.25 + drift * 0.6,
        g.position.y + 1 + k * (burning ? 5 : 3),
        bz + Math.cos(i * 1.7) * 0.25 + drift * 0.3,
        0.6 + k * (burning ? 2.6 : 1.6),
        shade,
        shade,
        shade * 0.95,
        (1 - k) * (burning ? 0.7 : 0.45),
        i * 1.3 + k,
      );
    }
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const view of this.views.values()) {
      for (const c of view.body.children) {
        if (c === view.brake || c === view.head) continue;
        c.castShadow = on;
        c.receiveShadow = on;
      }
    }
  }

  dispose(): void {
    for (const m of this.models.values()) for (const p of m.parts) p.geometry.dispose();
    this.brakeGeo.dispose();
    this.headGeo.dispose();
    this.lightMat.brake.dispose();
    this.lightMat.head.dispose();
    this.smoke.mesh.geometry.dispose();
    this.smoke.mesh.material.dispose();
  }
}

/** Two small lamp quads at ±x, facing +Z (`facing` 1) or -Z (-1). */
function lampPair(x: number, y: number, z: number, w: number, h: number, facing: 1 | -1): THREE.BufferGeometry {
  const quads: number[] = [];
  const idx: number[] = [];
  for (const sx of [-1, 1]) {
    const cx = sx * x;
    const base = quads.length / 3;
    quads.push(cx - w / 2, y - h / 2, z, cx + w / 2, y - h / 2, z, cx + w / 2, y + h / 2, z, cx - w / 2, y + h / 2, z);
    if (facing > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(quads, 3));
  g.setIndex(idx);
  return g;
}
