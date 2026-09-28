import * as THREE from 'three';
import { CHUNK, FOG_FAR, FOG_NEAR } from '../core/config';
import type { Env } from '../sim/Environment';
import { Material } from '../world/gen/ChunkData';
import { LAMP_Y, LAMPS } from '../world/gen/streets';
import type { MaterialLibrary } from './materials';
import type { Renderer } from './Renderer';

/** Colors and light levels at one point of the day. */
interface Palette {
  top: THREE.Color;
  horizon: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemi: number;
  sun: THREE.Color;
  sunI: number;
  exposure: number;
}

const pal = (top: string, horizon: string, hemiSky: string, hemiGround: string, hemi: number, sun: string, sunI: number, exposure: number): Palette => ({
  top: new THREE.Color(top),
  horizon: new THREE.Color(horizon),
  hemiSky: new THREE.Color(hemiSky),
  hemiGround: new THREE.Color(hemiGround),
  hemi,
  sun: new THREE.Color(sun),
  sunI,
  exposure,
});

const DAY = pal('#5d8fc9', '#c9d6df', '#cfe3ff', '#6b5a48', 1.35, '#fff1d8', 2.6, 1.05);
const GOLDEN = pal('#4b5f94', '#eba06a', '#f2c8a0', '#5a4436', 1.0, '#ffae66', 1.7, 1.08);
/** Moonlight keeps shadows working at night; the street lamps do the rest. */
const NIGHT = pal('#060a17', '#18203a', '#6a7fae', '#1a1822', 0.34, '#a9bcff', 0.4, 1.2);
const OVERCAST_TOP = new THREE.Color('#8b939c');
const OVERCAST_HORIZON = new THREE.Color('#a7adb3');

const MAX_LAMP_LIGHTS = 6;
const GLOW_RANGE = 2;

function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,214,150,0.9)');
  g.addColorStop(0.4, 'rgba(255,190,120,0.35)');
  g.addColorStop(1, 'rgba(255,170,90,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Presentation of the sim's time of day and weather: sky, sun/moon, fog, ambient light,
 * street lamps, the player's flashlight and lightning. Reads `sim.env`, never writes the sim.
 */
export class Atmosphere {
  private p: Palette = pal('#000', '#000', '#000', '#000', 0, '#000', 0, 1);
  private lampLights: THREE.PointLight[] = [];
  private glow: THREE.InstancedMesh;
  private flashlight: THREE.SpotLight;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private clock = 0;
  private nextBolt = 5;
  private bolt = 0;
  /** Street lamps exist only in the city. */
  lampsEnabled = true;
  /** Called when lightning strikes: thunder should follow after `delay` seconds. */
  onLightning: ((delay: number, strength: number) => void) | null = null;
  /** 0..1 how lit the lamps are (for anything else that glows at night). */
  lampLevel = 0;

  constructor(
    private renderer: Renderer,
    private materials: MaterialLibrary | null,
  ) {
    const scene = renderer.scene;
    for (let i = 0; i < MAX_LAMP_LIGHTS; i++) {
      // Always in the scene (intensity 0 by day) so the shaders never recompile.
      const l = new THREE.PointLight('#ffcf94', 0, 18, 2);
      this.lampLights.push(l);
      scene.add(l);
    }
    const n = (GLOW_RANGE * 2 + 1) ** 2 * LAMPS.length;
    this.glow = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeGlowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      n,
    );
    this.glow.frustumCulled = false;
    this.glow.count = 0;
    this.glow.name = 'lamp-glow';
    scene.add(this.glow);
    this.flashlight = new THREE.SpotLight('#fff4e0', 0, 45, 0.42, 0.55, 1.6);
    scene.add(this.flashlight, this.flashlight.target);
  }

  /** Which street lamps exist (the city sets it: none stand in the river). */
  lampStands: ((cx: number, cz: number, i: number) => boolean) | null = null;

  update(env: Env, frameDt: number, camera: THREE.PerspectiveCamera, flashlightOn: boolean): void {
    this.clock += frameDt;
    const r = this.renderer;
    const p = this.p;

    // Blend the palette: night -> golden hour -> day, golden strongest right around sunrise/sunset.
    const d = env.daylight;
    // The low sun stays warm for a while either side of that too: after sunrise (the sunrise
    // start) and before dusk.
    const h = env.hour;
    const low = h > 12 ? (h - 16) / 3.5 : h > 5 ? (9.5 - h) / 2.5 : 0;
    const warm = Math.max(0, Math.min(1, low)) * d;
    const golden = Math.max(warm * 0.75, Math.max(0, 1 - Math.abs(d - 0.55) / 0.45) * (h > 12 ? 1 : 0.8));
    this.mix(p, NIGHT, DAY, d);
    this.mix(p, p, GOLDEN, golden * 0.8);

    // Clouds grey the sky and trade the sun for flat ambient light.
    const cloud = env.cloud;
    const grey = cloud * (0.35 + 0.65 * d);
    p.top.lerp(this.v3c(OVERCAST_TOP, d), grey * 0.8);
    p.horizon.lerp(this.v3c(OVERCAST_HORIZON, d), grey * 0.8);
    p.sunI *= 1 - 0.7 * cloud;
    p.hemi *= 1 + 0.1 * cloud * d;

    // Lightning: brief bright flashes, thunder follows.
    if (env.storm > 0.3) {
      this.nextBolt -= frameDt;
      if (this.nextBolt <= 0) {
        this.bolt = 1;
        this.nextBolt = 4 + Math.random() * 12;
        this.onLightning?.(0.4 + Math.random() * 2.2, 0.6 + Math.random() * 0.4);
      }
    }
    if (this.bolt > 0) {
      const flicker = this.bolt > 0.6 || (this.bolt > 0.3 && this.bolt < 0.45) ? 1 : 0.2;
      p.hemi += 2.5 * this.bolt * flicker;
      p.horizon.lerp(new THREE.Color('#dfe6ff'), 0.5 * this.bolt * flicker);
      this.bolt = Math.max(0, this.bolt - frameDt * 3);
    }

    // Sun path: rises in the east at 6, overhead at 13:30, sets in the west at 21. The
    // moon takes over the shadow light at night.
    const sunAng = ((env.hour - 6) / 15) * Math.PI;
    const sunDir = this.v.set(Math.cos(sunAng) * 0.9, Math.sin(sunAng), 0.35).normalize();
    const moonAng = sunAng + Math.PI;
    const moonDir = this.s.set(Math.cos(moonAng) * 0.7, Math.sin(moonAng), -0.4).normalize();
    const u = r.skyUniforms;
    u.sunDir.value.copy(sunDir);
    u.moonDir.value.copy(moonDir);
    u.sunGlow.value = Math.max(0, Math.min(1, sunDir.y * 4)) * (1 - 0.85 * cloud);
    u.night.value = Math.max(0, 1 - d * 1.6) * (1 - 0.9 * cloud);
    u.top.value.copy(p.top);
    u.horizon.value.copy(p.horizon);
    // The shadow light follows whichever of sun or moon is up (never below the horizon).
    const light = sunDir.y > 0.08 ? sunDir : moonDir.y > 0.08 ? moonDir : this.fwd.set(0.3, 0.8, 0.2).normalize();
    r.sunDir.copy(light);
    if (light.y < 0.3) r.sunDir.y = 0.3;
    r.sunDir.normalize();
    r.sun.color.copy(p.sun);
    r.sun.intensity = p.sunI;
    r.hemi.color.copy(p.hemiSky);
    r.hemi.groundColor.copy(p.hemiGround);
    r.hemi.intensity = p.hemi;
    r.renderer.toneMappingExposure = p.exposure;

    // Fog: colour of the horizon, closer in fog and rain (never further than the streaming edge).
    const fog = r.scene.fog as THREE.Fog;
    fog.color.copy(p.horizon);
    (r.scene.background as THREE.Color).copy(p.horizon);
    const thick = Math.min(1, env.fog + env.rain * 0.25);
    fog.near = FOG_NEAR * (1 - 0.8 * thick);
    fog.far = FOG_FAR * (1 - 0.6 * thick);

    this.updateLamps(env, camera);
    this.updateFlashlight(env, camera, flashlightOn);
  }

  /** Viewmodel light scale so the gun isn't lit like noon at midnight. */
  get viewmodelLight(): number {
    return Math.max(0.25, this.p.hemi / DAY.hemi) + this.lampLevel * 0.1;
  }

  private mix(out: Palette, a: Palette, b: Palette, t: number): void {
    out.top.copy(a.top).lerp(b.top, t);
    out.horizon.copy(a.horizon).lerp(b.horizon, t);
    out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
    out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
    out.hemi = a.hemi + (b.hemi - a.hemi) * t;
    out.sun.copy(a.sun).lerp(b.sun, t);
    out.sunI = a.sunI + (b.sunI - a.sunI) * t;
    out.exposure = a.exposure + (b.exposure - a.exposure) * t;
  }

  /** Overcast colour darkened towards night. */
  private tmpC = new THREE.Color();
  private v3c(c: THREE.Color, daylight: number): THREE.Color {
    return this.tmpC.copy(c).multiplyScalar(0.15 + 0.85 * daylight);
  }

  private updateLamps(env: Env, camera: THREE.PerspectiveCamera): void {
    // Lamps come on at dusk (and on very dark stormy days).
    const want = Math.max(Math.min(1, Math.max(0, env.darkness - 0.1) / 0.5), env.cloud > 0.9 ? 0.4 : 0);
    const level = this.lampsEnabled ? want : 0;
    this.lampLevel = level;
    const glass = this.materials?.get(Material.LampGlow);
    if (glass) {
      glass.emissive.set('#ffd9a0');
      glass.emissiveIntensity = 0.15 + level * 1.4;
    }
    this.materials?.setNightGlow(level);
    const cam = camera.position;
    const ccx = Math.floor(cam.x / CHUNK);
    const ccz = Math.floor(cam.z / CHUNK);
    // Glow pools under every nearby lamp; real lights on the closest few.
    const near: { x: number; z: number; d: number }[] = [];
    let n = 0;
    if (level > 0.01) {
      for (let dz = -GLOW_RANGE; dz <= GLOW_RANGE; dz++) {
        for (let dx = -GLOW_RANGE; dx <= GLOW_RANGE; dx++) {
          const ox = (ccx + dx) * CHUNK;
          const oz = (ccz + dz) * CHUNK;
          for (let li = 0; li < LAMPS.length; li++) {
            if (this.lampStands && !this.lampStands(ccx + dx, ccz + dz, li)) continue;
            const [lx, lz] = LAMPS[li];
            const x = ox + lx;
            const z = oz + lz;
            this.m.compose(this.v.set(x, 0.16, z), this.q, this.s.set(9, 9, 1));
            this.glow.setMatrixAt(n++, this.m);
            near.push({ x, z, d: Math.hypot(x - cam.x, z - cam.z) });
          }
        }
      }
      near.sort((a, b) => a.d - b.d);
    }
    this.glow.count = n;
    this.glow.instanceMatrix.needsUpdate = true;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.55 * level;
    for (let i = 0; i < MAX_LAMP_LIGHTS; i++) {
      const l = this.lampLights[i];
      const lamp = near[i];
      if (!lamp) {
        l.intensity = 0;
        continue;
      }
      l.position.set(lamp.x, LAMP_Y - 0.15, lamp.z);
      // Fade the furthest light in/out so switching lamps doesn't pop.
      const edge = i === MAX_LAMP_LIGHTS - 1 ? 0.5 : 1;
      l.intensity = 22 * level * edge;
    }
  }

  private updateFlashlight(env: Env, camera: THREE.PerspectiveCamera, on: boolean): void {
    const f = this.flashlight;
    f.intensity = on ? 70 * (0.35 + 0.65 * env.darkness) : 0;
    if (!on) return;
    camera.getWorldDirection(this.fwd);
    // From just below and right of the eye, like a torch taped to the gun.
    f.position.copy(camera.position).addScaledVector(this.fwd, 0.2);
    f.position.y -= 0.15;
    f.target.position.copy(camera.position).addScaledVector(this.fwd, 10);
    f.target.updateMatrixWorld();
  }

  dispose(): void {
    this.glow.geometry.dispose();
    const mat = this.glow.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
    for (const l of this.lampLights) l.dispose();
    this.flashlight.dispose();
  }
}
