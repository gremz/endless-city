/**
 * Source-engine style player movement (friction, ground/air acceleration, slide/step moves,
 * crouch and crouch-jump), shared by the player and bots. All functions mutate in place
 * and allocate nothing per tick.
 */
import { HU } from '../core/config';
import { anglesToForward, vec3, yawBasis, type Vec3 } from '../core/math';
import { Buttons, type UserCmd } from '../input/UserCmd';
import { MASK_PLAYER } from '../physics/brush';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { DIST_EPSILON, makeTrace, type TraceResult } from '../physics/trace';
import { DUCK_MAXS, DUCK_MINS, MOVE, STAND_MAXS, STAND_MINS } from './movementConfig';

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  groundNormalY: number;
  /** Hull is the crouched hull. */
  ducked: boolean;
  /** 0 = standing eye height, 1 = crouched eye height. */
  duckAmount: number;
  /** Max speed of the active weapon. */
  maxSpeed: number;
  /** Remaining seconds of the post-damage slowdown. */
  tagTime: number;
  /** Set on the tick the actor lands, with the downward speed at impact. */
  landed: boolean;
  landSpeed: number;
  /** Set on the tick a jump started. */
  jumped: boolean;
  /** Count of times the actor was found inside solid and nudged out (debug). */
  stuckEvents: number;
  noclip: boolean;
}

export function makeMoveState(x = 0, y = 0, z = 0): MoveState {
  return {
    pos: vec3(x, y, z),
    vel: vec3(),
    onGround: false,
    groundNormalY: 0,
    ducked: false,
    duckAmount: 0,
    maxSpeed: MOVE.defaultMaxSpeed,
    tagTime: 0,
    landed: false,
    landSpeed: 0,
    jumped: false,
    stuckEvents: 0,
    noclip: false,
  };
}

export interface MoveOptions {
  autoBhop?: boolean;
}

export const hullMins = (s: MoveState): Vec3 => (s.ducked ? DUCK_MINS : STAND_MINS);
export const hullMaxs = (s: MoveState): Vec3 => (s.ducked ? DUCK_MAXS : STAND_MAXS);

export function eyeHeight(s: MoveState): number {
  return MOVE.standEye + (MOVE.duckEye - MOVE.standEye) * s.duckAmount;
}

// ---- scratch state (module-level, reused every call) ----
const tr = makeTrace();
const tr2 = makeTrace();
const fwd = vec3();
const right = vec3();
const wishDir = vec3();
const end = vec3();
const tmp = vec3();
const original = vec3();
const primal = vec3();
const newVel = vec3();
const planes: Vec3[] = [vec3(), vec3(), vec3(), vec3(), vec3()];
const MAX_CLIP_PLANES = 5;

function trace(world: CollisionWorld, s: MoveState, start: Vec3, stop: Vec3, out: TraceResult = tr) {
  return world.traceBox(out, start, stop, hullMins(s), hullMaxs(s), MASK_PLAYER);
}

// ---- core Source functions (exported for tests) ----

export function friction(v: Vec3, dt: number): void {
  const speed = Math.hypot(v.x, v.y, v.z);
  if (speed < 0.1 * HU) {
    v.x = v.y = v.z = 0;
    return;
  }
  const control = speed < MOVE.stopSpeed ? MOVE.stopSpeed : speed;
  const drop = control * MOVE.friction * dt;
  const k = Math.max(0, speed - drop) / speed;
  v.x *= k;
  v.y *= k;
  v.z *= k;
}

export function accelerate(v: Vec3, dir: Vec3, wishSpeed: number, accel: number, dt: number): void {
  const current = v.x * dir.x + v.y * dir.y + v.z * dir.z;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const a = Math.min(accel * dt * wishSpeed, add);
  v.x += a * dir.x;
  v.y += a * dir.y;
  v.z += a * dir.z;
}

export function airAccelerate(v: Vec3, dir: Vec3, wishSpeed: number, dt: number): void {
  const capped = Math.min(wishSpeed, MOVE.airWishCap);
  const current = v.x * dir.x + v.y * dir.y + v.z * dir.z;
  const add = capped - current;
  if (add <= 0) return;
  // The gain uses the uncapped wish speed: this is what makes air-strafing work.
  const a = Math.min(MOVE.airAccelerate * wishSpeed * dt, add);
  v.x += a * dir.x;
  v.y += a * dir.y;
  v.z += a * dir.z;
}

export function clipVelocity(inV: Vec3, n: Vec3, out: Vec3, overbounce: number): void {
  const backoff = (inV.x * n.x + inV.y * n.y + inV.z * n.z) * overbounce;
  out.x = inV.x - n.x * backoff;
  out.y = inV.y - n.y * backoff;
  out.z = inV.z - n.z * backoff;
  const adjust = out.x * n.x + out.y * n.y + out.z * n.z;
  if (adjust < 0) {
    out.x -= n.x * adjust;
    out.y -= n.y * adjust;
    out.z -= n.z * adjust;
  }
}

/** Effective top speed from weapon, walk/crouch state and damage tagging. */
export function currentMaxSpeed(s: MoveState, cmd: UserCmd): number {
  let speed = s.maxSpeed;
  if (s.ducked) speed *= MOVE.duckMul;
  else if (cmd.buttons & Buttons.WALK) speed *= MOVE.walkMul;
  if (s.tagTime > 0) {
    const t = s.tagTime / MOVE.tagRecovery;
    speed *= 1 - (1 - MOVE.tagMul) * t;
  }
  return speed;
}

/** Wish direction (into wishDir) and wish speed from the cmd. */
function computeWish(s: MoveState, cmd: UserCmd): number {
  yawBasis(cmd.yaw, fwd, right);
  const wx = fwd.x * cmd.forward + right.x * cmd.side;
  const wz = fwd.z * cmd.forward + right.z * cmd.side;
  const len = Math.hypot(wx, wz);
  if (len < 1e-6) {
    wishDir.x = wishDir.y = wishDir.z = 0;
    return 0;
  }
  wishDir.x = wx / len;
  wishDir.y = 0;
  wishDir.z = wz / len;
  return Math.min(1, len) * currentMaxSpeed(s, cmd);
}

/** Quake/Source TryPlayerMove: move along velocity, sliding along up to 4 planes. */
export function slideMove(s: MoveState, world: CollisionWorld, dt: number): void {
  const pos = s.pos;
  const vel = s.vel;
  original.x = primal.x = vel.x;
  original.y = primal.y = vel.y;
  original.z = primal.z = vel.z;
  let numPlanes = 0;
  let timeLeft = dt;
  let allFraction = 0;

  for (let bump = 0; bump < 4; bump++) {
    if (vel.x === 0 && vel.y === 0 && vel.z === 0) break;
    end.x = pos.x + vel.x * timeLeft;
    end.y = pos.y + vel.y * timeLeft;
    end.z = pos.z + vel.z * timeLeft;
    trace(world, s, pos, end);
    allFraction += tr.fraction;
    if (tr.allSolid) {
      vel.x = vel.y = vel.z = 0;
      return;
    }
    if (tr.fraction > 0) {
      pos.x = tr.endX;
      pos.y = tr.endY;
      pos.z = tr.endZ;
      original.x = vel.x;
      original.y = vel.y;
      original.z = vel.z;
      numPlanes = 0;
    }
    if (tr.fraction === 1) break;
    timeLeft -= timeLeft * tr.fraction;
    if (numPlanes >= MAX_CLIP_PLANES) {
      vel.x = vel.y = vel.z = 0;
      break;
    }
    const pl = planes[numPlanes++];
    pl.x = tr.normal.x;
    pl.y = tr.normal.y;
    pl.z = tr.normal.z;

    if (numPlanes === 1 && !s.onGround) {
      clipVelocity(original, pl, newVel, 1);
      vel.x = original.x = newVel.x;
      vel.y = original.y = newVel.y;
      vel.z = original.z = newVel.z;
    } else {
      let i = 0;
      for (; i < numPlanes; i++) {
        clipVelocity(original, planes[i], vel, 1);
        let j = 0;
        for (; j < numPlanes; j++) {
          if (j !== i) {
            const p = planes[j];
            if (vel.x * p.x + vel.y * p.y + vel.z * p.z < 0) break;
          }
        }
        if (j === numPlanes) break;
      }
      if (i === numPlanes) {
        // Go along the crease between two planes.
        if (numPlanes !== 2) {
          vel.x = vel.y = vel.z = 0;
          break;
        }
        const a = planes[0];
        const b = planes[1];
        let dx = a.y * b.z - a.z * b.y;
        let dy = a.z * b.x - a.x * b.z;
        let dz = a.x * b.y - a.y * b.x;
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l;
        dy /= l;
        dz /= l;
        const d = dx * vel.x + dy * vel.y + dz * vel.z;
        vel.x = dx * d;
        vel.y = dy * d;
        vel.z = dz * d;
      }
      // Moving against the original velocity: stop dead to avoid oscillation in corners.
      if (vel.x * primal.x + vel.y * primal.y + vel.z * primal.z <= 0) {
        vel.x = vel.y = vel.z = 0;
        break;
      }
    }
  }
  if (allFraction === 0) vel.x = vel.y = vel.z = 0;
}

/** Try a plain slide and a slide stepped up by stepSize; keep whichever gets further. */
export function stepSlideMove(s: MoveState, world: CollisionWorld, dt: number): void {
  const pos = s.pos;
  const vel = s.vel;
  const startX = pos.x;
  const startY = pos.y;
  const startZ = pos.z;
  const startVX = vel.x;
  const startVY = vel.y;
  const startVZ = vel.z;

  // A: slide on the ground.
  slideMove(s, world, dt);
  const downX = pos.x;
  const downY = pos.y;
  const downZ = pos.z;
  const downVX = vel.x;
  const downVY = vel.y;
  const downVZ = vel.z;

  // B: step up, slide, step down.
  pos.x = startX;
  pos.y = startY;
  pos.z = startZ;
  vel.x = startVX;
  vel.y = startVY;
  vel.z = startVZ;
  tmp.x = pos.x;
  tmp.y = pos.y + MOVE.stepSize + DIST_EPSILON;
  tmp.z = pos.z;
  trace(world, s, pos, tmp, tr2);
  if (!tr2.startSolid && !tr2.allSolid) pos.y = tr2.endY;
  slideMove(s, world, dt);
  tmp.x = pos.x;
  tmp.y = pos.y - MOVE.stepSize - DIST_EPSILON;
  tmp.z = pos.z;
  trace(world, s, pos, tmp, tr2);
  if (tr2.normal.y < MOVE.minWalkNormal) {
    // Stepped onto nothing/steep: use the plain move.
    pos.x = downX;
    pos.y = downY;
    pos.z = downZ;
    vel.x = downVX;
    vel.y = downVY;
    vel.z = downVZ;
    return;
  }
  if (!tr2.startSolid && !tr2.allSolid) {
    pos.x = tr2.endX;
    pos.y = tr2.endY;
    pos.z = tr2.endZ;
  }
  const downDist = (downX - startX) ** 2 + (downZ - startZ) ** 2;
  const upDist = (pos.x - startX) ** 2 + (pos.z - startZ) ** 2;
  if (downDist > upDist) {
    pos.x = downX;
    pos.y = downY;
    pos.z = downZ;
    vel.x = downVX;
    vel.y = downVY;
    vel.z = downVZ;
  } else {
    vel.y = downVY;
  }
}

/** Keep the player glued to stairs/ramps when walking down them. */
function stayOnGround(s: MoveState, world: CollisionWorld): void {
  const pos = s.pos;
  tmp.x = pos.x;
  tmp.y = pos.y + 2 * HU;
  tmp.z = pos.z;
  trace(world, s, pos, tmp, tr2);
  const upY = tr2.endY;
  tmp.y = upY;
  end.x = pos.x;
  end.y = pos.y - MOVE.stepSize;
  end.z = pos.z;
  trace(world, s, tmp, end, tr2);
  if (
    tr2.fraction > 0 &&
    tr2.fraction < 1 &&
    !tr2.startSolid &&
    tr2.normal.y >= MOVE.minWalkNormal &&
    Math.abs(pos.y - tr2.endY) > 0.0001
  ) {
    pos.y = tr2.endY;
  }
}

function walkMove(s: MoveState, world: CollisionWorld, cmd: UserCmd, dt: number): void {
  const wishSpeed = computeWish(s, cmd);
  const vel = s.vel;
  vel.y = 0;
  if (wishSpeed > 0) accelerate(vel, wishDir, wishSpeed, MOVE.accelerate, dt);
  vel.y = 0;
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 1 * HU) {
    vel.x = vel.z = 0;
    return;
  }
  end.x = s.pos.x + vel.x * dt;
  end.y = s.pos.y;
  end.z = s.pos.z + vel.z * dt;
  trace(world, s, s.pos, end);
  if (tr.fraction === 1 && !tr.startSolid) {
    s.pos.x = tr.endX;
    s.pos.y = tr.endY;
    s.pos.z = tr.endZ;
    stayOnGround(s, world);
    return;
  }
  stepSlideMove(s, world, dt);
  stayOnGround(s, world);
}

function airMove(s: MoveState, world: CollisionWorld, cmd: UserCmd, dt: number): void {
  const wishSpeed = computeWish(s, cmd);
  s.vel.y -= MOVE.gravity * dt * 0.5;
  if (wishSpeed > 0) airAccelerate(s.vel, wishDir, wishSpeed, dt);
  slideMove(s, world, dt);
  s.vel.y -= MOVE.gravity * dt * 0.5;
}

function categorizePosition(s: MoveState, world: CollisionWorld): void {
  const wasOnGround = s.onGround;
  if (s.vel.y > MOVE.nonJumpVelocity) {
    s.onGround = false;
    return;
  }
  end.x = s.pos.x;
  end.y = s.pos.y - 2 * HU;
  end.z = s.pos.z;
  trace(world, s, s.pos, end);
  if (tr.fraction < 1 && !tr.startSolid && tr.normal.y >= MOVE.minWalkNormal) {
    if (!wasOnGround) {
      s.landed = true;
      s.landSpeed = -s.vel.y;
    }
    s.onGround = true;
    s.groundNormalY = tr.normal.y;
    s.pos.y = tr.endY;
    if (s.vel.y < 0) s.vel.y = 0;
  } else {
    s.onGround = false;
  }
}

function hullFree(s: MoveState, world: CollisionWorld, x: number, y: number, z: number, ducked: boolean): boolean {
  tmp.x = x;
  tmp.y = y;
  tmp.z = z;
  return !world.testBox(tr2, tmp, ducked ? DUCK_MINS : STAND_MINS, ducked ? DUCK_MAXS : STAND_MAXS, MASK_PLAYER);
}

function updateDuck(s: MoveState, world: CollisionWorld, cmd: UserCmd, dt: number): void {
  const wantDuck = (cmd.buttons & Buttons.DUCK) !== 0;
  const rate = dt / MOVE.duckTime;
  if (wantDuck) {
    if (!s.ducked) {
      if (!s.onGround) {
        // Crouching in the air tucks the feet up. duckAmount is chosen so the eye stays put
        // (lift 9 HU = half of the 18 HU eye difference), then it keeps ramping to 1.
        const lift = MOVE.airDuckLift;
        if (hullFree(s, world, s.pos.x, s.pos.y + lift, s.pos.z, true)) {
          s.pos.y += lift;
          s.duckAmount = Math.max(s.duckAmount, lift / (MOVE.standEye - MOVE.duckEye));
        }
        s.ducked = true;
      } else {
        s.duckAmount = Math.min(1, s.duckAmount + rate);
        if (s.duckAmount >= 1) s.ducked = true;
      }
    } else {
      s.duckAmount = Math.min(1, s.duckAmount + rate);
    }
  } else {
    if (s.ducked) {
      if (s.onGround) {
        if (hullFree(s, world, s.pos.x, s.pos.y, s.pos.z, false)) s.ducked = false;
      } else {
        const drop = MOVE.airDuckLift;
        if (hullFree(s, world, s.pos.x, s.pos.y - drop, s.pos.z, false)) {
          s.pos.y -= drop;
          s.ducked = false;
          s.duckAmount = Math.min(s.duckAmount, 1 - drop / (MOVE.standEye - MOVE.duckEye));
        } else if (hullFree(s, world, s.pos.x, s.pos.y, s.pos.z, false)) {
          s.ducked = false;
        }
      }
    }
    if (!s.ducked) s.duckAmount = Math.max(0, s.duckAmount - rate);
  }
}

const STUCK_OFFSETS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (const d of [1, 2, 4, 8, 16]) {
    const u = d * HU;
    out.push([0, u, 0], [u, 0, 0], [-u, 0, 0], [0, 0, u], [0, 0, -u], [u, u, 0], [-u, u, 0], [0, u, u], [0, u, -u]);
  }
  for (const d of [24, 36, 48, 72]) out.push([0, d * HU, 0]);
  return out;
})();

/** If the hull is inside solid, nudge it out. Returns true if it had to move. */
export function unstick(s: MoveState, world: CollisionWorld): boolean {
  const p = s.pos;
  if (hullFree(s, world, p.x, p.y, p.z, s.ducked)) return false;
  for (const [ox, oy, oz] of STUCK_OFFSETS) {
    if (hullFree(s, world, p.x + ox, p.y + oy, p.z + oz, s.ducked)) {
      p.x += ox;
      p.y += oy;
      p.z += oz;
      s.stuckEvents++;
      return true;
    }
  }
  s.stuckEvents++;
  return true;
}

function noclipMove(s: MoveState, cmd: UserCmd, dt: number): void {
  anglesToForward(fwd, cmd.yaw, cmd.pitch);
  yawBasis(cmd.yaw, tmp, right);
  const speed = (cmd.buttons & Buttons.WALK ? 200 : 900) * HU;
  let up = 0;
  if (cmd.buttons & Buttons.JUMP) up += 1;
  if (cmd.buttons & Buttons.DUCK) up -= 1;
  s.vel.x = (fwd.x * cmd.forward + right.x * cmd.side) * speed;
  s.vel.y = (fwd.y * cmd.forward + up) * speed;
  s.vel.z = (fwd.z * cmd.forward + right.z * cmd.side) * speed;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;
  s.onGround = false;
}

/** Run one movement tick. */
export function playerMove(
  s: MoveState,
  cmd: UserCmd,
  world: CollisionWorld,
  dt: number,
  opts: MoveOptions = {},
): void {
  s.landed = false;
  s.jumped = false;
  if (s.noclip) {
    noclipMove(s, cmd, dt);
    return;
  }
  if (s.tagTime > 0) s.tagTime = Math.max(0, s.tagTime - dt);

  unstick(s, world);
  updateDuck(s, world, cmd, dt);

  const wantJump =
    (cmd.pressed & Buttons.JUMP) !== 0 || (opts.autoBhop === true && (cmd.buttons & Buttons.JUMP) !== 0);
  if (wantJump && s.onGround) {
    s.vel.y = MOVE.jumpSpeed;
    s.onGround = false;
    s.jumped = true;
  }

  if (s.onGround) {
    s.vel.y = 0;
    friction(s.vel, dt);
  }

  if (s.onGround) walkMove(s, world, cmd, dt);
  else airMove(s, world, cmd, dt);

  const mv = MOVE.maxVelocity;
  if (s.vel.x > mv) s.vel.x = mv;
  else if (s.vel.x < -mv) s.vel.x = -mv;
  if (s.vel.y > mv) s.vel.y = mv;
  else if (s.vel.y < -mv) s.vel.y = -mv;
  if (s.vel.z > mv) s.vel.z = mv;
  else if (s.vel.z < -mv) s.vel.z = -mv;

  categorizePosition(s, world);
}
