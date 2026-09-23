import * as THREE from 'three';
import { CAMERA_FAR, FOG_FAR, FOG_NEAR } from '../core/config';

const SKY_TOP = new THREE.Color('#5d8fc9');
const SKY_HORIZON = new THREE.Color('#c9d6df');
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
const SHADOW_EXTENT = 55;

/** Owns the WebGL renderer, the world scene, lighting, fog and sky. */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
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

    const hemi = new THREE.HemisphereLight('#cfe3ff', '#6b5a48', 1.35);
    this.scene.add(hemi);

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
      uniforms: {
        top: { value: SKY_TOP },
        horizon: { value: SKY_HORIZON },
        sunDir: { value: SUN_DIR },
      },
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
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          col += vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 2.5 + pow(s, 12.0) * 0.12);
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
    this.sun.position.set(fx + SUN_DIR.x * 120, SUN_DIR.y * 120, fz + SUN_DIR.z * 120);
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
