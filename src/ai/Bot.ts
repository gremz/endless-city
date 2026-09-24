import { HU } from '../core/config';
import { clamp, DEG, vec3, wrapAngle, type Vec3 } from '../core/math';
import { hash3, Salt, sfc32, type Rand } from '../core/rng';
import { Buttons, makeCmd, SELECT_LAST, type UserCmd } from '../input/UserCmd';
import { MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { eyeHeight, playerMove } from '../player/pmove';
import type { Actor } from '../sim/Actor';
import { flashAmount, simulateThrow, throwOrigin, throwVelocity } from '../sim/Grenades';
import type { Simulation } from '../sim/Simulation';
import { activeItem, grenadeTotal, syncGrenade } from '../weapons/Inventory';
import type { GrenadeId } from '../weapons/weaponDefs';
import { nearestLampDist } from '../world/gen/streets';
import { visibilityAt } from '../sim/Environment';
import { getPattern, patternAt } from '../weapons/sprayPatterns';
import { updateWeapon } from '../weapons/WeaponSystem';
import type { BotSkill } from './difficulty';
import { bodyScale } from './hitboxes';
import type { AStar, PathPoint } from './nav/astar';
import { findCover, type CoverSpot } from './nav/cover';
import { cellCenter } from './nav/NavGrid';

export type BotState = 'idle' | 'patrol' | 'alert' | 'engage' | 'cover' | 'flank' | 'retreat' | 'overwatch';
export type BotRole = 'anchor' | 'patroller' | 'flanker' | 'overwatch';

export interface Squad {
  id: number;
  chunkKey: number;
  homeCx: number;
  homeCz: number;
  members: Bot[];
  lastKnown: Vec3 | null;
  lastKnownTime: number;
  /** Pending callout: when it lands, all members learn lastKnown. */
  calloutAt: number;
  /** Last time any member saw the player. */
  lastSeen: number;
  /** Earliest time the squad throws its next grenade (one at a time, spaced out). */
  nextNadeAt?: number;
}

/** A grenade throw being carried out: switch to it, aim, pull the pin, release. */
interface ThrowPlan {
  kind: GrenadeId;
  yaw: number;
  pitch: number;
  /** 1 full throw (attack), 0.4 lob (attack2). */
  strength: number;
  start: number;
  /** When the pin was pulled, or -1. */
  pinAt: number;
  /** When it left the hand, or -1. */
  thrownAt: number;
  count: number;
}

/** Bots are blinded (no vision, no shooting) above this flash whiteness. */
const BLIND = 0.35;

/** A player's position history (per tick) used for the bots' tracking delay. */
export class TargetHistory {
  private xs = new Float32Array(64);
  private ys = new Float32Array(64);
  private zs = new Float32Array(64);
  private eyes = new Float32Array(64);
  private scales = new Float32Array(64);
  private count = 0;

  record(a: Actor, tick: number): void {
    const i = tick & 63;
    this.xs[i] = a.move.pos.x;
    this.ys[i] = a.move.pos.y;
    this.zs[i] = a.move.pos.z;
    this.eyes[i] = eyeHeight(a.move);
    this.scales[i] = bodyScale(a.move);
    this.count++;
  }

  /** Position `ticksAgo` ticks back (clamped to what's recorded). */
  at(tick: number, ticksAgo: number, out: Vec3): { eye: number; scale: number } {
    const back = Math.min(ticksAgo, Math.min(63, this.count - 1));
    const i = (tick - back) & 63;
    out.x = this.xs[i];
    out.y = this.ys[i];
    out.z = this.zs[i];
    return { eye: this.eyes[i], scale: this.scales[i] };
  }
}

export interface BotContext {
  sim: Simulation;
  astar: AStar;
  /** Position history per player actor id. */
  histories: ReadonlyMap<number, TargetHistory>;
  /** Remaining path queries this tick (shared budget). */
  pathBudget: number;
}

const tr = makeTrace();
const va = vec3();
const vb = vec3();
const tgt = vec3();
const recoil = { pitch: 0, yaw: 0 };
const moveDir = { x: 0, z: 0 };
const lookHeights = [0, 0, 0];
const eyeTmp = vec3();
const startTmp = vec3();
const velTmp = vec3();

/**
 * A bot: an Actor driven by a brain that produces a UserCmd every tick, then runs the same
 * movement and weapon code as the player.
 */
export class Bot {
  readonly cmd: UserCmd = makeCmd();
  state: BotState = 'idle';
  stateSince = 0;
  readonly r: Rand;

  // Perception.
  /** The player this bot is fighting (last one seen or that hurt it), or null. */
  target: Actor | null = null;
  awareness = 0;
  visible = false;
  lastSeen = -100;
  lastKnown: Vec3 | null = null;
  heardAt = -100;

  // Aim.
  aimYaw: number;
  aimPitch = 0;
  reactionEnd = 0;
  acquiredAt = -100;
  errYaw = 0;
  errPitch = 0;
  headAim = false;
  burstLeft = 0;
  nextBurstAt = 0;
  private lastShotCount = 0;
  private wasVisible = false;

  // Navigation.
  path: PathPoint[] = [];
  pathIdx = 0;
  goal: Vec3 | null = null;
  repathAt = 0;
  private progressPos = vec3();
  private progressAt = 0;
  stuckCount = 0;
  private unstickUntil = 0;
  private unstickDir = 1;
  cover: CoverSpot | null = null;
  coverUntil = 0;
  strafeDir = 1;
  strafeUntil = 0;
  patrolIdx = 0;
  lookYaw: number;
  private thinkPhase: number;

  // Grenades.
  throwPlan: ThrowPlan | null = null;
  private nextThrowCheck = 0;
  private lookAwayUntil = 0;
  private lookAwayYaw = 0;
  private fireSeen = 0;
  /** Where the player has been holding (for molotovs), and since when. */
  private campAnchor: Vec3 | null = null;
  private campSince = 0;

  constructor(
    readonly actor: Actor,
    readonly skill: BotSkill,
    readonly squad: Squad,
    public role: BotRole,
    readonly post: Vec3,
    readonly patrol: PathPoint[],
    seed: number,
  ) {
    this.r = sfc32(hash3(seed, actor.id, squad.id, Salt.Bot));
    this.aimYaw = this.lookYaw = actor.yaw;
    this.thinkPhase = actor.id & 3;
    if (role === 'overwatch') this.state = 'overwatch';
    else if (role === 'patroller') this.state = 'patrol';
  }

  private setState(s: BotState, now: number): void {
    if (this.state === s) return;
    this.state = s;
    this.stateSince = now;
    this.path = [];
    this.goal = null;
    this.cover = null;
  }

  /** Forget the players (after they all die): go back to posting/patrolling. */
  reset(now: number): void {
    if (this.throwPlan) this.cancelThrow();
    this.target = null;
    this.awareness = 0;
    this.lastKnown = null;
    this.visible = false;
    this.setState(this.role === 'overwatch' ? 'overwatch' : this.role === 'patroller' ? 'patrol' : 'idle', now);
  }

  /** Called when the bot takes damage: it now knows roughly where the shooter is. */
  onDamaged(attacker: Actor, now: number): void {
    const from = attacker.move.pos;
    // Turn on whoever is shooting unless the current target is right in view.
    if (attacker.team !== this.actor.team && (!this.target || !this.visible)) this.target = attacker;
    this.awareness = Math.max(this.awareness, 1);
    this.lastKnown = vec3(from.x, from.y, from.z);
    this.squad.lastKnown = this.lastKnown;
    this.squad.lastKnownTime = now;
    this.squad.calloutAt = Math.min(this.squad.calloutAt, now + 0.3);
    if (this.state === 'idle' || this.state === 'patrol') this.setState('alert', now);
  }

  /**
   * A sound a player made. `reveal` is false for sounds that don't give away where the
   * player is (a grenade going off somewhere): they only put the bot on edge.
   */
  hear(pos: Vec3, radius: number, now: number, reveal = true): void {
    const a = this.actor.move.pos;
    const d = Math.hypot(pos.x - a.x, pos.z - a.z);
    if (d > radius) return;
    if (!reveal) {
      this.awareness = Math.max(this.awareness, 0.35);
      this.heardAt = now;
      return;
    }
    const jitter = d * 0.15;
    const guess = vec3(pos.x + (this.r() - 0.5) * jitter, pos.y, pos.z + (this.r() - 0.5) * jitter);
    this.awareness = Math.max(this.awareness, radius > 30 ? 0.6 : 0.4);
    if (!this.visible) this.lastKnown = guess;
    this.heardAt = now;
    if (this.squad.calloutAt > now + 0.6) this.squad.calloutAt = now + 0.6;
    if (!this.squad.lastKnown || now - this.squad.lastKnownTime > 1) {
      this.squad.lastKnown = guess;
      this.squad.lastKnownTime = now;
    }
  }

  // -------------------------------------------------------------- perception

  private perceive(ctx: BotContext, dt: number): void {
    const sim = ctx.sim;
    const a = this.actor;
    this.visible = false;
    if (this.target && !this.target.alive) this.target = null;
    if (!sim.players.some((p) => p.alive)) {
      this.awareness = Math.max(0, this.awareness - dt * 0.2);
      return;
    }
    if (flashAmount(a, sim.time) > BLIND) return;
    // Stick with the current target while it's in view, otherwise take the closest one seen.
    let p: Actor | null = null;
    let dist = Infinity;
    if (this.target) {
      const d = this.sees(sim, this.target);
      if (d >= 0) {
        p = this.target;
        dist = d;
      }
    }
    if (!p) {
      for (const q of sim.players) {
        if (!q.alive || q === this.target) continue;
        const d = this.sees(sim, q);
        if (d >= 0 && d < dist) {
          p = q;
          dist = d;
        }
      }
    }
    if (p) {
      this.target = p;
      this.visible = true;
      const env = sim.env;
      const speed = Math.hypot(p.move.vel.x, p.move.vel.z);
      const moving = speed > 150 * HU ? 1.3 : 1;
      const close = clamp(18 / Math.max(1, dist), 0.35, 3);
      // Harder to pick out in the dark, much easier with a torch in your hand.
      const light = p.flashlight && env.darkness > 0.3 ? 1.5 : 1 - 0.4 * env.darkness;
      this.awareness = Math.min(1.5, this.awareness + dt * this.skill.awareness * close * moving * light);
      this.lastSeen = sim.time;
      this.lastKnown = vec3(p.move.pos.x, p.move.pos.y, p.move.pos.z);
      if (this.awareness >= 0.3) {
        this.squad.lastKnown = this.lastKnown;
        this.squad.lastKnownTime = sim.time;
        this.squad.lastSeen = sim.time;
        if (this.squad.calloutAt > sim.time + 0.6) this.squad.calloutAt = sim.time + 0.6;
      }
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.04);
    }
  }

  /** Horizontal distance to a player this bot can see right now, or -1. */
  private sees(sim: Simulation, p: Actor): number {
    const a = this.actor;
    const ex = a.move.pos.x;
    const ey = a.move.pos.y + eyeHeight(a.move);
    const ez = a.move.pos.z;
    const dx = p.move.pos.x - ex;
    const dz = p.move.pos.z - ez;
    const dist = Math.hypot(dx, dz);
    // Darkness and fog shorten how far the bot can make you out; a flashlight gives you away.
    const env = sim.env;
    const dark = env.darkness > 0.05 || env.fog > 0.05;
    const vis = dark ? visibilityAt(env, nearestLampDist(p.move.pos.x, p.move.pos.z), p.flashlight) : 1;
    if (dist > this.skill.visionRange * vis) return -1;
    // Field of view against the current view direction (very close = always noticed).
    const ang = Math.atan2(-dx, -dz);
    const off = Math.abs(wrapAngle(ang - this.aimYaw));
    if (off > (this.skill.fov * DEG) / 2 && dist >= 2.5) return -1;
    const k = bodyScale(p.move);
    va.x = ex;
    va.y = ey;
    va.z = ez;
    lookHeights[0] = eyeHeight(p.move) + 0.05;
    lookHeights[1] = 1.2 * k;
    lookHeights[2] = 0.4;
    for (const h of lookHeights) {
      vb.x = p.move.pos.x;
      vb.y = p.move.pos.y + h;
      vb.z = p.move.pos.z;
      sim.world.traceRay(tr, va, vb, MASK_SHOT);
      if (tr.fraction >= 0.999 && !sim.grenades.blocksSight(va, vb)) return dist;
    }
    return -1;
  }

  // -------------------------------------------------------------- decisions

  private think(ctx: BotContext, dt: number): void {
    const sim = ctx.sim;
    const now = sim.time;
    const a = this.actor;
    this.perceive(ctx, dt);

    // Squad callout: learn where the player was.
    if (now >= this.squad.calloutAt && this.squad.lastKnown && !this.visible) {
      if (!this.lastKnown || this.squad.lastKnownTime > this.lastSeen) this.lastKnown = this.squad.lastKnown;
      this.awareness = Math.max(this.awareness, 0.45);
    }

    this.trackCamping(now);
    if (!this.throwPlan && now >= this.nextThrowCheck && this.wantsToThrow(now)) this.planThrow(ctx, now);

    const item = activeItem(a.inv);
    const lowAmmo = item.def.magSize > 0 && item.clip <= Math.max(2, item.def.magSize * 0.25);
    const hp = a.health;
    const alive = this.squad.members.filter((m) => m.actor.alive).length;

    if (this.state === 'overwatch') {
      if (lowAmmo && !this.visible) this.cmd.pressed |= Buttons.RELOAD;
      return;
    }

    if (this.visible && this.awareness >= 1) {
      if (this.state !== 'engage' && this.state !== 'cover') this.setState('engage', now);
      if (this.state === 'engage') {
        if (hp < 25 && alive > 1 && now - this.stateSince > 1.5) this.setState('retreat', now);
        else if ((hp < 50 || lowAmmo) && now - this.stateSince > 1.2 && now > this.coverUntil) this.setState('cover', now);
      }
      return;
    }

    switch (this.state) {
      case 'idle':
      case 'patrol':
        if (this.awareness >= 0.3 && this.lastKnown) this.setState('alert', now);
        break;
      case 'engage':
        if (now - this.lastSeen > 1.5) {
          if (this.role === 'flanker' && this.skill.canFlank && alive >= 3 && this.lastKnown) this.setState('flank', now);
          else this.setState('alert', now);
        }
        break;
      case 'cover':
        if (now > this.coverUntil && this.cover && this.coverUntil > 0) this.setState(this.lastKnown ? 'alert' : 'patrol', now);
        break;
      case 'alert':
        if (now - Math.max(this.lastSeen, this.heardAt, this.squad.lastKnownTime) > 15) {
          this.awareness = 0.2;
          this.setState(this.role === 'patroller' ? 'patrol' : 'idle', now);
        }
        break;
      case 'flank':
        if (now - this.stateSince > 12) this.setState('alert', now);
        break;
      case 'retreat':
        if (now - this.stateSince > 5) this.setState('cover', now);
        break;
    }
    if (lowAmmo && !this.visible && item.clip < item.def.magSize) this.cmd.pressed |= Buttons.RELOAD;
  }

  // -------------------------------------------------------------- navigation

  private requestPath(ctx: BotContext, target: Vec3, extra?: (gx: number, gz: number) => number): boolean {
    if (ctx.pathBudget <= 0) return false;
    ctx.pathBudget--;
    const m = this.actor.move.pos;
    const g = ctx.sim.grenades;
    const y = m.y;
    const hazard = g.fires.length ? (cx: number, cz: number) => g.inFire(cellCenter(cx), y, cellCenter(cz), 0.3) : undefined;
    const res = ctx.astar.find(m.x, m.y, m.z, target.x, target.y, target.z, this.squad.homeCx, this.squad.homeCz, { extraCost: extra, hazard });
    this.pathIdx = 0;
    this.path = res ? res.points : [];
    this.repathAt = ctx.sim.time + 4;
    return this.path.length > 0;
  }

  private goTo(ctx: BotContext, target: Vec3, extra?: (gx: number, gz: number) => number): void {
    const now = ctx.sim.time;
    const changed = !this.goal || Math.hypot(this.goal.x - target.x, this.goal.z - target.z) > 2;
    if (changed || (this.path.length === 0 && now >= this.repathAt) || now >= this.repathAt) {
      if (this.requestPath(ctx, target, extra)) this.goal = vec3(target.x, target.y, target.z);
      else if (changed) this.goal = null;
    }
  }

  /** Direction (world XZ, unit or zero) along the current path. Returns remaining distance. */
  private followPath(out: { x: number; z: number }): number {
    const m = this.actor.move.pos;
    while (this.pathIdx < this.path.length) {
      const p = this.path[this.pathIdx];
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d < 0.4 && Math.abs(p.y - m.y) < 1.2 && this.pathIdx < this.path.length - 1) {
        this.pathIdx++;
        continue;
      }
      if (d < 0.35) break;
      out.x = (p.x - m.x) / d;
      out.z = (p.z - m.z) / d;
      let rest = d;
      for (let k = this.pathIdx + 1; k < this.path.length; k++) {
        rest += Math.hypot(this.path[k].x - this.path[k - 1].x, this.path[k].z - this.path[k - 1].z);
      }
      return rest;
    }
    out.x = 0;
    out.z = 0;
    return 0;
  }

  private checkStuck(ctx: BotContext, moving: boolean): void {
    const now = ctx.sim.time;
    const m = this.actor.move.pos;
    if (!moving) {
      this.progressAt = now;
      this.progressPos.x = m.x;
      this.progressPos.z = m.z;
      return;
    }
    if (now - this.progressAt < 1) return;
    const moved = Math.hypot(m.x - this.progressPos.x, m.z - this.progressPos.z);
    this.progressAt = now;
    this.progressPos.x = m.x;
    this.progressPos.z = m.z;
    if (moved > 0.2) {
      this.stuckCount = 0;
      return;
    }
    this.stuckCount++;
    // Sidestep for a moment (slides off door jambs and corners), hop, and replan.
    this.unstickUntil = now + 0.45;
    this.unstickDir = this.r() < 0.5 ? -1 : 1;
    if (this.stuckCount >= 2) this.cmd.pressed |= Buttons.JUMP;
    this.repathAt = now + 0.5;
    if (this.stuckCount >= 3) {
      // Snap to the nearest walkable cell if the player can't see it happen.
      const cell = ctx.sim.nav.nearestWalkable(m.x, m.y, m.z, 6);
      if (cell && !this.visible) {
        m.x = cellCenter(cell[0]);
        m.z = cellCenter(cell[1]);
        m.y = cell[2] + 0.02;
        this.actor.prevPos.x = m.x;
        this.actor.prevPos.y = m.y;
        this.actor.prevPos.z = m.z;
      }
      this.stuckCount = 0;
      stuckSnaps++;
    }
  }

  // -------------------------------------------------------------- aiming

  private aimAt(ctx: BotContext, p: Actor, dt: number): { onTarget: boolean; dist: number } {
    const sim = ctx.sim;
    const a = this.actor;
    const ticks = Math.round(this.skill.trackingDelay / sim.dt);
    const history = ctx.histories.get(p.id);
    let h = { eye: eyeHeight(p.move), scale: bodyScale(p.move) };
    if (history) h = history.at(sim.tick, ticks, tgt);
    else {
      tgt.x = p.move.pos.x;
      tgt.y = p.move.pos.y;
      tgt.z = p.move.pos.z;
    }
    const ex = a.move.pos.x;
    const ey = a.move.pos.y + eyeHeight(a.move);
    const ez = a.move.pos.z;
    const ty = tgt.y + (this.headAim ? h.eye + 0.02 : 1.2 * h.scale);
    const dx = tgt.x - ex;
    const dy = ty - ey;
    const dz = tgt.z - ez;
    const hd = Math.hypot(dx, dz);
    let yaw = Math.atan2(-dx, -dz);
    let pitch = Math.atan2(dy, hd);
    // Pull against recoil (bullets go to view + recoil).
    const def = activeItem(a.inv).def;
    patternAt(getPattern(def.pattern), a.wpn.recoilIndex, recoil);
    yaw -= recoil.yaw * DEG * this.skill.recoilComp;
    pitch -= recoil.pitch * DEG * this.skill.recoilComp;
    const trueYaw = yaw;
    const truePitch = pitch;
    // Aim error decays as the bot focuses.
    const err = this.skill.aimError * DEG * Math.exp(-(sim.time - this.acquiredAt) / this.skill.focusTime);
    yaw += this.errYaw * err;
    pitch += this.errPitch * err;
    this.turnTowards(yaw, pitch, dt, true);
    const dist = Math.hypot(hd, dy);
    const cone = Math.atan2(0.5, dist) + 1.2 * DEG;
    const offYaw = Math.abs(wrapAngle(trueYaw - this.aimYaw));
    const offPitch = Math.abs(truePitch - this.aimPitch);
    return { onTarget: offYaw < cone && offPitch < cone, dist };
  }

  private turnTowards(yaw: number, pitch: number, dt: number, combat: boolean): void {
    const rate = this.skill.turnRate * DEG * (combat ? 1 : 0.5);
    const k = 1 - Math.exp(-dt * (combat ? 14 : 6));
    const dy = wrapAngle(yaw - this.aimYaw);
    const dp = pitch - this.aimPitch;
    this.aimYaw = wrapAngle(this.aimYaw + clamp(dy * k, -rate * dt, rate * dt));
    this.aimPitch = clamp(this.aimPitch + clamp(dp * k, -rate * dt, rate * dt), -1.4, 1.4);
  }

  /** Line of sight right now from eye to the target's chest (re-checked before every shot). */
  private clearShot(ctx: BotContext, p: Actor): boolean {
    const a = this.actor;
    va.x = a.move.pos.x;
    va.y = a.move.pos.y + eyeHeight(a.move);
    va.z = a.move.pos.z;
    vb.x = p.move.pos.x;
    vb.y = p.move.pos.y + 1.2 * bodyScale(p.move);
    vb.z = p.move.pos.z;
    const smoke = ctx.sim.grenades;
    ctx.sim.world.traceRay(tr, va, vb, MASK_SHOT);
    if (tr.fraction >= 0.999 && !smoke.blocksSight(va, vb)) return true;
    vb.y = p.move.pos.y + eyeHeight(p.move) + 0.05;
    ctx.sim.world.traceRay(tr, va, vb, MASK_SHOT);
    return tr.fraction >= 0.999 && !smoke.blocksSight(va, vb);
  }

  // -------------------------------------------------------------- tick

  update(ctx: BotContext): void {
    const a = this.actor;
    if (!a.alive) {
      a.engaging = a.flashlight = false;
      return;
    }
    const sim = ctx.sim;
    const now = sim.time;
    const dt = sim.dt;
    const cmd = this.cmd;
    const keepPressed = cmd.pressed & (Buttons.RELOAD | Buttons.JUMP);
    cmd.forward = 0;
    cmd.side = 0;
    cmd.buttons = 0;
    cmd.pressed = keepPressed;
    cmd.weaponSelect = -1;

    if ((sim.tick & 3) === this.thinkPhase) this.think(ctx, dt * 4);

    const g = sim.grenades;
    if (g.fireVersion !== this.fireSeen) {
      // A fire started or went out: routes may be different now.
      this.fireSeen = g.fireVersion;
      if (this.path.length) this.repathAt = now;
      if (this.cover && g.inFire(this.cover.x, this.cover.y, this.cover.z, 0.5)) this.cover = null;
    }
    const blind = flashAmount(a, now) > BLIND;
    if (this.throwPlan && !(blind && this.throwPlan.pinAt < 0)) {
      if (this.executeThrow(ctx, now, dt)) {
        this.finishTick(ctx);
        return;
      }
    } else if (this.throwPlan) {
      this.cancelThrow();
    }

    // Acquisition: first sighting starts the reaction timer and picks the aim point/error.
    const target = this.target;
    const engaged =
      !!target && (this.state === 'engage' || this.state === 'overwatch' || this.state === 'cover') && this.visible && this.awareness >= 1;
    if (engaged && !this.wasVisible) {
      this.reactionEnd = now + this.skill.reaction * (0.8 + this.r() * 0.4);
      this.acquiredAt = now;
      this.rollAim();
    }
    this.wasVisible = engaged;

    const move = moveDir;
    move.x = 0;
    move.z = 0;
    let walk = false;
    let crouch = false;
    let wantFire = false;
    let dist = 0;

    if (engaged) {
      const aim = this.aimAt(ctx, target, dt);
      dist = aim.dist;
      wantFire = aim.onTarget && now >= this.reactionEnd;
    } else if (now < this.lookAwayUntil) {
      // Own flash in the air: look away until it pops.
      this.turnTowards(this.lookAwayYaw, -0.3, dt, true);
    } else {
      // Look where we're going, or towards the last known position.
      let lookYaw = this.lookYaw;
      if (this.lastKnown && this.state !== 'patrol' && this.state !== 'idle') {
        lookYaw = Math.atan2(-(this.lastKnown.x - a.move.pos.x), -(this.lastKnown.z - a.move.pos.z));
      }
      this.turnTowards(lookYaw, 0, dt, false);
    }

    switch (this.state) {
      case 'idle':
        if (Math.hypot(this.post.x - a.move.pos.x, this.post.z - a.move.pos.z) > 1.5) {
          this.goTo(ctx, this.post);
          this.followPath(move);
          walk = true;
        } else if (this.r() < 0.004) {
          this.lookYaw += (this.r() - 0.5) * 2.5;
        }
        break;
      case 'patrol': {
        if (!this.patrol.length) break;
        const p = this.patrol[this.patrolIdx % this.patrol.length];
        if (Math.hypot(p.x - a.move.pos.x, p.z - a.move.pos.z) < 1.2) this.patrolIdx++;
        this.goTo(ctx, p);
        this.followPath(move);
        if (move.x || move.z) this.lookYaw = Math.atan2(-move.x, -move.z);
        walk = true;
        break;
      }
      case 'alert':
        if (this.lastKnown) {
          const d = Math.hypot(this.lastKnown.x - a.move.pos.x, this.lastKnown.z - a.move.pos.z);
          if (d > 2) {
            this.goTo(ctx, this.lastKnown);
            this.followPath(move);
            walk = this.awareness < 0.6;
          } else if (this.r() < 0.02) {
            this.lookYaw = this.aimYaw + (this.r() - 0.5) * 3;
          }
        }
        break;
      case 'engage':
        this.engageMove(ctx, move, wantFire, dist);
        break;
      case 'cover': {
        if (!this.cover && this.lastKnown && ctx.pathBudget > 0) {
          const threat = vec3(this.lastKnown.x, this.lastKnown.y + 1.6, this.lastKnown.z);
          const g = sim.grenades;
          const y = a.move.pos.y;
          this.cover = findCover(sim.nav, sim.world, a.move.pos.x, a.move.pos.y, a.move.pos.z, threat, 15, undefined, {
            reject: g.fires.length ? (x, z) => g.inFire(x, y, z, 0.5) : undefined,
            blocksSight: g.smokes.length ? (p, q) => g.blocksSight(p, q) : undefined,
          });
          ctx.pathBudget--;
          if (!this.cover) {
            this.coverUntil = now + 1;
            this.setState('engage', now);
            break;
          }
          this.coverUntil = 0;
        }
        if (this.cover) {
          const d = Math.hypot(this.cover.x - a.move.pos.x, this.cover.z - a.move.pos.z);
          if (d > 0.6) {
            this.goTo(ctx, this.cover);
            this.followPath(move);
          } else {
            if (this.coverUntil === 0) this.coverUntil = now + 1.5 + this.r() * 1.5;
            crouch = this.cover.crouch;
            const item = activeItem(a.inv);
            if (item.clip < item.def.magSize) cmd.pressed |= Buttons.RELOAD;
            if (engaged && now > this.coverUntil - 0.6) crouch = false; // peek
          }
        }
        break;
      }
      case 'flank': {
        if (this.lastKnown) {
          if (!this.goal) {
            const point = this.pickFlankPoint(ctx);
            if (point) {
              const fy = this.target?.yaw ?? 0;
              const fx = -Math.sin(fy);
              const fz = -Math.cos(fy);
              const lk = this.lastKnown;
              const extra = (gx: number, gz: number) => {
                const x = (gx + 0.5) * 0.5 - lk.x;
                const z = (gz + 0.5) * 0.5 - lk.z;
                const d = Math.hypot(x, z);
                if (d > 30 || d < 0.1) return 0;
                return (x * fx + z * fz) / d > Math.cos(30 * DEG) ? 6 : 0;
              };
              this.goTo(ctx, point, extra);
            } else this.setState('alert', now);
          }
          const rest = this.followPath(move);
          if (rest < 0.5 && this.goal) this.setState('alert', now);
        }
        break;
      }
      case 'retreat': {
        const centroid = this.squadCentroid();
        if (centroid && Math.hypot(centroid.x - a.move.pos.x, centroid.z - a.move.pos.z) > 3) {
          this.goTo(ctx, centroid);
          this.followPath(move);
        } else this.setState('cover', now);
        break;
      }
      case 'overwatch':
        crouch = !engaged && this.r() < 0.5 ? a.move.ducked : false;
        break;
    }

    // Hazards override the plan: back off blind, get out of fire, dodge live grenades.
    if (blind) {
      move.x = Math.sin(this.aimYaw);
      move.z = Math.cos(this.aimYaw);
      walk = false;
      crouch = false;
      wantFire = false;
    }
    const m = a.move.pos;
    const fire = g.fires.length ? g.fires.find((f) => g.inFire(m.x, m.y, m.z, 0.4) && Math.hypot(m.x - f.pos.x, m.z - f.pos.z) < f.radius + 0.4) : undefined;
    const danger = fire ?? (this.skill.level >= 5 ? g.dangerNear(m.x, m.z, 4) : null);
    if (danger && (fire || (danger as { owner?: Actor }).owner?.team !== a.team)) {
      const dx = m.x - danger.pos.x;
      const dz = m.z - danger.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      move.x = dx / d;
      move.z = dz / d;
      walk = false;
      crouch = false;
    }

    // Unstick: slide sideways relative to the intended direction.
    if (now < this.unstickUntil && (move.x || move.z)) {
      const px = -move.z * this.unstickDir;
      const pz = move.x * this.unstickDir;
      move.x = px * 0.9 - move.x * 0.3;
      move.z = pz * 0.9 - move.z * 0.3;
    }

    // Firing with burst control by range.
    if (wantFire) {
      const def = activeItem(a.inv).def;
      if (a.wpn.shotCounter !== this.lastShotCount) {
        this.lastShotCount = a.wpn.shotCounter;
        this.burstLeft--;
        if (this.burstLeft <= 0) {
          const pause = dist > 30 ? 0.38 : dist > 15 ? 0.32 : 0.25;
          this.nextBurstAt = now + pause + this.r() * 0.15;
          this.rollAim(0.5);
        }
      }
      if (this.burstLeft <= 0 && now >= this.nextBurstAt) {
        this.burstLeft = def.category === 'sniper' ? 1 : dist > 30 ? 1 : dist > 15 ? 3 + Math.floor(this.r() * 3) : 8 + Math.floor(this.r() * 6);
      }
      const speed = Math.hypot(a.move.vel.x, a.move.vel.z);
      const slowEnough = speed < def.maxSpeed * 0.34 || !a.move.onGround;
      if (this.burstLeft > 0 && slowEnough && target && this.clearShot(ctx, target)) {
        // Semi-autos need the trigger released between shots.
        if (def.automatic || !a.wpn.triggerHeld) {
          cmd.buttons |= Buttons.ATTACK;
          cmd.pressed |= Buttons.ATTACK;
        }
      }
      if (!slowEnough) {
        // Counter-strafe: push against the current velocity to stop fast.
        move.x = -a.move.vel.x;
        move.z = -a.move.vel.z;
      }
    } else {
      this.lastShotCount = a.wpn.shotCounter;
    }

    // Convert the world move direction into forward/side relative to the aim yaw.
    const ml = Math.hypot(move.x, move.z);
    if (ml > 1e-4) {
      const fx = -Math.sin(this.aimYaw);
      const fz = -Math.cos(this.aimYaw);
      const rx = Math.cos(this.aimYaw);
      const rz = -Math.sin(this.aimYaw);
      const mx = move.x / ml;
      const mz = move.z / ml;
      cmd.forward = mx * fx + mz * fz;
      cmd.side = mx * rx + mz * rz;
    }
    if (walk) cmd.buttons |= Buttons.WALK;
    if (crouch) cmd.buttons |= Buttons.DUCK;

    this.checkStuck(ctx, ml > 1e-4 && !wantFire);
    this.finishTick(ctx);
  }

  /** Flags other code (radar, buying, presentation) reads off the actor. */
  private publishState(sim: Simulation): void {
    const a = this.actor;
    a.engaging = this.state === 'engage';
    // After dark, bots moving about or hunting carry a lit flashlight.
    a.flashlight = sim.env.darkness >= 0.25 && this.state !== 'idle' && this.state !== 'overwatch';
  }

  /** Send this tick's command through the same movement and weapon code as the player. */
  private finishTick(ctx: BotContext): void {
    const a = this.actor;
    const sim = ctx.sim;
    const cmd = this.cmd;
    cmd.yaw = cmd.attackYaw = this.aimYaw;
    cmd.pitch = cmd.attackPitch = this.aimPitch;
    a.yaw = this.aimYaw;
    a.pitch = this.aimPitch;
    playerMove(a.move, cmd, sim.world, sim.dt);
    updateWeapon(a, cmd, sim);
    sim.footsteps(a);
    cmd.pressed = 0;
    this.publishState(sim);
  }

  // -------------------------------------------------------------- grenades

  /** Remember how long the target has been holding the same spot (molotov bait). */
  private trackCamping(now: number): void {
    const lk = this.squad.lastKnown;
    if (!lk) return;
    if (!this.campAnchor || Math.hypot(lk.x - this.campAnchor.x, lk.z - this.campAnchor.z) > 1.5) {
      this.campAnchor = vec3(lk.x, lk.y, lk.z);
      this.campSince = now;
    }
  }

  /** The target just broke line of sight nearby and the squad's grenade is ready. */
  private wantsToThrow(now: number): boolean {
    const a = this.actor;
    if (this.visible || !this.lastKnown || this.awareness < 0.6 || grenadeTotal(a.inv) <= 0) return false;
    if (this.state !== 'engage' && this.state !== 'alert' && this.state !== 'cover') return false;
    if (now < (this.squad.nextNadeAt ?? 0) || flashAmount(a, now) > 0) return false;
    const since = now - Math.max(this.lastSeen, this.squad.lastSeen);
    if (since < 1.5 || since > 10) return false;
    const d = Math.hypot(this.lastKnown.x - a.move.pos.x, this.lastKnown.z - a.move.pos.z);
    return d > 6 && d < 24;
  }

  /** Pick a grenade and find an arc that lands it on the target's last known spot. */
  private planThrow(ctx: BotContext, now: number): void {
    const sim = ctx.sim;
    const a = this.actor;
    const inv = a.inv;
    const lk = this.lastKnown!;
    this.nextThrowCheck = now + 2;
    if (ctx.pathBudget <= 0) return;
    ctx.pathBudget--;
    const has = (k: GrenadeId) => inv.nades[k] > 0;
    const d = Math.hypot(lk.x - a.move.pos.x, lk.z - a.move.pos.z);
    const camping = now - this.campSince > 4 && now - this.squad.lastKnownTime < 3;
    let kind: GrenadeId | null = null;
    if (has('molotov') && camping) kind = 'molotov';
    else if (has('flashbang') && (this.state === 'alert' || this.role === 'flanker') && d < 18) kind = 'flashbang';
    else if (has('hegrenade')) kind = 'hegrenade';
    else if (has('flashbang')) kind = 'flashbang';
    else if (has('molotov')) kind = 'molotov';
    if (!kind) return;

    const eye = eyeTmp;
    eye.x = a.move.pos.x;
    eye.y = a.move.pos.y + eyeHeight(a.move);
    eye.z = a.move.pos.z;
    const yaw = Math.atan2(-(lk.x - eye.x), -(lk.z - eye.z));
    // Flashes should pop above the target, the rest land on it.
    const ty = lk.y + (kind === 'flashbang' ? 1.8 : 0);
    let best = Infinity;
    let bestPitch = 0;
    let bestStrength = 1;
    for (const strength of [1, 0.4]) {
      for (let deg = -5; deg <= 50; deg += 5) {
        const pitch = deg * DEG;
        throwOrigin(sim.world, eye, yaw, pitch, startTmp);
        throwVelocity(yaw, pitch, strength, null, velTmp);
        const hit = simulateThrow(sim.world, kind, startTmp, velTmp, sim.dt, 3);
        const miss = Math.hypot(hit.pos.x - lk.x, hit.pos.z - lk.z) + Math.abs(hit.pos.y - ty) * 0.5;
        // Never at our own feet.
        if (Math.hypot(hit.pos.x - eye.x, hit.pos.z - eye.z) < 5) continue;
        if (miss < best) {
          best = miss;
          bestPitch = pitch;
          bestStrength = strength;
        }
      }
    }
    if (best > (kind === 'molotov' ? 2.5 : 4)) return;
    this.throwPlan = { kind, yaw, pitch: bestPitch, strength: bestStrength, start: now, pinAt: -1, thrownAt: -1, count: inv.nades[kind] };
    this.squad.nextNadeAt = now + 8 + this.r() * 4;
  }

  private cancelThrow(): void {
    if (this.actor.inv.active === 'grenade') this.cmd.weaponSelect = SELECT_LAST;
    this.throwPlan = null;
  }

  /**
   * Carry out the throw plan through ordinary commands. Returns false once the plan is over
   * (the normal brain takes this tick).
   */
  private executeThrow(ctx: BotContext, now: number, dt: number): boolean {
    const plan = this.throwPlan!;
    const a = this.actor;
    const inv = a.inv;
    const w = a.wpn;
    const cmd = this.cmd;
    if (plan.thrownAt < 0 && inv.nades[plan.kind] < plan.count) {
      plan.thrownAt = now;
      if (plan.kind === 'flashbang') {
        this.lookAwayUntil = now + 1.9;
        this.lookAwayYaw = plan.yaw + Math.PI;
      }
    }
    if (plan.thrownAt >= 0) {
      // Thrown: put the gun back up.
      if (now - plan.thrownAt > 0.3) {
        this.cancelThrow();
        return false;
      }
      return true;
    }
    const spotted = this.visible && this.awareness >= 1;
    if ((spotted && plan.pinAt < 0) || now - plan.start > 3 || inv.nades[plan.kind] <= 0) {
      this.cancelThrow();
      return false;
    }
    if (inv.nadeSel !== plan.kind) {
      inv.nadeSel = plan.kind;
      syncGrenade(inv);
    }
    if (inv.active !== 'grenade') {
      cmd.weaponSelect = 4;
      this.turnTowards(plan.yaw, plan.pitch, dt, true);
      return true;
    }
    this.turnTowards(plan.yaw, plan.pitch, dt, true);
    const aimed = Math.abs(wrapAngle(plan.yaw - this.aimYaw)) < 0.6 * DEG && Math.abs(plan.pitch - this.aimPitch) < 0.6 * DEG;
    const button = plan.strength >= 1 ? Buttons.ATTACK : Buttons.ATTACK2;
    if (w.pinPulled && plan.pinAt < 0) plan.pinAt = now;
    const holdLongEnough = plan.pinAt >= 0 && now - plan.pinAt >= 0.25;
    if (!(holdLongEnough && aimed)) {
      // Keep holding: pin out, winding up.
      cmd.buttons |= button;
      if (!w.pinPulled) cmd.pressed |= button;
    }
    return true;
  }

  private engageMove(ctx: BotContext, move: { x: number; z: number }, wantFire: boolean, dist: number): void {
    const a = this.actor;
    const now = ctx.sim.time;
    const def = activeItem(a.inv).def;
    // Too far for the weapon: close in along a path.
    const effective = def.category === 'pistol' ? 25 : def.category === 'smg' ? 30 : 70;
    if (dist > effective && this.lastKnown) {
      this.goTo(ctx, this.lastKnown);
      this.followPath(move);
      return;
    }
    // Strafe peeks between bursts at close/medium range (skilled bots).
    if (this.skill.strafePeek && dist < 22 && !wantFire) {
      if (now > this.strafeUntil) {
        this.strafeDir = -this.strafeDir;
        this.strafeUntil = now + 0.35 + this.r() * 0.4;
      }
      move.x = Math.cos(this.aimYaw) * this.strafeDir;
      move.z = -Math.sin(this.aimYaw) * this.strafeDir;
    }
  }

  private rollAim(scale = 1): void {
    this.headAim = this.r() < this.skill.headChance;
    const ang = this.r() * Math.PI * 2;
    const mag = (0.5 + this.r() * 0.5) * scale;
    this.errYaw = Math.cos(ang) * mag;
    this.errPitch = Math.sin(ang) * mag * 0.6;
  }

  private pickFlankPoint(ctx: BotContext): Vec3 | null {
    const lk = this.lastKnown;
    if (!lk) return null;
    const c = this.squadCentroid() ?? this.actor.move.pos;
    const axis = Math.atan2(c.z - lk.z, c.x - lk.x);
    for (let tries = 0; tries < 10; tries++) {
      const side = this.r() < 0.5 ? -1 : 1;
      const ang = axis + side * (70 + this.r() * 50) * DEG;
      const d = 12 + this.r() * 13;
      const x = lk.x + Math.cos(ang) * d;
      const z = lk.z + Math.sin(ang) * d;
      const cell = ctx.sim.nav.nearestWalkable(x, lk.y, z, 4, 2);
      if (!cell) continue;
      return vec3(cellCenter(cell[0]), cell[2], cellCenter(cell[1]));
    }
    return null;
  }

  private squadCentroid(): Vec3 | null {
    let n = 0;
    const c = vec3();
    for (const m of this.squad.members) {
      if (!m.actor.alive || m === this) continue;
      c.x += m.actor.move.pos.x;
      c.y += m.actor.move.pos.y;
      c.z += m.actor.move.pos.z;
      n++;
    }
    if (!n) return null;
    c.x /= n;
    c.y /= n;
    c.z /= n;
    return c;
  }
}

/** Debug counter: times a stuck bot had to be snapped to a walkable cell. */
export let stuckSnaps = 0;
