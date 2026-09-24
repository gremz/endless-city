import * as THREE from 'three';
import { lerp } from '../core/math';
import { bodyScale, STAND_BOXES } from '../ai/hitboxes';
import { Team, type Actor } from '../sim/Actor';

const MAX = 48;
/** Part index → palette index. */
const PART_LOOK = [0, 1, 2, 3, 3, 4, 4, 5];

interface PartDef {
  name: string;
  geo: THREE.BufferGeometry;
  color: THREE.ColorRepresentation;
}

/** Palettes per look: [head, torso, stomach, legs, arms, gun]. */
const LOOKS: Record<string, string[]> = {
  bot: ['#3b3530', '#4a4f3a', '#3f4234', '#5c5140', '#4a4f3a', '#1d1d1d'],
  dummy: ['#c9b48a', '#b89c6a', '#a88d5f', '#8f7a55', '#b89c6a', '#1d1d1d'],
  elite: ['#26282b', '#2b3036', '#25292e', '#383c42', '#2b3036', '#141414'],
  /** Other players (co-op). */
  ally: ['#2f3f52', '#35577a', '#2f4a66', '#3a4f63', '#35577a', '#1d1d1d'],
};

/**
 * Draws every non-player actor with a handful of InstancedMeshes (one per body part).
 * Proportions come from the hitboxes, so the model matches what bullets hit.
 */
export class BotRenderer {
  readonly root = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private parts: PartDef[] = [];
  private m = new THREE.Matrix4();
  private root4 = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private color = new THREE.Color();
  private walkPhase = new Map<number, number>();
  private tilt = new THREE.Matrix4();
  /** Flashlight beams on bots that are out hunting at night. */
  private beams: THREE.InstancedMesh;
  private beamMat!: THREE.MeshBasicMaterial;
  private beamCount = 0;

  constructor(shadows: boolean) {
    const head = STAND_BOXES[0];
    const chest = STAND_BOXES[1];
    const stomach = STAND_BOXES[2];
    const box = (w: number, h: number, d: number, oy = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(0, oy, 0);
      return g;
    };
    this.parts = [
      { name: 'head', geo: box(head.hx * 2, head.hy * 2, head.hz * 2), color: '#fff' },
      { name: 'chest', geo: box(chest.hx * 2, chest.hy * 2, chest.hz * 2), color: '#fff' },
      { name: 'stomach', geo: box(stomach.hx * 2, stomach.hy * 2, stomach.hz * 2), color: '#fff' },
      // Legs and arms pivot at the top (hip / shoulder).
      { name: 'legL', geo: box(0.17, 0.8, 0.2, -0.4), color: '#fff' },
      { name: 'legR', geo: box(0.17, 0.8, 0.2, -0.4), color: '#fff' },
      { name: 'armL', geo: box(0.1, 0.5, 0.11, -0.25), color: '#fff' },
      { name: 'armR', geo: box(0.1, 0.5, 0.11, -0.25), color: '#fff' },
      { name: 'gun', geo: box(0.06, 0.09, 0.62, 0), color: '#fff' },
    ];
    for (const p of this.parts) {
      const mat = new THREE.MeshLambertMaterial({ color: p.color });
      const mesh = new THREE.InstancedMesh(p.geo, mat, MAX);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = shadows;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.name = `bot-${p.name}`;
      this.meshes.push(mesh);
      this.root.add(mesh);
    }
    this.beams = this.initBeams();
  }

  private initBeams(): THREE.InstancedMesh {
    // A long open cone, narrow end at the origin, opening towards -Z.
    const geo = new THREE.CylinderGeometry(1.5, 0.04, 9, 16, 1, true);
    geo.translate(0, 4.5, 0);
    geo.rotateX(-Math.PI / 2);
    this.beamMat = new THREE.MeshBasicMaterial({
      color: '#fff1d6',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geo, this.beamMat, MAX);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.name = 'bot-torch';
    this.root.add(mesh);
    return mesh;
  }

  setShadows(on: boolean): void {
    for (const m of this.meshes) m.castShadow = on;
  }

  /**
   * Rebuild all instances for this frame. `torches` are actors carrying a lit flashlight;
   * `torchLevel` (0..1) is how dark it is.
   */
  update(actors: readonly Actor[], playerId: number, alpha: number, time: number, frameDt: number, torches?: ReadonlySet<number>, torchLevel = 0): void {
    this.torches = torchLevel > 0.05 ? torches ?? null : null;
    this.beamMat.opacity = 0.07 * torchLevel;
    this.beamCount = 0;
    let n = 0;
    for (const a of actors) {
      // Drivers are inside their cars.
      if (a.id === playerId || a.vehicle >= 0) continue;
      if (!a.alive && time - a.diedAt > 12) continue;
      if (n >= MAX) break;
      this.writeActor(a, n, alpha, time, frameDt);
      n++;
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.beams.count = this.beamCount;
    this.beams.instanceMatrix.needsUpdate = true;
  }

  private torches: ReadonlySet<number> | null = null;

  private writeActor(a: Actor, i: number, alpha: number, time: number, frameDt: number): void {
    const m = a.move;
    const px = lerp(a.prevPos.x, m.pos.x, alpha);
    const py = lerp(a.prevPos.y, m.pos.y, alpha);
    const pz = lerp(a.prevPos.z, m.pos.z, alpha);
    let dy = a.yaw - a.prevYaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    else if (dy < -Math.PI) dy += Math.PI * 2;
    const yaw = a.prevYaw + dy * alpha;
    const k = bodyScale(m);
    const speed = Math.hypot(m.vel.x, m.vel.z);

    // Death: fall backwards over 0.45 s, then sink after 8 s.
    let fall = 0;
    let sink = 0;
    if (!a.alive) {
      const t = time - a.diedAt;
      fall = Math.min(1, t / 0.45);
      fall = 1 - (1 - fall) * (1 - fall);
      if (t > 8) sink = (t - 8) * 0.12;
    }

    this.q.setFromEuler(this.e.set(0, yaw, 0, 'YXZ'));
    this.root4.compose(this.v.set(px, py - sink, pz), this.q, this.s.set(1, 1, 1));
    if (fall > 0) {
      this.root4.multiply(this.tilt.makeRotationX(fall * 1.45));
    }

    let phase = this.walkPhase.get(a.id) ?? 0;
    if (a.alive) phase += frameDt * speed * 2.6;
    this.walkPhase.set(a.id, phase);
    const swing = a.alive && m.onGround ? Math.sin(phase) * Math.min(1, speed / 4) * 0.6 : 0;
    const legBend = 1 - (1 - k) * 1.4; // crouch shortens legs
    const hipY = 0.8 * Math.max(0.45, legBend);
    const aimPitch = a.alive ? a.pitch : 0;

    const look = a.dummy ? LOOKS.dummy : a.team === Team.Player ? LOOKS.ally : a.armor > 0 && a.helmet ? LOOKS.elite : LOOKS.bot;
    const place = (part: number, x: number, y: number, z: number, rx: number, ry: number, sy = 1) => {
      this.q.setFromEuler(this.e.set(rx, ry, 0, 'YXZ'));
      this.local.compose(this.v.set(x, y, z), this.q, this.s.set(1, sy, 1));
      this.m.multiplyMatrices(this.root4, this.local);
      this.meshes[part].setMatrixAt(i, this.m);
      this.meshes[part].setColorAt(i, this.color.set(look[PART_LOOK[part]]));
    };
    const b = STAND_BOXES;
    const chestY = b[1].cy * k;
    const stomachY = b[2].cy * k;
    const headY = b[0].cy * k;
    const crouchLean = (1 - k) * 0.5;
    place(0, 0, headY, -crouchLean * 0.3, aimPitch * 0.4, 0);
    place(1, 0, chestY, -crouchLean * 0.2, crouchLean * 0.4, 0);
    place(2, 0, stomachY, 0, 0, 0);
    place(3, -0.1, hipY, 0, swing - crouchLean, 0, Math.max(0.55, legBend));
    place(4, 0.1, hipY, 0, -swing - crouchLean, 0, Math.max(0.55, legBend));
    // Arms reach forward to hold the gun, following aim pitch.
    const shoulderY = chestY + b[1].hy * k * 0.75;
    // Arms hang along -Y from the shoulder; rotating +90° about X points them forward (-Z).
    const armRx = Math.PI / 2 - 0.35 + aimPitch;
    place(5, -0.2, shoulderY, -0.05, armRx, 0.45);
    place(6, 0.2, shoulderY, -0.05, armRx, -0.2);
    // Gun at chest height pointing along aim.
    const gunY = shoulderY - 0.12 + Math.sin(aimPitch) * 0.3;
    place(7, 0.05, gunY, -0.42 - Math.cos(aimPitch) * 0.05, aimPitch, 0);
    // Dropped their guns (dead bodies): hide the gun.
    if (!a.alive && !a.inv.primary && !a.inv.secondary) this.meshes[7].setMatrixAt(i, this.m.makeScale(0, 0, 0));
    if (a.alive && this.torches?.has(a.id)) {
      // Torch taped under the barrel.
      this.q.setFromEuler(this.e.set(aimPitch, 0, 0, 'YXZ'));
      this.local.compose(this.v.set(0.05, gunY - 0.05, -0.7), this.q, this.s.set(1, 1, 1));
      this.m.multiplyMatrices(this.root4, this.local);
      this.beams.setMatrixAt(this.beamCount++, this.m);
    }
    if (a.alive && a.inv.active === 'grenade') {
      // Grenade in hand: a small lump raised by the head, ready to throw.
      this.q.setFromEuler(this.e.set(0, 0, 0, 'YXZ'));
      this.local.compose(this.v.set(0.22, shoulderY + 0.12, -0.12), this.q, this.s.set(1.1, 1, 0.14));
      this.m.multiplyMatrices(this.root4, this.local);
      this.meshes[7].setMatrixAt(i, this.m);
    }
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}
