import * as THREE from 'three';
import type { Particles } from './Effects';

const MAX_DROPS = 1800;
const RADIUS = 16;
const FALL_SPEED = 14;
const DROP_LEN = 0.55;
/** Roof height cache cell size (m). */
const CELL = 1;

interface Drop {
  x: number;
  y: number;
  z: number;
  /** Height this drop stops at (roof or ground below it). */
  floor: number;
  active: boolean;
}

/**
 * Rain: streaks falling in a cylinder around the camera. Each 1 m column remembers the first
 * surface below the sky (a downward trace, cached), so rain stops on roofs and never falls
 * inside buildings. Drops that land near the camera splash.
 */
export class Weather {
  readonly mesh: THREE.InstancedMesh;
  private drops: Drop[] = [];
  private roofs = new Map<number, number>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private windX = 0.9;
  private windZ = 0.35;
  private splashBudget = 0;
  /** 0..1 particle amount from settings. */
  density = 1;

  constructor(
    /** Height of the first surface below the sky at (x, z), or -Infinity if there is none. */
    private roofAt: (x: number, z: number) => number,
    private particles: Particles,
  ) {
    const geo = new THREE.BoxGeometry(0.012, DROP_LEN, 0.012);
    const mat = new THREE.MeshBasicMaterial({ color: '#b9c6d6', transparent: true, opacity: 0.38, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_DROPS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'rain';
    for (let i = 0; i < MAX_DROPS; i++) this.drops.push({ x: 0, y: -1e9, z: 0, floor: 0, active: false });
    // Streaks lean with the wind.
    const dir = new THREE.Vector3(this.windX, -FALL_SPEED, this.windZ).normalize();
    this.q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  }

  /** Forget cached roof heights (chunks loaded or unloaded). */
  resetRoofs(): void {
    this.roofs.clear();
  }

  private roof(x: number, z: number): number {
    const gx = Math.floor(x / CELL);
    const gz = Math.floor(z / CELL);
    const key = gx * 100003 + gz;
    let h = this.roofs.get(key);
    if (h === undefined) {
      h = this.roofAt((gx + 0.5) * CELL, (gz + 0.5) * CELL);
      if (this.roofs.size > 40000) this.roofs.clear();
      this.roofs.set(key, h);
    }
    return h;
  }

  private spawn(d: Drop, cam: THREE.Vector3, anywhere: boolean): void {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * RADIUS;
    d.x = cam.x + Math.cos(a) * r;
    d.z = cam.z + Math.sin(a) * r;
    const top = cam.y + 9 + Math.random() * 6;
    d.y = anywhere ? cam.y - 6 + Math.random() * 21 : top;
    d.floor = Math.max(this.roof(d.x, d.z), cam.y - 12);
    // Under a roof taller than the rain top: no drop in this column this time.
    d.active = d.floor < top;
  }

  update(rain: number, dt: number, cam: THREE.Vector3): void {
    const want = Math.floor(MAX_DROPS * Math.min(1, rain) * this.density);
    if (want === 0 && this.mesh.count === 0) return;
    const drops = this.drops;
    const fall = FALL_SPEED * dt;
    this.splashBudget = Math.min(6, this.splashBudget + dt * 40 * rain);
    let n = 0;
    for (let i = 0; i < want; i++) {
      const d = drops[i];
      if (!d.active || d.y < d.floor || Math.hypot(d.x - cam.x, d.z - cam.z) > RADIUS + 2) {
        const landed = d.active && d.y < d.floor;
        if (landed && this.splashBudget >= 1 && Math.hypot(d.x - cam.x, d.z - cam.z) < 8) {
          this.splashBudget--;
          this.particles.splash({ x: d.x, y: d.floor + 0.02, z: d.z });
        }
        this.spawn(d, cam, !d.active && d.y === -1e9);
        if (!d.active) continue;
      }
      d.y -= fall;
      d.x += this.windX * dt;
      d.z += this.windZ * dt;
      if (d.y < d.floor) continue;
      // Streaks right at the lens read as big white bars: skip them.
      if (Math.abs(d.x - cam.x) < 1.2 && Math.abs(d.z - cam.z) < 1.2) continue;
      this.p.set(d.x, d.y + DROP_LEN * 0.5, d.z);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    // Drops beyond the current amount start fresh next time rain picks up.
    for (let i = want; i < MAX_DROPS; i++) {
      drops[i].active = false;
      drops[i].y = -1e9;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
