import * as THREE from 'three';
import { CAMERA_FAR, FOG_FAR, FOG_NEAR } from '../core/config';

const SKY_TOP = new THREE.Color('#5d8fc9');
const SKY_HORIZON = new THREE.Color('#c9d6df');
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
const SHADOW_EXTENT = 55;

/** Sky shader inputs the atmosphere animates (day/night, weather). */
export interface SkyUniforms {
  top: { value: THREE.Color };
  horizon: { value: THREE.Color };
  sunDir: { value: THREE.Vector3 };
  /** Sun disc and glow strength (0 at night or under cloud). */
  sunGlow: { value: number };
  moonDir: { value: THREE.Vector3 };
  /** Moon and stars visibility. */
  night: { value: number };
}

/** Owns the WebGL renderer, the world scene, lighting, fog and sky. */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Direction towards the sun (or the moon at night): drives the shadow light. */
  readonly sunDir = SUN_DIR.clone();
  readonly skyUniforms: SkyUniforms;
  private sky: THREE.Mesh;
  private renderScale = 1;
  private shadowSize = 0;
  /** Extra passes (viewmodel) rendered after the world. */
  readonly overlays: { scene: THREE.Scene; camera: THREE.Camera }[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.autoClear = false;

    this.camera = new THREE.PerspectiveCamera(74, 16 / 9, 0.05, CAMERA_FAR);
    this.camera.rotation.order = 'YXZ';

    this.scene.fog = new THREE.Fog(SKY_HORIZON.clone(), FOG_NEAR, FOG_FAR);
    this.scene.background = SKY_HORIZON.clone();

    this.hemi = new THREE.HemisphereLight('#cfe3ff', '#6b5a48', 1.35);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight('#fff1d8', 2.6);
    this.sun.shadow.camera.left = -SHADOW_EXTENT;
    this.sun.shadow.camera.right = SHADOW_EXTENT;
    this.sun.shadow.camera.top = SHADOW_EXTENT;
    this.sun.shadow.camera.bottom = -SHADOW_EXTENT;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.skyUniforms = {
      top: { value: SKY_TOP.clone() },
      horizon: { value: SKY_HORIZON.clone() },
      sunDir: { value: this.sunDir },
      sunGlow: { value: 1 },
      moonDir: { value: this.sunDir.clone().negate() },
      night: { value: 0 },
    };
    this.sky = this.makeSky();
    this.scene.add(this.sky);

    this.resize();
  }

  get anisotropy(): number {
    return Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
  }

  private makeSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(CAMERA_FAR * 0.9, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.skyUniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        uniform vec3 sunDir;
        uniform float sunGlow;
        uniform vec3 moonDir;
        uniform float night;
        varying vec3 vDir;
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(d, sunDir), 0.0);
          col += vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 2.5 + pow(s, 12.0) * 0.12) * sunGlow;
          if (night > 0.0) {
            // Stars: sparse hashed points on a direction grid, twinkle-free, fading at the horizon.
            vec3 cell = floor(d * 180.0);
            float star = step(0.9965, hash(cell));
            vec3 f = fract(d * 180.0) - 0.5;
            star *= smoothstep(0.35, 0.0, length(f));
            col += vec3(0.9, 0.93, 1.0) * star * night * smoothstep(0.02, 0.25, d.y) * (0.5 + hash(cell + 7.0));
            // Moon: a pale disc with a soft halo.
            float m = max(dot(d, moonDir), 0.0);
            col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.99975, 0.99988, m) * 1.4 + pow(m, 40.0) * 0.08) * night;
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    return mesh;
  }

  setShadowMapSize(size: number): void {
    if (size === this.shadowSize) return;
    this.shadowSize = size;
    this.renderer.shadowMap.enabled = size > 0;
    this.sun.castShadow = size > 0;
    if (size > 0) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    // Materials must recompile when shadow state changes.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.resize();
  }

  /** Vertical FOV from a CS-style horizontal FOV defined at 4:3 (Hor+ on wider screens). */
  setFovFromHorizontal43(hfovDeg: number): void {
    const h = (hfovDeg * Math.PI) / 180;
    const v = 2 * Math.atan(Math.tan(h / 2) / (4 / 3));
    this.camera.fov = (v * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const o of this.overlays) {
      const cam = o.camera as THREE.PerspectiveCamera;
      if (cam.isPerspectiveCamera) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
    }
  }

  /** Keep the sun's shadow frustum centered on the player, snapped to shadow texels. */
  updateSun(focus: THREE.Vector3): void {
    const texel = (SHADOW_EXTENT * 2) / Math.max(1, this.shadowSize);
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    const d = this.sunDir;
    this.sun.position.set(fx + d.x * 120, d.y * 120, fz + d.z * 120);
    this.sun.target.updateMatrixWorld();
  }

  render(): void {
    this.sky.position.copy(this.camera.position);
    const r = this.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);
    for (const o of this.overlays) {
      r.clearDepth();
      r.render(o.scene, o.camera);
    }
  }

  dispose(): void {
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}
