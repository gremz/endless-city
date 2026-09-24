import * as THREE from 'three';
import { hash3, sfc32 } from '../core/rng';
import { smokeRadius, type GrenadeSystem } from '../sim/Grenades';
import { GRENADE_IDS, type GrenadeId } from '../weapons/weaponDefs';
import { Billboards, makePuffTexture, type Particles } from './fx/Effects';
import { getGunModel } from './viewmodel/gunMeshes';

const MAX_FLYING = 16;
const PUFFS_PER_SMOKE = 34;
const FLAMES_PER_FIRE = 26;
const FIRE_LIGHTS = 3;

interface Puff {
  /** Offset in units of the cloud radius. */
  x: number;
  y: number;
  z: number;
  size: number;
  rot: number;
  spin: number;
  shade: number;
}

/**
 * Draws what grenades leave in the world, straight from the simulation's state: flying grenades
 * (interpolated), smoke clouds sized exactly like the sight-blocking volume the bots use, and
 * molotov fires with flickering light. Holds no gameplay state of its own.
 */
export class GrenadeRenderer {
  readonly root = new THREE.Group();
  private flying = new Map<GrenadeId, THREE.InstancedMesh>();
  private smoke: Billboards;
  private flames: Billboards;
  private lights: THREE.PointLight[] = [];
  private puffCache = new Map<number, Puff[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private clock = 0;
  private emberAt = 0;
  /** Smoke tint; the atmosphere darkens it at night. */
  readonly smokeColor = new THREE.Color(0.8, 0.8, 0.78);

  constructor(private particles: Particles) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (const id of GRENADE_IDS) {
      const mesh = new THREE.InstancedMesh(getGunModel(id).geometry, mat, MAX_FLYING);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.name = `flying-${id}`;
      this.flying.set(id, mesh);
      this.root.add(mesh);
    }
    this.smoke = new Billboards(PUFFS_PER_SMOKE * 12, makePuffTexture(3), false);
    this.smoke.mesh.renderOrder = 2;
    this.flames = new Billboards(FLAMES_PER_FIRE * 8, makePuffTexture(7), true);
    this.flames.mesh.renderOrder = 3;
    this.root.add(this.smoke.mesh, this.flames.mesh);
    for (let i = 0; i < FIRE_LIGHTS; i++) {
      // Always in the scene so toggling them never recompiles shaders.
      const l = new THREE.PointLight('#ff8a33', 0, 10, 2);
      this.lights.push(l);
      this.root.add(l);
    }
  }

  private puffs(id: number): Puff[] {
    let list = this.puffCache.get(id);
    if (!list) {
      const r = sfc32(hash3(id, 77, 5, 0));
      list = [];
      for (let i = 0; i < PUFFS_PER_SMOKE; i++) {
        // Spread through a squashed sphere, denser near the ground.
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * 0.75;
        list.push({
          x: Math.cos(a) * d,
          y: (r() - 0.35) * 0.9,
          z: Math.sin(a) * d,
          size: 1.1 + r() * 0.7,
          rot: r() * Math.PI * 2,
          spin: (r() - 0.5) * 0.3,
          shade: 0.85 + r() * 0.15,
        });
      }
      this.puffCache.set(id, list);
    }
    return list;
  }

  update(g: GrenadeSystem, alpha: number, simTime: number, frameDt: number, camPos: THREE.Vector3): void {
    this.clock += frameDt;

    // Flying grenades, tumbling as they go.
    const counts = new Map<GrenadeId, number>();
    for (const p of g.projectiles) {
      const mesh = this.flying.get(p.kind)!;
      const k = counts.get(p.kind) ?? 0;
      if (k >= MAX_FLYING) continue;
      counts.set(p.kind, k + 1);
      this.v.set(p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha, p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha, p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha);
      const moving = p.restTime < 0;
      const spin = moving ? (simTime - p.spawnTime) * 9 : 0;
      this.q.setFromEuler(this.e.set(spin, p.id, moving ? spin * 0.5 : Math.PI / 2));
      this.m.compose(this.v, this.q, this.s);
      mesh.setMatrixAt(k, this.m);
    }
    for (const [id, mesh] of this.flying) {
      mesh.count = counts.get(id) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Smoke.
    this.smoke.begin();
    const c = this.smokeColor;
    for (const s of g.smokes) {
      const r = smokeRadius(s, simTime);
      if (r <= 0) continue;
      const age = simTime - s.start;
      const left = s.end - simTime;
      const alpha = Math.min(1, age * 3) * Math.min(1, left / 2.5);
      for (const p of this.puffs(s.id)) {
        // Drift up and out slowly as the cloud ages.
        const drift = 1 + Math.min(0.25, age * 0.015);
        this.smoke.push(
          s.pos.x + p.x * r * drift,
          s.pos.y + p.y * r + age * 0.02,
          s.pos.z + p.z * r * drift,
          r * p.size,
          c.r * p.shade,
          c.g * p.shade,
          c.b * p.shade,
          alpha,
          p.rot + age * p.spin,
        );
      }
    }
    this.smoke.end();
    // Drop cached puff layouts for clouds that are gone.
    if (this.puffCache.size > g.smokes.length + 4) {
      const live = new Set(g.smokes.map((s) => s.id));
      for (const id of this.puffCache.keys()) if (!live.has(id)) this.puffCache.delete(id);
    }

    // Fire: flickering flame sprites over the burning disc, embers and a few lights.
    this.flames.begin();
    const fires = [...g.fires].sort(
      (a, b) => Math.hypot(a.pos.x - camPos.x, a.pos.z - camPos.z) - Math.hypot(b.pos.x - camPos.x, b.pos.z - camPos.z),
    );
    const t = this.clock;
    const ember = t - this.emberAt > 0.08;
    if (ember) this.emberAt = t;
    for (const f of fires) {
      const age = simTime - f.start;
      const life = Math.min(1, age * 4) * Math.min(1, (f.end - simTime) / 1.2);
      const spread = f.radius * Math.min(1, 0.4 + age * 1.5);
      const r = sfc32(hash3(f.id, 91, 3, 0));
      for (let i = 0; i < FLAMES_PER_FIRE; i++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * spread;
        const phase = r() * 10;
        const speed = 2.5 + r() * 2;
        // Each flame loops: rises and shrinks, then restarts.
        const k = (t * speed * 0.35 + phase) % 1;
        const h = 0.25 + k * 0.9;
        const size = (0.55 + r() * 0.35) * (1 - k * 0.7) * life;
        this.flames.push(f.pos.x + Math.cos(a) * d, f.pos.y + h * 0.6, f.pos.z + Math.sin(a) * d, size, 1, 0.45 + (1 - k) * 0.25, 0.12, (1 - k) * 0.85 * life, phase);
      }
      if (ember && life > 0.3) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * spread;
        this.particles.embers({ x: f.pos.x + Math.cos(a) * d, y: f.pos.y + 0.3, z: f.pos.z + Math.sin(a) * d }, 1);
      }
    }
    this.flames.end();
    for (let i = 0; i < FIRE_LIGHTS; i++) {
      const l = this.lights[i];
      const f = fires[i];
      if (!f) {
        l.intensity = 0;
        continue;
      }
      const life = Math.min(1, (simTime - f.start) * 4) * Math.min(1, (f.end - simTime) / 1.2);
      l.position.set(f.pos.x, f.pos.y + 0.8, f.pos.z);
      l.intensity = (7 + Math.sin(t * 23 + i) * 1.5 + Math.sin(t * 37 + i * 2) * 1.2) * life;
    }
  }

  dispose(): void {
    for (const m of this.flying.values()) m.dispose();
    this.smoke.mesh.geometry.dispose();
    this.smoke.mesh.material.dispose();
    this.flames.mesh.geometry.dispose();
    this.flames.mesh.material.dispose();
  }
}
