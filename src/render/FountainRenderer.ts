import * as THREE from 'three';
import { FOUNTAIN_STRIDE, type ChunkData } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';

/** Spray droplets alive at once (all fountains). */
const MAX_DROPS = 2400;
/** Splash rings alive at once. */
const MAX_RINGS = 160;
/** Fountains farther than this from the camera stop spraying (their water still ripples). */
const EMIT_DIST = 60;
const JET_RATE = 170;
/** Cascade droplets per second per meter of bowl lip. */
const CASCADE_RATE = 40;
const GRAVITY = 9.8;
const RING_LIFE = 0.7;

/** Per-droplet floats: x y z, vx vy vz, fountain x z, bowl inner half, bowl water, basin water, splashes. */
const D = 12;

interface Fountain {
  x: number;
  z: number;
  half: number;
  waterY: number;
  bowlHalf: number;
  bowlY: number;
  spoutY: number;
  jetAcc: number;
  cascadeAcc: number;
}

interface ChunkFountains {
  group: THREE.Group;
  list: Fountain[];
  visible: boolean;
}

const SURFACE_VERT_HEAD = /* glsl */ `
varying vec2 vLocal;
`;
const SURFACE_FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform float uRing;
uniform vec3 uSky;
varying vec2 vLocal;
// Surface height: ripples running out from where the water lands, plus a little chop.
float fh(vec2 p) {
  float d = length(p);
  float r = max(d - uRing, 0.0);
  float wob = sin(atan(p.y, p.x) * 5.0 + uTime * 0.7) * 0.6;
  float rings = sin(r * 10.0 - uTime * 7.5 + wob) * exp(-r * 0.7) * 0.045;
  float chop = sin(p.x * 3.1 + uTime * 1.7) * 0.01 + sin(p.y * 2.7 - uTime * 1.3) * 0.01
    + sin((p.x + p.y) * 6.3 + uTime * 3.1) * 0.006 + sin((p.x - p.y) * 9.7 - uTime * 4.3) * 0.004;
  return rings + chop;
}
`;

/** Lit, see-through water whose normals ripple (a Phong material with the normal bent per pixel). */
function surfaceMaterial(time: THREE.IUniform<number>, sky: THREE.IUniform<THREE.Color>, ring: number): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({
    color: '#3d7482',
    specular: '#d8ecf0',
    shininess: 90,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uRing = { value: ring };
    shader.uniforms.uSky = sky;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SURFACE_VERT_HEAD}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURFACE_FRAG_HEAD}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        // Churned white water where the jet or the cascade comes down.
        float foam = smoothstep(0.22, 0.0, abs(length(vLocal) - uRing)) * (0.35 + 0.2 * sin(uTime * 11.0 + vLocal.x * 13.0 + vLocal.y * 7.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.92, 0.94), foam);
        diffuseColor.a = mix(diffuseColor.a, 0.95, foam);`,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `// Glancing views mirror the sky.
        float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
        outgoingLight = mix(outgoingLight, uSky, fres * 0.65);
        #include <opaque_fragment>`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `#include <normal_fragment_begin>
        {
          float e = 0.03;
          float h0 = fh(vLocal);
          vec3 nW = normalize(vec3(-(fh(vLocal + vec2(e, 0.0)) - h0) / e, 1.0, -(fh(vLocal + vec2(0.0, e)) - h0) / e));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'fountain-water';
  return m;
}

/** The sheet of water spilling over the bowl's lip: streaks scrolling down a translucent skirt. */
function sheetMaterial(time: THREE.IUniform<number>): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: '#cfe6ee', transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSheet;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSheet = uv;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vSheet;').replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
      {
        // u: meters along the lip, v: 0 at the lip .. 1 at the basin.
        float u = vSheet.x;
        float v = vSheet.y;
        float strands = 0.5 + 0.5 * sin(u * 29.0 + sin(u * 7.3) * 2.5);
        float flow = 0.5 + 0.5 * sin(v * 11.0 - uTime * 10.0 + u * 4.0 + strands * 2.0);
        float a = (0.16 + 0.5 * strands * flow) * smoothstep(0.0, 0.06, v) * (1.0 - smoothstep(0.8, 1.0, v) * 0.6);
        diffuseColor.a *= a;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'fountain-sheet';
  return m;
}

/** Four sloped quads hanging off a square lip (outer half-size `a`) from y0 down to y1, flaring out by `flare`. */
function sheetGeometry(a: number, y0: number, y1: number, flare: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const b = a + flare;
  // Corners in order around the square; each side runs from corner i to corner i+1.
  const top = [
    [-a, -a],
    [a, -a],
    [a, a],
    [-a, a],
  ];
  const bot = [
    [-b, -b],
    [b, -b],
    [b, b],
    [-b, b],
  ];
  let u0 = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const n = pos.length / 3;
    const len = 2 * a;
    pos.push(top[i][0], y0, top[i][1], top[j][0], y0, top[j][1], bot[j][0], y1, bot[j][1], bot[i][0], y1, bot[i][1]);
    uv.push(u0, 0, u0 + len, 0, u0 + len, 1, u0, 1);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    u0 += len;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

function surfaceGeometry(half: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(half * 2, half * 2);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * Fountain water (see cityFeatures.fountain): rippling surfaces in the basin and the bowl, the
 * sheet spilling over the bowl's lip, and CPU-simulated spray: the jet arcing up out of the spout
 * into the bowl and droplets falling off the lip into the basin, splashing rings where they land.
 */
export class FountainRenderer implements StreamerListener {
  readonly root = new THREE.Group();
  /** 0..1 spray amount (the particle setting). */
  density = 1;
  private chunks = new Map<number, ChunkFountains>();
  private time = { value: 0 };
  private sky = { value: new THREE.Color() };
  private sheetMat: THREE.MeshBasicMaterial;
  private surfaceMats: THREE.MeshPhongMaterial[] = [];
  private drops: THREE.InstancedMesh;
  private dropMat: THREE.MeshBasicMaterial;
  private d = new Float32Array(MAX_DROPS * D);
  private count = 0;
  private rings: THREE.InstancedMesh;
  private ringMat: THREE.MeshBasicMaterial;
  /** Per ring: x, y, z, age (age >= RING_LIFE is free). */
  private r = new Float32Array(MAX_RINGS * 4);
  private nextRing = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private v = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private c = new THREE.Color();

  constructor() {
    this.root.name = 'fountains';
    this.sheetMat = sheetMaterial(this.time);

    this.dropMat = new THREE.MeshBasicMaterial({ color: '#dcedf3', transparent: true, opacity: 0.6, depthWrite: false });
    this.drops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 1, 0.03), this.dropMat, MAX_DROPS);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.frustumCulled = false;
    this.drops.count = 0;
    this.drops.name = 'fountain spray';
    this.root.add(this.drops);

    const ringGeo = new THREE.RingGeometry(0.8, 1, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.rings = new THREE.InstancedMesh(ringGeo, this.ringMat, MAX_RINGS);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.rings.renderOrder = 1;
    for (let i = 0; i < MAX_RINGS; i++) {
      this.r[i * 4 + 3] = RING_LIFE;
      this.rings.setColorAt(i, this.c.setRGB(0, 0, 0));
    }
    this.root.add(this.rings);
  }

  onChunkLoaded(data: ChunkData, visible: boolean): void {
    this.onChunkUnloaded(data.key);
    const f = data.fountains;
    if (!f || f.length === 0) return;
    const group = new THREE.Group();
    group.visible = visible;
    const list: Fountain[] = [];
    for (let o = 0; o + FOUNTAIN_STRIDE <= f.length; o += FOUNTAIN_STRIDE) {
      const [x, z, half, waterY, bowlHalf, bowlY, spoutY] = f.subarray(o, o + FOUNTAIN_STRIDE);
      list.push({ x, z, half, waterY, bowlHalf, bowlY, spoutY, jetAcc: 0, cascadeAcc: 0 });
      // Cascade lands just outside the lip; the jet lands a little way out from the spout.
      const lip = bowlHalf + 0.24;
      const basin = new THREE.Mesh(surfaceGeometry(half), this.surfaceMaterial(lip + 0.2));
      basin.position.set(x, waterY, z);
      const bowl = new THREE.Mesh(surfaceGeometry(bowlHalf), this.surfaceMaterial(0.35));
      bowl.position.set(x, bowlY, z);
      const sheet = new THREE.Mesh(sheetGeometry(lip + 0.01, bowlY + 0.07, waterY, 0.22), this.sheetMat);
      sheet.position.set(x, 0, z);
      sheet.renderOrder = 1;
      for (const mesh of [basin, bowl, sheet]) {
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
      }
    }
    this.chunks.set(data.key, { group, list, visible });
    this.root.add(group);
  }

  onChunkUnloaded(key: number): void {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const child of c.group.children) (child as THREE.Mesh).geometry.dispose();
    this.root.remove(c.group);
    this.chunks.delete(key);
  }

  onChunkVisibility(key: number, visible: boolean): void {
    const c = this.chunks.get(key);
    if (!c) return;
    c.visible = visible;
    c.group.visible = visible;
  }

  /** Distance from (x, y, z) to the nearest visible fountain's spout (Infinity if there is none). */
  nearest(x: number, y: number, z: number): number {
    let best = Infinity;
    for (const c of this.chunks.values()) {
      if (!c.visible) continue;
      for (const f of c.list) best = Math.min(best, Math.hypot(f.x - x, f.spoutY - 1 - y, f.z - z));
    }
    return best;
  }

  /** Advance the water: `t` seconds of clock, `dt` frame step, `light` 0 (night) .. 1 (day). */
  update(t: number, dt: number, cam: THREE.Vector3, light: number): void {
    this.time.value = t;
    dt = Math.min(dt, 0.05);
    const shade = 0.12 + 0.88 * light;
    this.sky.value.setRGB(0.55 * shade, 0.68 * shade, 0.8 * shade);
    this.dropMat.color.setRGB(0.86 * shade, 0.93 * shade, 0.95 * shade);
    this.sheetMat.color.setRGB(0.81 * shade, 0.9 * shade, 0.93 * shade);

    for (const c of this.chunks.values()) {
      if (!c.visible) continue;
      for (const f of c.list) {
        if (Math.hypot(f.x - cam.x, f.z - cam.z) > EMIT_DIST) continue;
        f.jetAcc += dt * JET_RATE * this.density;
        for (; f.jetAcc >= 1; f.jetAcc--) this.jet(f);
        f.cascadeAcc += dt * CASCADE_RATE * 8 * (f.bowlHalf + 0.24) * this.density;
        for (; f.cascadeAcc >= 1; f.cascadeAcc--) this.cascade(f);
      }
    }

    this.simulate(dt);
    this.updateRings(dt, shade);
  }

  private surfaceMaterial(ring: number): THREE.MeshPhongMaterial {
    // One material per landing radius; they all share the one compiled program and clock.
    const key = Math.round(ring * 100);
    const found = this.surfaceMats.find((m) => m.userData.ring === key);
    if (found) return found;
    const m = surfaceMaterial(this.time, this.sky, ring);
    m.userData.ring = key;
    this.surfaceMats.push(m);
    return m;
  }

  private spawn(f: Fountain, x: number, y: number, z: number, vx: number, vy: number, vz: number, splashes: boolean): void {
    if (this.count >= MAX_DROPS) return;
    this.d.set([x, y, z, vx, vy, vz, f.x, f.z, f.bowlHalf, f.bowlY, f.waterY, splashes ? 1 : 0], this.count * D);
    this.count++;
  }

  private jet(f: Fountain): void {
    const a = Math.random() * Math.PI * 2;
    const out = 0.2 + Math.random() * 0.4;
    const up = 3.6 + Math.random() * 0.9;
    this.spawn(f, f.x + Math.cos(a) * 0.03, f.spoutY, f.z + Math.sin(a) * 0.03, Math.cos(a) * out, up, Math.sin(a) * out, true);
  }

  private cascade(f: Fountain): void {
    const edge = f.bowlHalf + 0.26;
    const along = (Math.random() * 2 - 1) * edge;
    const side = Math.floor(Math.random() * 4);
    const out = 0.25 + Math.random() * 0.35;
    const [x, z, vx, vz] = side === 0 ? [along, -edge, 0, -out] : side === 1 ? [along, edge, 0, out] : side === 2 ? [-edge, along, -out, 0] : [edge, along, out, 0];
    this.spawn(f, f.x + x, f.bowlY + 0.07 - Math.random() * 0.1, f.z + z, vx, -Math.random() * 0.3, vz, Math.random() < 0.5);
  }

  private simulate(dt: number): void {
    const d = this.d;
    let i = 0;
    while (i < this.count) {
      const o = i * D;
      const y0 = d[o + 1];
      d[o + 4] -= GRAVITY * dt;
      d[o] += d[o + 3] * dt;
      d[o + 1] += d[o + 4] * dt;
      d[o + 2] += d[o + 5] * dt;
      const x = d[o];
      const y = d[o + 1];
      const z = d[o + 2];
      let hit = NaN;
      if (d[o + 4] < 0) {
        const bh = d[o + 8];
        const bowlY = d[o + 9];
        if (Math.abs(x - d[o + 6]) < bh && Math.abs(z - d[o + 7]) < bh && y0 >= bowlY && y < bowlY) hit = bowlY;
        else if (y < d[o + 10]) hit = d[o + 10];
      }
      if (Number.isNaN(hit)) {
        i++;
        continue;
      }
      if (d[o + 11] > 0) {
        if (Math.random() < 0.18) this.ring(x, hit, z);
        if (Math.random() < 0.3) {
          // A bead kicked back up off the surface.
          const a = Math.random() * Math.PI * 2;
          const s = Math.random() * 0.5;
          const cx = d[o + 6];
          const cz = d[o + 7];
          const bh = d[o + 8];
          const bowlY = d[o + 9];
          const water = d[o + 10];
          this.count--;
          d.copyWithin(o, this.count * D, this.count * D + D);
          if (this.count < MAX_DROPS) {
            d.set([x, hit + 0.01, z, Math.cos(a) * s, 0.8 + Math.random() * 0.8, Math.sin(a) * s, cx, cz, bh, bowlY, water, 0], this.count * D);
            this.count++;
          }
          continue;
        }
      }
      // Swap-remove.
      this.count--;
      d.copyWithin(o, this.count * D, this.count * D + D);
    }

    for (let k = 0; k < this.count; k++) {
      const o = k * D;
      this.v.set(d[o + 3], d[o + 4], d[o + 5]);
      const speed = this.v.length();
      this.q.setFromUnitVectors(this.up, this.v.divideScalar(speed || 1));
      this.s.set(1, Math.min(0.24, 0.05 + speed * 0.045), 1);
      this.m.compose(this.p.set(d[o], d[o + 1], d[o + 2]), this.q, this.s);
      this.drops.setMatrixAt(k, this.m);
    }
    this.drops.count = this.count;
    this.drops.instanceMatrix.needsUpdate = true;
  }

  private ring(x: number, y: number, z: number): void {
    const o = this.nextRing * 4;
    this.r.set([x, y + 0.012, z, 0], o);
    this.nextRing = (this.nextRing + 1) % MAX_RINGS;
  }

  private updateRings(dt: number, shade: number): void {
    const r = this.r;
    let n = 0;
    for (let i = 0; i < MAX_RINGS; i++) {
      const o = i * 4;
      if (r[o + 3] >= RING_LIFE) continue;
      r[o + 3] += dt;
      const k = Math.min(1, r[o + 3] / RING_LIFE);
      const size = 0.06 + k * 0.32;
      this.m.compose(this.p.set(r[o], r[o + 1], r[o + 2]), this.q.identity(), this.s.set(size, 1, size));
      this.rings.setMatrixAt(n, this.m);
      const a = (1 - k) * 0.35 * shade;
      this.rings.setColorAt(n, this.c.setRGB(a, a, a));
      n++;
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const key of [...this.chunks.keys()]) this.onChunkUnloaded(key);
    this.drops.geometry.dispose();
    this.rings.geometry.dispose();
    this.dropMat.dispose();
    this.ringMat.dispose();
    this.sheetMat.dispose();
    for (const m of this.surfaceMats) m.dispose();
  }
}
