import * as THREE from 'three';
import type { Vec3 } from '../../core/math';
import { Material } from '../../world/gen/ChunkData';

// ---------------------------------------------------------------- tracers

const TRACER_SPEED = 420;
const TRACER_LEN = 5;

interface Tracer {
  sx: number;
  sy: number;
  sz: number;
  dx: number;
  dy: number;
  dz: number;
  dist: number;
  age: number;
  active: boolean;
}

/** Bullet streaks: a pooled InstancedMesh of thin boxes flying from muzzle to impact. */
export class Tracers {
  readonly mesh: THREE.InstancedMesh;
  private pool: Tracer[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private fwd = new THREE.Vector3(0, 0, 1);
  private dir = new THREE.Vector3();
  private next = 0;

  constructor(max = 48) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, -0.5);
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffd98a',
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < max; i++) {
      this.pool.push({ sx: 0, sy: 0, sz: 0, dx: 0, dy: 0, dz: 0, dist: 0, age: 0, active: false });
    }
  }

  spawn(from: Vec3, to: Vec3): void {
    const t = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1) return;
    t.sx = from.x;
    t.sy = from.y;
    t.sz = from.z;
    t.dx = dx / d;
    t.dy = dy / d;
    t.dz = dz / d;
    t.dist = d;
    t.age = 0;
    t.active = true;
  }

  update(dt: number): void {
    let n = 0;
    for (const t of this.pool) {
      if (!t.active) continue;
      t.age += dt;
      const head = t.age * TRACER_SPEED;
      const tail = Math.max(0, head - TRACER_LEN);
      if (tail >= t.dist) {
        t.active = false;
        continue;
      }
      const h = Math.min(head, t.dist);
      const len = h - tail;
      this.p.set(t.sx + t.dx * h, t.sy + t.dy * h, t.sz + t.dz * h);
      // Local +Z points along the flight path, so the box (which extends along local -Z
      // from its origin at the head) trails behind the head towards the muzzle.
      this.dir.set(t.dx, t.dy, t.dz);
      this.q.setFromUnitVectors(this.fwd, this.dir);
      this.s.set(0.012, 0.012, len);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- decals

function makeHoleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(10,10,10,1)');
  g.addColorStop(0.28, 'rgba(20,18,16,0.95)');
  g.addColorStop(0.45, 'rgba(60,55,50,0.55)');
  g.addColorStop(1, 'rgba(60,55,50,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Bullet holes: a ring buffer of instanced quads aligned to the hit surface. */
export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private keys: Int32Array;
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private n = new THREE.Vector3();
  private z = new THREE.Vector3(0, 0, 1);
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(private max = 256) {
    const mat = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.keys = new Int32Array(max).fill(-1);
  }

  add(pos: Vec3, normal: Vec3, chunkKey: number, size = 0.07): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.n.set(normal.x, normal.y, normal.z).normalize();
    this.q.setFromUnitVectors(this.z, this.n);
    this.q2.setFromAxisAngle(this.z, Math.random() * Math.PI * 2);
    this.q.multiply(this.q2);
    this.p.set(pos.x + this.n.x * 0.004, pos.y + this.n.y * 0.004, pos.z + this.n.z * 0.004);
    this.s.set(size, size, size);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.keys[i] = chunkKey;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Hide decals on an unloaded chunk. */
  removeChunk(key: number): void {
    let changed = false;
    for (let i = 0; i < this.max; i++) {
      if (this.keys[i] === key) {
        this.mesh.setMatrixAt(i, this.hidden);
        this.keys[i] = -1;
        changed = true;
      }
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- particles

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  r: number;
  g: number;
  b: number;
  gravity: number;
}

const IMPACT_COLORS: Record<number, [number, number, number]> = {
  [Material.Concrete]: [0.62, 0.6, 0.56],
  [Material.Plaster]: [0.78, 0.7, 0.55],
  [Material.Brick]: [0.55, 0.3, 0.22],
  [Material.Asphalt]: [0.3, 0.3, 0.3],
  [Material.Sidewalk]: [0.65, 0.64, 0.6],
  [Material.Crate]: [0.55, 0.38, 0.18],
  [Material.Wood]: [0.5, 0.34, 0.16],
  [Material.Metal]: [1, 0.85, 0.5],
  [Material.Dev]: [0.7, 0.68, 0.64],
  [Material.Paint]: [0.3, 0.3, 0.3],
  [Material.CarPaint]: [1, 0.85, 0.5],
  [Material.CarGlass]: [0.8, 0.9, 1],
  [Material.CarWheel]: [0.18, 0.18, 0.18],
  [Material.CarTrim]: [0.4, 0.4, 0.4],
  [Material.Glass]: [0.8, 0.92, 1],
};

/** Impact dust, sparks and blood: one Points object with CPU-simulated particles. */
export class Particles {
  readonly points: THREE.Points;
  private parts: Particle[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private next = 0;

  constructor(private max = 512) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size: 0.06,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    for (let i = 0; i < max; i++) {
      this.parts.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, r: 1, g: 1, b: 1, gravity: 9 });
    }
  }

  private emit(pos: Vec3, dirX: number, dirY: number, dirZ: number, count: number, speed: number, spread: number, color: [number, number, number], life: number, gravity: number) {
    for (let i = 0; i < count; i++) {
      const p = this.parts[this.next];
      this.next = (this.next + 1) % this.max;
      p.x = pos.x;
      p.y = pos.y;
      p.z = pos.z;
      const s = speed * (0.4 + Math.random() * 0.8);
      p.vx = (dirX + (Math.random() - 0.5) * spread) * s;
      p.vy = (dirY + (Math.random() - 0.5) * spread) * s;
      p.vz = (dirZ + (Math.random() - 0.5) * spread) * s;
      p.life = p.max = life * (0.6 + Math.random() * 0.8);
      const v = 0.85 + Math.random() * 0.3;
      p.r = color[0] * v;
      p.g = color[1] * v;
      p.b = color[2] * v;
      p.gravity = gravity;
    }
  }

  impact(pos: Vec3, normal: Vec3, material: number): void {
    const c = IMPACT_COLORS[material] ?? IMPACT_COLORS[Material.Concrete];
    if (material === Material.Metal || material === Material.CarPaint) {
      this.emit(pos, normal.x, normal.y, normal.z, 7, 5, 1.6, c, 0.25, 12);
    } else {
      this.emit(pos, normal.x, normal.y, normal.z, 9, 2.2, 1.3, c, 0.5, 5);
    }
  }

  blood(pos: Vec3, dirX: number, dirY: number, dirZ: number, heavy: boolean): void {
    this.emit(pos, dirX, dirY, dirZ, heavy ? 16 : 9, 1.8, 1.4, [0.55, 0.04, 0.03], 0.45, 7);
  }

  /** HE blast: hot sparks and a ring of dust and grit. */
  explosion(pos: Vec3): void {
    this.emit(pos, 0, 0.8, 0, 40, 9, 2.2, [1, 0.72, 0.3], 0.5, 9);
    this.emit(pos, 0, 0.4, 0, 50, 4, 2.4, [0.45, 0.42, 0.38], 1.1, 6);
  }

  /** Molotov bottle breaking. */
  glass(pos: Vec3): void {
    this.emit(pos, 0, 0.6, 0, 18, 3, 2, [0.75, 0.55, 0.3], 0.5, 9);
    this.emit(pos, 0, 0.9, 0, 14, 2.5, 1.6, [1, 0.6, 0.2], 0.4, -1);
  }

  /** A window shattering: glittering shards falling from the pane. */
  shards(pos: Vec3): void {
    this.emit(pos, 0, 0.3, 0, 40, 2.4, 2.2, [0.85, 0.95, 1], 0.9, 9);
  }

  /** A door bursting: splinters. */
  splinters(pos: Vec3): void {
    this.emit(pos, 0, 0.2, 0, 34, 3.5, 2.4, IMPACT_COLORS[Material.Wood], 0.8, 8);
  }

  /** Flashbang pop: a burst of white sparks. */
  flashPop(pos: Vec3): void {
    this.emit(pos, 0, 0, 0, 24, 6, 2.2, [1, 1, 0.95], 0.25, 2);
  }

  /** Raindrop hitting the ground. */
  splash(pos: Vec3): void {
    this.emit(pos, 0, 1, 0, 3, 1.2, 1.6, [0.72, 0.78, 0.86], 0.18, 9);
  }

  /** Embers rising from a fire. */
  embers(pos: Vec3, count: number): void {
    this.emit(pos, 0, 1, 0, count, 1.2, 1.2, [1, 0.55, 0.15], 0.9, -1.5);
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      const p = this.parts[i];
      const o3 = i * 3;
      const o4 = i * 4;
      if (p.life <= 0) {
        this.col[o4 + 3] = 0;
        continue;
      }
      p.life -= dt;
      p.vy -= p.gravity * dt;
      p.vx *= 1 - dt * 2;
      p.vz *= 1 - dt * 2;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      this.pos[o3] = p.x;
      this.pos[o3 + 1] = p.y;
      this.pos[o3 + 2] = p.z;
      this.col[o4] = p.r;
      this.col[o4 + 1] = p.g;
      this.col[o4 + 2] = p.b;
      this.col[o4 + 3] = Math.max(0, p.life / p.max);
    }
    const geo = this.points.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('color').needsUpdate = true;
  }
}

// ---------------------------------------------------------------- muzzle light + world flashes

/** A point light that is always in the scene (intensity 0 when idle) to avoid shader recompiles. */
export class MuzzleLight {
  readonly light = new THREE.PointLight('#ffb561', 0, 9, 2);
  private until = 0;
  private clock = 0;

  flash(x: number, y: number, z: number, strength = 1, duration = 0.045, range = 9): void {
    this.light.position.set(x, y, z);
    this.until = this.clock + duration;
    this.light.intensity = 14 * strength;
    this.light.distance = range;
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.clock > this.until) this.light.intensity = 0;
  }
}

// ---------------------------------------------------------------- billboards

const BILLBOARD_VERT = /* glsl */ `
attribute vec4 aOffset; // xyz position, w size
attribute vec4 aColor;  // rgb, a alpha
attribute float aRot;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(aOffset.xyz, 1.0);
  float c = cos(aRot);
  float s = sin(aRot);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  mvPosition.xy += p * aOffset.w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BILLBOARD_FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * tex.rgb, vColor.a * tex.a);
  if (gl_FragColor.a < 0.004) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Camera-facing quads drawn in one call (smoke puffs, flames). Fill each frame between begin()
 * and end(); positions are world space.
 */
export class Billboards {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private offset: Float32Array;
  private color: Float32Array;
  private rot: Float32Array;
  private n = 0;

  constructor(
    private max: number,
    map: THREE.Texture,
    additive: boolean,
  ) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.offset = new Float32Array(max * 4);
    this.color = new Float32Array(max * 4);
    this.rot = new Float32Array(max);
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(this.offset, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aRot', new THREE.InstancedBufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    mat.uniforms.map.value = map;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, rot = 0): void {
    if (this.n >= this.max || a <= 0.002) return;
    const i = this.n++;
    this.offset[i * 4] = x;
    this.offset[i * 4 + 1] = y;
    this.offset[i * 4 + 2] = z;
    this.offset[i * 4 + 3] = size;
    this.color[i * 4] = r;
    this.color[i * 4 + 1] = g;
    this.color[i * 4 + 2] = b;
    this.color[i * 4 + 3] = a;
    this.rot[i] = rot;
  }

  end(): void {
    const geo = this.mesh.geometry;
    geo.instanceCount = this.n;
    for (const name of ['aOffset', 'aColor', 'aRot']) {
      const attr = geo.getAttribute(name) as THREE.InstancedBufferAttribute;
      attr.needsUpdate = true;
      attr.addUpdateRange(0, this.n * attr.itemSize);
    }
    this.mesh.visible = this.n > 0;
  }
}

/** Soft cloudy puff for smoke and flames: radial falloff broken up with a little noise. */
export function makePuffTexture(seed = 1): THREE.CanvasTexture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  // A few overlapping blobs make the puff lumpy rather than a perfect disc.
  const blobs = Array.from({ length: 6 }, () => [0.5 + (rnd() - 0.5) * 0.35, 0.5 + (rnd() - 0.5) * 0.35, 0.22 + rnd() * 0.16]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let a = 0;
      for (const [bx, by, br] of blobs) {
        const d = Math.hypot(u - bx, v - by) / br;
        a = Math.max(a, 1 - d * d);
      }
      const edge = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 2);
      a = Math.max(0, Math.min(1, a * edge * 1.9)) * (0.85 + rnd() * 0.15);
      const shade = 0.82 + 0.18 * (1 - v);
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(255 * shade);
      img.data[o + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
