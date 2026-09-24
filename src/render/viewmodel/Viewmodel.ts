import * as THREE from 'three';
import { clamp, clamp01 } from '../../core/math';
import type { Actor } from '../../sim/Actor';
import { activeItem } from '../../weapons/Inventory';
import type { WeaponId } from '../../weapons/weaponDefs';
import { getGunModel, makeArmGeometry } from './gunMeshes';

function makeFlashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,250,220,1)');
  g.addColorStop(0.25, 'rgba(255,200,90,0.9)');
  g.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 ? 22 : 64;
    ctx.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const VM_SCALE = 0.62;

/** First-person weapon and arms, rendered in their own scene after the world (never clips walls). */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private pivot = new THREE.Group();
  private gun: THREE.Mesh;
  private armR: THREE.Mesh;
  private armL: THREE.Mesh;
  private flash: THREE.Sprite;
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private weapon: WeaponId | null = null;
  private flashUntil = 0;
  private kick = 0;
  private kickRot = 0;
  private swing = 0;
  private swingDir = 1;
  /** 0..1: arm drawn back with the pin pulled. */
  private pinBack = 0;
  /** Throw follow-through, decays from 1. */
  private throwAnim = 0;
  private landDip = 0;
  /** 0..1: gun lowered out of the way while a medkit is applied. */
  private healLower = 0;
  private bobPhase = 0;
  private swayX = 0;
  private swayY = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private clock = 0;
  visible = true;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.01, 10);
    this.hemi = new THREE.HemisphereLight('#e6eeff', '#6a5c4c', 2.2);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight('#fff3e0', 2.6);
    this.key.position.set(0.6, 1, 0.4);
    this.scene.add(this.key);

    this.gun = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    const armGeo = makeArmGeometry();
    this.armR = new THREE.Mesh(armGeo, this.material);
    this.armL = new THREE.Mesh(armGeo, this.material);
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.flash.scale.setScalar(0.14);
    this.flash.visible = false;
    this.pivot.add(this.gun, this.armR, this.armL, this.flash);
    // Models are built at real-world scale; shrink so they sit in the lower-right like CS.
    this.pivot.scale.setScalar(VM_SCALE);
    this.scene.add(this.pivot);
  }

  setFovFromHorizontal43(hfovDeg: number): void {
    const h = (hfovDeg * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(h / 2) / (4 / 3)) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  private setWeapon(id: WeaponId): void {
    if (this.weapon === id) return;
    this.weapon = id;
    const model = getGunModel(id);
    this.gun.geometry = model.geometry;
    this.flash.position.copy(model.muzzle);
    // Right hand on the grip, forearm running back towards the bottom-right of the screen.
    this.armR.position.set(0, -0.04, 0.03);
    this.armR.rotation.set(0.75, -0.35, 0.1);
    if (model.leftHand) {
      this.armL.visible = true;
      this.armL.position.copy(model.leftHand).add(new THREE.Vector3(0, -0.035, 0));
      this.armL.rotation.set(0.55, 0.75, -0.2);
    } else {
      this.armL.visible = false;
    }
  }

  onShot(weapon: string): void {
    const heavy = weapon === 'awp' ? 2.2 : weapon === 'deagle' ? 1.8 : weapon.startsWith('ak') ? 1.2 : 1;
    if (weapon === 'knife') {
      this.swing = 1;
      this.swingDir = -this.swingDir;
      return;
    }
    this.kick = Math.min(0.09, this.kick + 0.022 * heavy);
    this.kickRot = Math.min(0.25, this.kickRot + 0.04 * heavy);
    this.flashUntil = this.clock + 0.035;
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.1 + Math.random() * 0.06);
  }

  /** Scale the gun's lighting with the world's (dim at night). */
  setLightScale(k: number): void {
    this.hemi.intensity = 2.2 * k;
    this.key.intensity = 2.6 * k;
  }

  onThrow(): void {
    this.throwAnim = 1;
    this.pinBack = 0;
  }

  onLand(speed: number): void {
    this.landDip = Math.min(0.06, this.landDip + speed * 0.006);
  }

  /** Muzzle position in world space (for tracers and the flash light). */
  muzzleWorld(worldCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.flash.position);
    this.pivot.updateMatrix();
    out.applyMatrix4(this.pivot.matrix);
    // Viewmodel camera sits at the origin looking -Z, same orientation as the world camera.
    return worldCamera.localToWorld(out);
  }

  update(frameDt: number, a: Actor, simTime: number, yaw: number, pitch: number): void {
    this.clock += frameDt;
    const item = activeItem(a.inv);
    const def = item.def;
    this.setWeapon(def.id);
    const w = a.wpn;
    const model = getGunModel(def.id);
    this.pivot.visible = this.visible && a.alive;
    if (!this.pivot.visible) return;

    // Sway: the gun lags behind mouse movement.
    let dYaw = yaw - this.lastYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    const k = 1 - Math.exp(-frameDt * 10);
    this.swayX += (clamp(dYaw * 0.5, -0.05, 0.05) - this.swayX) * k;
    this.swayY += (clamp(dPitch * 0.5, -0.05, 0.05) - this.swayY) * k;

    // Bob with ground speed.
    const m = a.move;
    const speed = Math.hypot(m.vel.x, m.vel.z);
    const sf = m.onGround ? clamp01(speed / 6.35) : 0;
    this.bobPhase += frameDt * (4 + speed * 1.2);
    const bobX = Math.sin(this.bobPhase) * 0.007 * sf;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.009 * sf;

    const decay = Math.exp(-frameDt * 16);
    this.kick *= decay;
    this.kickRot *= Math.exp(-frameDt * 12);
    this.landDip *= Math.exp(-frameDt * 8);
    this.swing *= Math.exp(-frameDt * 9);
    this.throwAnim *= Math.exp(-frameDt * 7);
    this.pinBack += ((w.pinPulled ? 1 : 0) - this.pinBack) * (1 - Math.exp(-frameDt * 14));

    let px = model.offset.x + bobX + this.swayX * 0.3;
    let py = model.offset.y + bobY - this.landDip - this.swayY * 0.3;
    let pz = model.offset.z + this.kick;
    let rx = this.kickRot + this.swayY;
    let ry = this.swayX;
    let rz = 0;

    // Deploy: raise from below.
    const deployStart = w.deployEnd - def.deployTime;
    if (simTime < w.deployEnd && simTime >= deployStart) {
      const p = clamp01((simTime - deployStart) / def.deployTime);
      const e = (1 - p) * (1 - p);
      py -= e * 0.22;
      rx -= e * 0.9;
    }
    // Reload: tilt and dip.
    if (w.reloadEnd >= 0 && def.reloadTime > 0) {
      const p = clamp01(1 - (w.reloadEnd - simTime) / def.reloadTime);
      const d = Math.sin(p * Math.PI);
      py -= d * 0.07;
      rz += d * 0.55;
      rx += d * 0.25;
    }
    // Inspect.
    const ip = (simTime - w.inspectAt) / 2.2;
    if (ip >= 0 && ip < 1 && w.reloadEnd < 0) {
      const d = Math.sin(ip * Math.PI);
      ry += d * 1.0;
      rz += d * 0.45;
      px -= d * 0.05;
    }
    // Medkit: lower the gun and tilt it away.
    this.healLower += ((a.healEnd >= 0 ? 1 : 0) - this.healLower) * (1 - Math.exp(-frameDt * 12));
    if (this.healLower > 0.001) {
      py -= this.healLower * 0.2;
      rx -= this.healLower * 0.6;
      rz += this.healLower * 0.3;
    }
    // Knife swing.
    if (this.swing > 0.01) {
      ry += this.swing * 0.9 * this.swingDir;
      rx -= this.swing * 0.4;
      pz -= this.swing * 0.08;
    }

    // Grenade: wind up with the pin out, then follow through after the throw.
    if (this.pinBack > 0.001) {
      px += this.pinBack * 0.03;
      py += this.pinBack * 0.05;
      pz += this.pinBack * 0.09;
      rx += this.pinBack * 0.6;
      rz -= this.pinBack * 0.25;
    }
    if (this.throwAnim > 0.01) {
      py -= this.throwAnim * 0.12;
      pz -= this.throwAnim * 0.1;
      rx -= this.throwAnim * 0.9;
    }
    // The hand is empty between a throw and drawing the next grenade.
    this.gun.visible = !(def.category === 'grenade' && w.thrownAt >= 0);

    this.pivot.position.set(px, py, pz);
    // Slight toe-in so the barrel points towards the crosshair.
    this.pivot.rotation.set(rx, ry + 0.035, rz, 'YXZ');
    this.flash.visible = this.clock < this.flashUntil;
  }

  dispose(): void {
    this.material.dispose();
    this.armR.geometry.dispose();
    this.flash.material.map?.dispose();
    this.flash.material.dispose();
  }
}
