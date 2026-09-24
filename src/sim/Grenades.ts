import { HitGroup } from '../ai/hitboxes';
import { HU } from '../core/config';
import { anglesToForward, clamp01, DEG, vec3, type Vec3 } from '../core/math';
import { Contents, MASK_SHOT } from '../physics/brush';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { makeTrace, type TraceResult } from '../physics/trace';
import { MOVE } from '../player/movementConfig';
import { clipVelocity, eyeHeight } from '../player/pmove';
import { WEAPONS, type GrenadeId } from '../weapons/weaponDefs';
import type { Actor } from './Actor';
import type { Simulation } from './Simulation';
import { damageVehicle } from './vehicle/Vehicle';

/** Grenades collide with anything solid to players or bullets. */
const MASK_NADE = Contents.SOLID_PLAYER | Contents.SOLID_BULLET;
const HULL = 0.015;
const NADE_MINS = vec3(-HULL, -HULL, -HULL);
const NADE_MAXS = vec3(HULL, HULL, HULL);
/** CS grenades use gravity 0.4 and elasticity 0.45. */
export const NADE_GRAVITY = MOVE.gravity * 0.4;
const ELASTICITY = 0.45;
const REST_SPEED = 20 * HU;

export const HE_RADIUS = 350 * HU;
export const FLASH_RANGE = 25;
export const FLASH_MAX_DURATION = 4.5;
export const SMOKE_RADIUS = 3.2;
/** Smoke cloud centre above the grenade's resting point. */
const SMOKE_LIFT = 1.2;
export const SMOKE_DURATION = 18;
const SMOKE_GROW = 1;
const SMOKE_FADE = 2;
/** Smoke pops once the grenade has been still this long (or at the latest after SMOKE_MAX_FUSE). */
const SMOKE_REST_FUSE = 0.5;
const SMOKE_MAX_FUSE = 5;
export const FIRE_RADIUS = 3;
/** HE damage to a car at the center of the blast. */
const HE_CAR_DAMAGE = 280;
export const FIRE_DURATION = 7;
const FIRE_TICK = 0.25;

export interface Projectile {
  id: number;
  kind: GrenadeId;
  owner: Actor;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  spawnTime: number;
  /** Sim time it came to rest, or -1 while moving. */
  restTime: number;
}

export interface SmokeCloud {
  id: number;
  pos: Vec3;
  start: number;
  end: number;
}

export interface Fire {
  id: number;
  pos: Vec3;
  radius: number;
  start: number;
  end: number;
  owner: Actor;
  nextTick: number;
}

/** What a single physics step ran into (for bounce sounds and molotov bursts). */
export interface StepImpact {
  hit: boolean;
  floor: boolean;
  speed: number;
  material: number;
  chunkKey: number;
  normal: Vec3;
}

const tmpVel = vec3();
const tmpEnd = vec3();

/**
 * Advance a grenade one tick: gravity, swept hull, bounces. Shared by the live sim and by
 * `simulateThrow` (bots aiming, tests), so predictions match real flights exactly.
 */
export function stepProjectile(world: CollisionWorld, pos: Vec3, vel: Vec3, dt: number, tr: TraceResult, impact: StepImpact): boolean {
  impact.hit = false;
  impact.floor = false;
  // Half the gravity before and after the move (symplectic-ish, stable at any tick rate).
  vel.y -= NADE_GRAVITY * dt * 0.5;
  let remaining = dt;
  let moving = true;
  for (let bump = 0; bump < 4 && remaining > 0; bump++) {
    tmpEnd.x = pos.x + vel.x * remaining;
    tmpEnd.y = pos.y + vel.y * remaining;
    tmpEnd.z = pos.z + vel.z * remaining;
    world.traceBox(tr, pos, tmpEnd, NADE_MINS, NADE_MAXS, MASK_NADE);
    if (tr.allSolid) {
      vel.x = vel.y = vel.z = 0;
      moving = false;
      break;
    }
    pos.x = tr.endX;
    pos.y = tr.endY;
    pos.z = tr.endZ;
    if (tr.fraction >= 1) break;
    remaining -= remaining * tr.fraction;
    const n = tr.normal;
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (!impact.hit || speed > impact.speed) {
      impact.hit = true;
      impact.speed = speed;
      impact.material = tr.brush?.material ?? 0;
      impact.chunkKey = tr.brush?.chunkKey ?? 0;
      impact.normal.x = n.x;
      impact.normal.y = n.y;
      impact.normal.z = n.z;
    }
    clipVelocity(vel, n, tmpVel, 2);
    vel.x = tmpVel.x * ELASTICITY;
    vel.y = tmpVel.y * ELASTICITY;
    vel.z = tmpVel.z * ELASTICITY;
    if (n.y > 0.7) {
      impact.floor = true;
      // Landed: stop once it is barely moving, and don't keep hopping on tiny bounces.
      if (vel.y < 60 * HU) vel.y = 0;
      if (Math.hypot(vel.x, vel.y, vel.z) < REST_SPEED) {
        vel.x = vel.y = vel.z = 0;
        moving = false;
        break;
      }
      // Rolling friction.
      vel.x *= 0.85;
      vel.z *= 0.85;
    }
  }
  if (moving) vel.y -= NADE_GRAVITY * dt * 0.5;
  return moving;
}

/** Launch velocity for a throw, CS style: aim is pitched up 10°, speed scales with pitch and strength. */
export function throwVelocity(yaw: number, pitch: number, strength: number, ownerVel: Vec3 | null, out: Vec3): Vec3 {
  // CS pitch is positive looking down; ours is positive looking up.
  let p = -pitch / DEG;
  p = p < 0 ? -10 + p * (80 / 90) : -10 + p * (100 / 90);
  const speed = Math.min(750, (90 - p) * 6) * HU * (0.3 + 0.7 * strength);
  anglesToForward(out, yaw, -p * DEG);
  out.x *= speed;
  out.y *= speed;
  out.z *= speed;
  if (ownerVel) {
    out.x += ownerVel.x * 1.25;
    out.y += ownerVel.y * 1.25;
    out.z += ownerVel.z * 1.25;
  }
  return out;
}

/** Where a throw starts: 16 HU in front of the eye, pulled back if that is inside a wall. */
export function throwOrigin(world: CollisionWorld, eye: Vec3, yaw: number, pitch: number, out: Vec3): Vec3 {
  const f = anglesToForward(vec3(), yaw, pitch);
  const tr = makeTrace();
  const end = vec3(eye.x + f.x * 16 * HU, eye.y + f.y * 16 * HU, eye.z + f.z * 16 * HU);
  world.traceBox(tr, eye, end, NADE_MINS, NADE_MAXS, MASK_NADE);
  out.x = tr.endX;
  out.y = tr.endY;
  out.z = tr.endZ;
  return out;
}

export interface ThrowPrediction {
  /** Where it detonates (or comes to rest). */
  pos: Vec3;
  time: number;
}

/**
 * Fly a grenade offline and report where it goes off: fuse for HE and flashes, first floor hit
 * for molotovs, resting point for smokes.
 */
export function simulateThrow(world: CollisionWorld, kind: GrenadeId, start: Vec3, vel: Vec3, dt: number, maxT = 6): ThrowPrediction {
  const pos = vec3(start.x, start.y, start.z);
  const v = vec3(vel.x, vel.y, vel.z);
  const tr = makeTrace();
  const impact = newImpact();
  const fuse = WEAPONS[kind].fuse ?? 2;
  let t = 0;
  while (t < maxT) {
    t += dt;
    const moving = stepProjectile(world, pos, v, dt, tr, impact);
    if (kind === 'molotov' && impact.hit && impact.floor) break;
    if ((kind === 'hegrenade' || kind === 'flashbang' || kind === 'molotov') && t >= fuse) break;
    if (kind === 'smokegrenade' && !moving) break;
  }
  return { pos, time: t };
}

const newImpact = (): StepImpact => ({ hit: false, floor: false, speed: 0, material: 0, chunkKey: 0, normal: vec3() });

/** Current flash whiteness (0..1) for an actor. Full white for the first third, then fades. */
export function flashAmount(a: Actor, t: number): number {
  if (t >= a.flashUntil || a.flashUntil <= a.flashStart) return 0;
  const dur = a.flashUntil - a.flashStart;
  const k = (t - a.flashStart) / dur;
  const fade = k < 0.35 ? 1 : 1 - (k - 0.35) / 0.65;
  return a.flashPeak * fade;
}

/** A smoke's current radius (grows in, shrinks out). */
export function smokeRadius(s: SmokeCloud, t: number): number {
  if (t < s.start || t >= s.end) return 0;
  const grow = clamp01((t - s.start) / SMOKE_GROW);
  const fade = clamp01((s.end - t) / SMOKE_FADE);
  return SMOKE_RADIUS * Math.sqrt(grow) * (0.35 + 0.65 * fade);
}

/** Squared distance from point p to segment ab. */
function segPointDist2(ax: number, ay: number, az: number, bx: number, by: number, bz: number, p: Vec3): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 1e-9 ? ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t - p.x;
  const cy = ay + dy * t - p.y;
  const cz = az + dz * t - p.z;
  return cx * cx + cy * cy + cz * cz;
}

/**
 * Thrown grenades and what they leave behind (smoke clouds, fires). Owned by the Simulation so it
 * works in every world; runs after actors each tick.
 */
export class GrenadeSystem {
  readonly projectiles: Projectile[] = [];
  readonly smokes: SmokeCloud[] = [];
  readonly fires: Fire[] = [];
  /** Bumped whenever a fire starts or ends (bots replan paths). */
  fireVersion = 0;
  private nextId = 1;
  private tr = makeTrace();
  private impact = newImpact();

  constructor(private sim: Simulation) {}

  throw(a: Actor, kind: GrenadeId, strength: number, yaw: number, pitch: number): Projectile {
    const eye = vec3(a.move.pos.x, a.move.pos.y + eyeHeight(a.move), a.move.pos.z);
    const pos = throwOrigin(this.sim.world, eye, yaw, pitch, vec3());
    const vel = throwVelocity(yaw, pitch, strength, a.move.vel, vec3());
    const p: Projectile = {
      id: this.nextId++,
      kind,
      owner: a,
      pos,
      prevPos: vec3(pos.x, pos.y, pos.z),
      vel,
      spawnTime: this.sim.time,
      restTime: -1,
    };
    this.projectiles.push(p);
    return p;
  }

  clear(): void {
    this.projectiles.length = 0;
    this.smokes.length = 0;
    if (this.fires.length) this.fireVersion++;
    this.fires.length = 0;
  }

  update(): void {
    const sim = this.sim;
    const t = sim.time;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.prevPos.x = p.pos.x;
      p.prevPos.y = p.pos.y;
      p.prevPos.z = p.pos.z;
      const age = t - p.spawnTime;
      const fuse = WEAPONS[p.kind].fuse ?? 2;
      let moving = p.restTime < 0;
      if (moving) {
        moving = stepProjectile(sim.world, p.pos, p.vel, sim.dt, this.tr, this.impact);
        const im = this.impact;
        if (im.hit && im.speed > 1) {
          sim.events.push({ type: 'nade_bounce', pos: vec3(p.pos.x, p.pos.y, p.pos.z), speed: im.speed, material: im.material });
          sim.events.push({ type: 'sound', pos: vec3(p.pos.x, p.pos.y, p.pos.z), radius: 12, kind: 'grenade', sourceId: p.owner.id });
        }
        if (!moving) p.restTime = t;
        if (p.kind === 'molotov' && im.hit && im.floor) {
          this.projectiles.splice(i, 1);
          this.burst(p, im.normal, im.chunkKey);
          continue;
        }
      }
      let boom = false;
      if (p.kind === 'smokegrenade') boom = (p.restTime >= 0 && t - p.restTime >= SMOKE_REST_FUSE) || age >= SMOKE_MAX_FUSE;
      else boom = age >= fuse;
      if (!boom) continue;
      this.projectiles.splice(i, 1);
      this.detonate(p);
    }

    for (let i = this.smokes.length - 1; i >= 0; i--) if (t >= this.smokes[i].end) this.smokes.splice(i, 1);
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (t >= f.end) {
        this.fires.splice(i, 1);
        this.fireVersion++;
        continue;
      }
      if (t >= f.nextTick) {
        f.nextTick += FIRE_TICK;
        this.burn(f);
      }
    }
  }

  private detonate(p: Projectile): void {
    const sim = this.sim;
    const pos = vec3(p.pos.x, p.pos.y, p.pos.z);
    switch (p.kind) {
      case 'hegrenade':
        this.explode(p, pos);
        break;
      case 'flashbang':
        this.flash(pos);
        break;
      case 'smokegrenade':
        this.smokes.push({ id: this.nextId++, pos: vec3(pos.x, pos.y + SMOKE_LIFT, pos.z), start: sim.time, end: sim.time + SMOKE_DURATION });
        this.extinguish();
        break;
      case 'molotov':
        // Fuse ran out in the air: it bursts without catching.
        sim.events.push({ type: 'nade_detonate', kind: p.kind, pos, airburst: true, normal: null, chunkKey: 0 });
        sim.events.push({ type: 'sound', pos, radius: 30, kind: 'grenade', sourceId: p.owner.id });
        return;
    }
    const radius = p.kind === 'hegrenade' ? 90 : p.kind === 'flashbang' ? 60 : 30;
    sim.events.push({ type: 'nade_detonate', kind: p.kind, pos, airburst: false, normal: this.floorBelow(pos), chunkKey: this.tr.brush?.chunkKey ?? 0 });
    sim.events.push({ type: 'sound', pos, radius, kind: 'grenade', sourceId: p.owner.id });
  }

  /** Normal of the surface just below pos (for scorch decals), or null when airborne. */
  private floorBelow(pos: Vec3): Vec3 | null {
    this.sim.world.traceRay(this.tr, pos, vec3(pos.x, pos.y - 0.6, pos.z), MASK_SHOT);
    if (this.tr.fraction >= 1) return null;
    return vec3(this.tr.normal.x, this.tr.normal.y, this.tr.normal.z);
  }

  private explode(p: Projectile, pos: Vec3): void {
    const sim = this.sim;
    const from = vec3(pos.x, pos.y + 0.05, pos.z);
    const to = vec3();
    for (const v of sim.actors) {
      if (!v.alive || v === p.owner || !sim.canHit(p.owner, v)) continue;
      // Nearest of chest and head that the blast can reach.
      let best = Infinity;
      for (const h of [1.0, eyeHeight(v.move)]) {
        to.x = v.move.pos.x;
        to.y = v.move.pos.y + h;
        to.z = v.move.pos.z;
        const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
        if (d >= HE_RADIUS || d >= best) continue;
        sim.world.traceRay(this.tr, from, to, MASK_SHOT);
        if (this.tr.fraction >= 0.999) best = d;
      }
      if (best === Infinity) continue;
      sim.onHit({
        attacker: p.owner,
        victim: v,
        def: WEAPONS.hegrenade,
        group: HitGroup.Chest,
        distance: best,
        damageScale: 1 - best / HE_RADIUS,
        penetrated: false,
        pos: vec3(v.move.pos.x, v.move.pos.y + 1, v.move.pos.z),
      });
    }
    // Cars in the blast (their boxes don't shield themselves).
    const reach = HE_RADIUS + 1.5;
    for (const car of sim.vehicles) {
      const c = car.car.pos;
      const d = Math.hypot(c.x - from.x, c.y + 0.6 - from.y, c.z - from.z);
      if (d < reach) damageVehicle(sim, car, HE_CAR_DAMAGE * (1 - d / reach), p.owner.id);
    }
  }

  /** A fire that isn't from a molotov (a burning car). */
  ignite(pos: Vec3, owner: Actor, duration: number, radius = FIRE_RADIUS): void {
    const t = this.sim.time;
    this.fires.push({ id: this.nextId++, pos, radius, start: t, end: t + duration, owner, nextTick: t });
    this.fireVersion++;
  }

  private flash(pos: Vec3): void {
    const sim = this.sim;
    const eye = vec3();
    const fwd = vec3();
    for (const v of sim.actors) {
      if (!v.alive || v.dummy) continue;
      eye.x = v.move.pos.x;
      eye.y = v.move.pos.y + eyeHeight(v.move);
      eye.z = v.move.pos.z;
      const dx = pos.x - eye.x;
      const dy = pos.y - eye.y;
      const dz = pos.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > FLASH_RANGE) continue;
      sim.world.traceRay(this.tr, pos, eye, MASK_SHOT);
      if (this.tr.fraction < 0.999 || this.blocksSight(pos, eye)) continue;
      anglesToForward(fwd, v.yaw, v.pitch);
      const facing = d > 1e-3 ? (fwd.x * dx + fwd.y * dy + fwd.z * dz) / d : 1;
      const faceK = 0.35 + 0.65 * clamp01((facing + 0.3) / 1.0);
      const distK = d < 5 ? 1 : 1 - (d - 5) / (FLASH_RANGE - 5);
      const strength = faceK * distK;
      if (strength < 0.05) continue;
      const duration = Math.max(0.3, FLASH_MAX_DURATION * strength);
      // A weaker flash never cuts a stronger one short.
      if (sim.time + duration > v.flashUntil) {
        v.flashStart = sim.time;
        v.flashUntil = sim.time + duration;
        v.flashPeak = Math.min(1, 0.3 + strength);
      }
      sim.events.push({ type: 'flashed', actorId: v.id, strength, duration });
    }
  }

  private burst(p: Projectile, normal: Vec3, chunkKey: number): void {
    const sim = this.sim;
    const pos = vec3(p.pos.x, p.pos.y, p.pos.z);
    sim.events.push({ type: 'sound', pos, radius: 40, kind: 'grenade', sourceId: p.owner.id });
    if (this.smokeAt(pos, FIRE_RADIUS * 0.5)) {
      sim.events.push({ type: 'nade_detonate', kind: p.kind, pos, airburst: true, normal: null, chunkKey });
      return;
    }
    sim.events.push({ type: 'nade_detonate', kind: p.kind, pos, airburst: false, normal: vec3(normal.x, normal.y, normal.z), chunkKey });
    this.fires.push({
      id: this.nextId++,
      pos,
      radius: FIRE_RADIUS,
      start: sim.time,
      end: sim.time + FIRE_DURATION,
      owner: p.owner,
      nextTick: sim.time,
    });
    this.fireVersion++;
  }

  private burn(f: Fire): void {
    const sim = this.sim;
    const def = WEAPONS.molotov;
    for (const v of sim.actors) {
      if (!v.alive || !sim.canHit(f.owner, v)) continue;
      if (!this.firePointHits(f, v.move.pos)) continue;
      sim.onHit({
        attacker: f.owner,
        victim: v,
        def,
        group: HitGroup.Chest,
        distance: 0,
        damageScale: 1,
        penetrated: false,
        pos: vec3(v.move.pos.x, v.move.pos.y + 0.3, v.move.pos.z),
      });
    }
  }

  private firePointHits(f: Fire, p: Vec3): boolean {
    const dy = p.y - f.pos.y;
    return dy > -0.6 && dy < 1.2 && Math.hypot(p.x - f.pos.x, p.z - f.pos.z) < f.radius;
  }

  /** Put out fires that a smoke covers. */
  private extinguish(): void {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (!this.smokeAt(f.pos, f.radius * 0.5)) continue;
      this.fires.splice(i, 1);
      this.fireVersion++;
      this.sim.events.push({ type: 'fire_out', pos: vec3(f.pos.x, f.pos.y, f.pos.z) });
    }
  }

  private smokeAt(p: Vec3, slack: number): boolean {
    for (const s of this.smokes) {
      const r = SMOKE_RADIUS + slack;
      if (Math.hypot(p.x - s.pos.x, p.z - s.pos.z) < r && Math.abs(p.y - (s.pos.y - SMOKE_LIFT)) < 2) return true;
    }
    return false;
  }

  // ---- Queries for AI ----

  /** True if a smoke cloud hides b from a. */
  blocksSight(a: Vec3, b: Vec3): boolean {
    const t = this.sim.time;
    for (const s of this.smokes) {
      const r = smokeRadius(s, t) * 0.9;
      if (r <= 0) continue;
      if (segPointDist2(a.x, a.y, a.z, b.x, b.y, b.z, s.pos) < r * r) return true;
    }
    return false;
  }

  /** True if (x, z) near height y is on fire. */
  inFire(x: number, y: number, z: number, margin = 0): boolean {
    for (const f of this.fires) {
      const dy = y - f.pos.y;
      if (dy > -1.5 && dy < 1.5 && Math.hypot(x - f.pos.x, z - f.pos.z) < f.radius + margin) return true;
    }
    return false;
  }

  /** Nearest live HE or molotov within range of a point (bots dodge them). */
  dangerNear(x: number, z: number, range: number): Projectile | null {
    let best: Projectile | null = null;
    let bestD = range;
    for (const p of this.projectiles) {
      if (p.kind !== 'hegrenade' && p.kind !== 'molotov') continue;
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}
