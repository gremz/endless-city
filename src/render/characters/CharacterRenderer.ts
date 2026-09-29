import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { SimEvent } from '../../core/events';
import { FOG_FAR } from '../../core/config';
import { lerp } from '../../core/math';
import { Team, unarmed, type Actor } from '../../sim/Actor';
import type { WeaponId } from '../../weapons/weaponDefs';
import type { ActorRenderer } from '../BotRenderer';
import { getGunModel } from '../viewmodel/gunMeshes';
import { choosePose } from './animState';
import type { CharacterAsset } from './CharacterAssets';
import { CLIP_BY_NAME, GEAR, HOLD_BY_CATEGORY, NODES, READY_HOLD, type LookId } from './characterSpec';
import { pickVariant, type CharacterVariant } from './variants';

const MAX = 64;
/** Weight blend time between clips (s), and a quicker one into death. */
const FADE = 0.15;
const DEATH_FADE = 0.08;
/** Beyond this distance the animation updates every LOD_STEP frames. */
const LOD_DIST = 50;
const LOD_STEP = 3;
/** Always animate characters this close (their shadows can fall into view). */
const NEAR = 8;
/** Nobody's drawn past the fog. */
const CULL_DIST = FOG_FAR;
/** Aim bend limit, and how it splits between Spine and Chest. */
const MAX_AIM = 1.1;
/** Long guns drop to the ready carry above this ground speed (m/s)... */
const READY_SPEED = 0.6;
/** ...unless they fired within this long (s). */
const AIM_AFTER_SHOT = 1.0;
/** A position jump faster than this is a teleport, not movement (m/s). */
const TELEPORT_SPEED = 25;

interface Instance {
  id: number;
  /** Index into the renderer's variants; fixed for the instance's life. */
  variant: number;
  obj: THREE.Group;
  mixer: THREE.AnimationMixer;
  /** Every clip's action (overlays included). */
  actions: Map<string, THREE.AnimationAction>;
  /** Current (smoothed) weight of each base clip. */
  weights: Map<string, number>;
  /** Current (smoothed) weight of each hold clip. */
  holds: Map<string, number>;
  meshes: { mesh: THREE.Mesh; base: THREE.Material | THREE.Material[] }[];
  modelRoot: THREE.Object3D;
  spine: THREE.Object3D;
  chest: THREE.Object3D | null;
  weapon: THREE.Object3D;
  torch: THREE.Object3D | null;
  helmet: THREE.Object3D[];
  vest: THREE.Object3D[];
  gun: THREE.Mesh;
  gunId: WeaponId | null;
  look: LookId | null;
  phase: number;
  vx: number;
  vz: number;
  lastX: number;
  lastZ: number;
  fresh: boolean;
  airTime: number;
  dead: boolean;
  frame: number;
  pending: number;
  /** Spine and Chest as the clips posed them, before the aim bend (see animate). */
  unbent: [THREE.Quaternion, THREE.Quaternion] | null;
  /** Renderer time of the last shot (brings a long gun up from the ready carry). */
  shotAt: number;
  /** Arm bones with their bind (hanging) rotations, for people with nothing in their hands. */
  arms: { bone: THREE.Object3D; rest: THREE.Quaternion; upper: number }[];
  /** The arms as the clips posed them, before letting them hang (see animate). */
  unhung: THREE.Quaternion[] | null;
}

/**
 * Draws actors with the imported, animated characters (see characterSpec.ts): one skinned clone
 * per actor, of a variant picked when the actor is first seen (see variants.ts), pooled per variant, with clip weights from choosePose, the aim bent into the spine, the game's
 * own gun models in the hand, and upper-body overlays on shots, reloads, throws and hits.
 */
export class CharacterRenderer implements ActorRenderer {
  readonly root = new THREE.Group();
  private live = new Map<number, Instance>();
  private pools: Instance[][];
  private poolMax: number;
  private groups: CharacterVariant['group'][];
  private seen = new Set<number>();
  private gunMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: '#202020' });
  private beams: THREE.InstancedMesh;
  private beamMat: THREE.MeshBasicMaterial;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private q3 = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private beamLocal = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  private beamFromWeapon = new THREE.Matrix4().makeTranslation(0, 0.55, -0.05).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  private aimAxis = new THREE.Vector3(1, 0, 0);
  private shadows: boolean;
  private frameNo = 0;
  private time = 0;
  private torches: ReadonlySet<number> | null = null;

  constructor(
    private variants: readonly CharacterVariant[],
    private camera: THREE.Camera,
    shadows: boolean,
  ) {
    if (!variants.length) throw new Error('CharacterRenderer needs at least one model');
    this.pools = variants.map(() => []);
    this.poolMax = Math.ceil(MAX / variants.length);
    this.groups = variants.map((v) => v.group);
    this.root.name = 'characters';
    this.shadows = shadows;
    // Flashlight cone: narrow end at the origin, opening towards -Z (same as the box bots').
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
    this.beams = new THREE.InstancedMesh(geo, this.beamMat, MAX);
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    this.beams.name = 'character-torch';
    this.root.add(this.beams);
  }

  private asset(inst: Instance): CharacterAsset {
    return this.variants[inst.variant].asset;
  }

  private create(id: number, variant: number): Instance {
    const asset = this.variants[variant].asset;
    const obj = new THREE.Group();
    const model = cloneSkinned(asset.template) as THREE.Group;
    obj.add(model);
    const find = (name: string) => model.getObjectByName(name) ?? null;
    const meshes: Instance['meshes'] = [];
    const helmet: THREE.Object3D[] = [];
    const vest: THREE.Object3D[] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        meshes.push({ mesh, base: mesh.material });
        mesh.castShadow = this.shadows;
      }
      if (o.name === GEAR.helmet) helmet.push(o);
      if (o.name === GEAR.vest) vest.push(o);
    });
    const arms: Instance['arms'] = [];
    for (const side of ['L', 'R'] as const) {
      for (const part of ['UpperArm', 'LowerArm', 'Hand']) {
        const bone = find(`${part}_${side}`);
        if (bone) arms.push({ bone, rest: bone.quaternion.clone(), upper: part === 'UpperArm' ? (side === 'L' ? 1 : -1) : 0 });
      }
    }
    const weapon = find(NODES.weapon)!;
    const gun = new THREE.Mesh(undefined, this.gunMaterial);
    gun.rotation.x = Math.PI / 2; // gun -Z (barrel) along the socket's +Y
    gun.castShadow = this.shadows;
    gun.visible = false;
    weapon.add(gun);

    const mixer = new THREE.AnimationMixer(model);
    const actions = new Map<string, THREE.AnimationAction>();
    const weights = new Map<string, number>();
    const holds = new Map<string, number>();
    for (const [name, clip] of asset.clips) {
      const kind = CLIP_BY_NAME.get(name)!.kind;
      const action = mixer.clipAction(clip);
      if (kind === 'overlay') {
        action.setLoop(THREE.LoopOnce, 1);
        action.blendMode = THREE.AdditiveAnimationBlendMode;
      } else if (kind === 'hold') {
        action.blendMode = THREE.AdditiveAnimationBlendMode;
        action.setEffectiveWeight(0);
        action.play();
        holds.set(name, 0);
      } else {
        if (kind === 'death') {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        // Locomotion and death are driven by setting their time; poses run free.
        if (kind !== 'pose') action.timeScale = 0;
        action.setEffectiveWeight(0);
        action.play();
        weights.set(name, 0);
      }
      actions.set(name, action);
    }
    return {
      id,
      variant,
      obj,
      mixer,
      actions,
      weights,
      holds,
      meshes,
      modelRoot: model.children[0],
      spine: find(NODES.spine)!,
      chest: find(NODES.chest),
      weapon,
      torch: find(NODES.torch),
      helmet,
      vest,
      gun,
      gunId: null,
      look: null,
      phase: 0,
      vx: 0,
      vz: 0,
      lastX: 0,
      lastZ: 0,
      fresh: true,
      airTime: 0,
      dead: false,
      frame: 0,
      pending: 0,
      unbent: null,
      shotAt: -Infinity,
      arms,
      unhung: null,
    };
  }

  private acquire(a: Actor): Instance {
    let inst = this.live.get(a.id);
    if (inst) return inst;
    const variant = this.variants.length > 1 ? pickVariant(a, this.groups) : 0;
    inst = this.pools[variant].pop() ?? this.create(a.id, variant);
    inst.id = a.id;
    inst.fresh = true;
    inst.shotAt = -Infinity;
    inst.dead = false;
    inst.airTime = 0;
    inst.vx = inst.vz = 0;
    inst.frame = this.live.size % LOD_STEP;
    // Desynchronize idles between characters.
    for (const [name, action] of inst.actions) {
      if (CLIP_BY_NAME.get(name)!.kind === 'pose') action.time = Math.random() * action.getClip().duration;
    }
    inst.phase = Math.random();
    this.live.set(a.id, inst);
    this.root.add(inst.obj);
    return inst;
  }

  private release(inst: Instance): void {
    this.root.remove(inst.obj);
    this.live.delete(inst.id);
    for (const [name, action] of inst.actions) {
      if (CLIP_BY_NAME.get(name)!.kind === 'overlay') action.stop();
    }
    const pool = this.pools[inst.variant];
    if (pool.length < this.poolMax) pool.push(inst);
    else this.destroy(inst);
  }

  private destroy(inst: Instance): void {
    inst.mixer.stopAllAction();
    inst.mixer.uncacheRoot(inst.mixer.getRoot());
    // Geometry and materials belong to the asset; skeletons are per clone.
    inst.obj.traverse((o) => (o as THREE.SkinnedMesh).skeleton?.dispose());
  }

  update(actors: readonly Actor[], playerId: number, alpha: number, time: number, frameDt: number, torches?: ReadonlySet<number>, torchLevel = 0): void {
    this.frameNo++;
    this.time = time;
    this.torches = torchLevel > 0.05 ? torches ?? null : null;
    this.beamMat.opacity = 0.07 * torchLevel;
    this.beams.count = 0;
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);

    const seen = this.seen;
    seen.clear();
    for (const a of actors) {
      if (a.id === playerId || a.vehicle >= 0) continue;
      if (!a.alive && time - a.diedAt > 12) continue;
      if (seen.size >= MAX) break;
      seen.add(a.id);
      this.draw(a, this.acquire(a), alpha, time, frameDt);
    }
    for (const inst of [...this.live.values()]) if (!seen.has(inst.id)) this.release(inst);
    this.beams.instanceMatrix.needsUpdate = true;
  }

  private draw(a: Actor, inst: Instance, alpha: number, time: number, frameDt: number): void {
    const m = a.move;
    const px = lerp(a.prevPos.x, m.pos.x, alpha);
    const py = lerp(a.prevPos.y, m.pos.y, alpha);
    const pz = lerp(a.prevPos.z, m.pos.z, alpha);
    let dy = a.yaw - a.prevYaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    else if (dy < -Math.PI) dy += Math.PI * 2;
    const yaw = a.prevYaw + dy * alpha;
    const sinceDeath = a.alive ? 0 : time - a.diedAt;
    const sink = sinceDeath > 8 ? (sinceDeath - 8) * 0.12 : 0;
    inst.obj.position.set(px, py - sink, pz);
    inst.obj.rotation.set(0, yaw, 0);

    // Ground velocity from how far the drawn position moved (works for mirrored actors too).
    if (inst.fresh || frameDt <= 0) {
      inst.lastX = px;
      inst.lastZ = pz;
    } else {
      const rvx = (px - inst.lastX) / frameDt;
      const rvz = (pz - inst.lastZ) / frameDt;
      inst.lastX = px;
      inst.lastZ = pz;
      if (Math.hypot(rvx, rvz) < TELEPORT_SPEED) {
        const k = Math.min(1, frameDt * 10);
        inst.vx += (rvx - inst.vx) * k;
        inst.vz += (rvz - inst.vz) * k;
      }
    }
    const airborne = !m.onGround && !m.onLadder && !m.inWater && m.mantleT <= 0 && !m.noclip;
    inst.airTime = airborne ? inst.airTime + frameDt : 0;

    this.applyLook(a, inst);
    this.applyGear(a, inst);

    // Cull: skip animating characters nobody can see. The margin grows with distance so a quick
    // turn doesn't catch anyone mid-pose (the camera moves after this runs).
    const dx = px - this.camera.position.x;
    const dz = pz - this.camera.position.z;
    const dist = Math.hypot(dx, dz);
    this.sphere.center.set(px, py + 0.9, pz);
    this.sphere.radius = 1.5 + dist * 0.3;
    const visible = dist < NEAR || (dist < CULL_DIST && this.frustum.intersectsSphere(this.sphere));
    inst.obj.visible = visible;
    inst.pending += frameDt;
    if (!visible) {
      inst.fresh = false;
      return;
    }
    if (inst.fresh || dist < LOD_DIST || (this.frameNo + inst.frame) % LOD_STEP === 0) {
      this.animate(a, inst, yaw, inst.pending, sinceDeath);
      inst.pending = 0;
    }
    inst.fresh = false;
    if (a.alive && this.torches?.has(a.id)) this.placeBeam(inst);
  }

  private applyLook(a: Actor, inst: Instance): void {
    const look: LookId = a.dummy ? 'dummy' : a.team === Team.Player ? 'ally' : a.team === Team.Civilian ? 'civ' : a.armor > 0 && a.helmet ? 'elite' : 'bot';
    if (inst.look === look) return;
    inst.look = look;
    const looks = this.asset(inst).looks;
    const pick = (mat: THREE.Material) => looks.get(mat.uuid)?.[look] ?? mat;
    for (const { mesh, base } of inst.meshes) mesh.material = Array.isArray(base) ? base.map(pick) : pick(base);
  }

  private applyGear(a: Actor, inst: Instance): void {
    for (const o of inst.helmet) o.visible = a.helmet;
    for (const o of inst.vest) o.visible = a.armor > 0;
    // The gun in hand: whatever slot is active; dead bodies that dropped their guns hold nothing.
    const item = a.inv[a.inv.active];
    const id = unarmed(a) || (!a.alive && !a.inv.primary && !a.inv.secondary) ? null : (item?.def.id ?? null);
    if (id !== inst.gunId) {
      inst.gunId = id;
      inst.gun.visible = id !== null;
      if (id) inst.gun.geometry = getGunModel(id).geometry;
    }
  }

  private animate(a: Actor, inst: Instance, yaw: number, dt: number, sinceDeath: number): void {
    const { actions, weights } = inst;
    const targets = new Map<string, number>();
    let cycleRate = 0;
    if (!a.alive) {
      if (!inst.dead) {
        inst.dead = true;
        for (const [name, action] of actions) if (CLIP_BY_NAME.get(name)!.kind === 'overlay') action.stop();
      }
      targets.set('Death', 1);
      const death = actions.get('Death')!;
      death.paused = false;
      death.time = Math.min(sinceDeath, death.getClip().duration);
    } else {
      if (inst.dead) {
        inst.dead = false;
        inst.fresh = true;
      }
      // Movement relative to facing: forward is -Z at yaw 0, right is +X.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const fwd = inst.vx * fx + inst.vz * fz;
      const side = inst.vx * -fz + inst.vz * fx;
      const pose = choosePose(
        { speed: Math.hypot(inst.vx, inst.vz), moveAngle: Math.atan2(side, fwd), crouch: a.move.duckAmount, airTime: inst.airTime },
        this.asset(inst).durations,
      );
      for (const [name, w] of Object.entries(pose.weights)) targets.set(name, w);
      cycleRate = pose.cycleRate;
    }

    // Ease the weights towards their targets (snap on the first frame), then renormalize so the
    // pose never sags towards the bind pose mid-blend.
    const k = inst.fresh ? 1 : Math.min(1, dt / (inst.dead ? DEATH_FADE : FADE));
    let total = 0;
    for (const [name, w] of weights) {
      const next = w + ((targets.get(name) ?? 0) - w) * k;
      weights.set(name, next < 1e-3 && !targets.has(name) ? 0 : next);
      total += weights.get(name)!;
    }
    inst.phase = (((inst.phase + cycleRate * dt) % 1) + 1) % 1;
    for (const [name, w] of weights) {
      const action = actions.get(name)!;
      action.setEffectiveWeight(total > 0 ? w / total : 0);
      if (CLIP_BY_NAME.get(name)!.kind === 'loco') action.time = inst.phase * action.getClip().duration;
    }
    // Pistols, knives and grenades: swap the rifle hold's arms for the item's own hold. Long guns
    // stay aimed standing still or firing, and drop to the ready carry on the move.
    const item = a.alive && !unarmed(a) ? a.inv[a.inv.active] : null;
    const moving = Math.hypot(inst.vx, inst.vz) > READY_SPEED;
    const firing = this.time - inst.shotAt < AIM_AFTER_SHOT;
    const hold = item ? (HOLD_BY_CATEGORY[item.def.category] ?? (moving && !firing ? READY_HOLD : undefined)) : undefined;
    for (const [name, w] of inst.holds) {
      const next = w + ((name === hold ? 1 : 0) - w) * k;
      inst.holds.set(name, next < 1e-3 ? 0 : next);
      actions.get(name)!.setEffectiveWeight(inst.holds.get(name)!);
    }
    // The mixer only writes a bone when its animated value changed, so take last frame's aim
    // bend back out first or it would pile up on any bone the current clips hold still.
    if (inst.unbent) {
      inst.spine.quaternion.copy(inst.unbent[0]);
      inst.chest?.quaternion.copy(inst.unbent[1]);
      inst.unbent = null;
    }
    if (inst.unhung) {
      inst.arms.forEach((arm, i) => arm.bone.quaternion.copy(inst.unhung![i]));
      inst.unhung = null;
    }
    inst.mixer.update(dt);

    // Nothing to hold (the clips all carry a gun): arms hang, swinging with the stride.
    if (a.alive && unarmed(a) && inst.arms.length) {
      inst.unhung = inst.arms.map((arm) => arm.bone.quaternion.clone());
      const swing = Math.sin(inst.phase * Math.PI * 2) * Math.min(1, Math.hypot(inst.vx, inst.vz) / 3) * 0.45;
      for (const arm of inst.arms) {
        arm.bone.quaternion.copy(arm.rest);
        if (arm.upper) this.bend(inst, arm.bone, swing * arm.upper);
      }
    }

    // Aim: bend Spine and Chest about the character's side axis (after the clips have posed them).
    if (a.alive) {
      inst.unbent = [inst.spine.quaternion.clone(), (inst.chest ?? inst.spine).quaternion.clone()];
      const pitch = Math.max(-MAX_AIM, Math.min(MAX_AIM, a.pitch));
      if (inst.chest) {
        this.bend(inst, inst.spine, pitch * 0.5);
        this.bend(inst, inst.chest, pitch * 0.5);
      } else {
        this.bend(inst, inst.spine, pitch);
      }
    }
  }

  /**
   * Rotate a bone by `angle` about the character's lateral axis. In the model's own space (the
   * glTF faces +Z) looking up is a rotation of -angle about +X; this is carried into the bone's
   * parent space through the chain of local rotations up to the glTF scene.
   */
  private bend(inst: Instance, bone: THREE.Object3D, angle: number): void {
    // P: the parent's rotation in glTF space (below the root's half turn).
    const parentQ = this.q.identity();
    for (let o = bone.parent; o && o !== inst.modelRoot; o = o.parent) parentQ.premultiply(o.quaternion);
    // Parent-space delta = P⁻¹ · R · P.
    const delta = this.q2.setFromAxisAngle(this.aimAxis, -angle).premultiply(this.q3.copy(parentQ).invert()).multiply(parentQ);
    bone.quaternion.premultiply(delta);
  }

  private placeBeam(inst: Instance): void {
    if (this.beams.count >= MAX) return;
    const socket = inst.torch ?? inst.weapon;
    socket.updateWorldMatrix(true, false);
    socket.matrixWorld.decompose(this.v, this.q, this.s);
    this.m.compose(this.v, this.q, this.s.set(1, 1, 1));
    this.m.multiply(inst.torch ? this.beamLocal : this.beamFromWeapon);
    this.beams.setMatrixAt(this.beams.count++, this.m);
  }

  onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'shot': {
        const inst = this.live.get(e.shooterId);
        if (inst) inst.shotAt = this.time;
        this.overlay(e.shooterId, 'Shoot');
        break;
      }
      case 'reload':
        this.overlay(e.actorId, 'Reload');
        break;
      case 'nade_throw':
        this.overlay(e.actorId, 'Throw');
        break;
      case 'hit':
        if (!e.killed) this.overlay(e.victimId, 'Hit');
        break;
    }
  }

  private overlay(id: number, clip: string): void {
    const inst = this.live.get(id);
    const action = inst?.actions.get(clip);
    if (!inst || !action || inst.dead) return;
    action.reset().setEffectiveWeight(1).play();
  }

  /** Current clip weights of one actor (dev viewer). */
  debugWeights(id: number): ReadonlyMap<string, number> | null {
    return this.live.get(id)?.weights ?? null;
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const inst of [...this.live.values(), ...this.pools.flat()]) {
      for (const { mesh } of inst.meshes) mesh.castShadow = on;
      inst.gun.castShadow = on;
    }
  }

  dispose(): void {
    for (const inst of [...this.live.values(), ...this.pools.flat()]) this.destroy(inst);
    this.live.clear();
    for (const pool of this.pools) pool.length = 0;
    this.gunMaterial.dispose();
    this.beams.geometry.dispose();
    this.beamMat.dispose();
    this.beams.dispose();
  }
}
