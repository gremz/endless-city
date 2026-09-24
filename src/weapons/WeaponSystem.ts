import { HitGroup, rayActor, bodyScale, type HitboxHit } from '../ai/hitboxes';
import type { EventQueue } from '../core/events';
import { anglesToForward, DEG, vec3, type Vec3 } from '../core/math';
import { hash4, Salt, sfc32 } from '../core/rng';
import { Buttons, SELECT_LAST, SELECT_NEXT, SELECT_PREV, type UserCmd } from '../input/UserCmd';
import { Contents, MASK_SHOT } from '../physics/brush';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { makeTrace, rayExitFraction } from '../physics/trace';
import { eyeHeight } from '../player/pmove';
import type { Actor } from '../sim/Actor';
import { rangeDamage } from '../sim/damage';
import { decayFireInacc, inaccuracy, sampleSpread } from './inaccuracy';
import { activeItem, cycleSlot, nextGrenadeType, slotFromNumber, syncGrenade, type WeaponItem } from './Inventory';
import { getPattern, patternAt } from './sprayPatterns';
import type { GrenadeId, WeaponDef, WeaponSlot } from './weaponDefs';

/** Gunshot hearing radii by weapon sound (meters). */
const GUNSHOT_RADIUS: Record<string, number> = {
  knife: 6,
  pistol: 50,
  deagle: 60,
  smg: 55,
  rifle_heavy: 70,
  rifle_light: 70,
  awp: 90,
};

export interface HitInfo {
  attacker: Actor;
  victim: Actor;
  def: WeaponDef;
  group: number;
  distance: number;
  /** Damage multiplier from penetration (1 = clean hit). */
  damageScale: number;
  penetrated: boolean;
  pos: Vec3;
}

export interface WeaponContext {
  world: CollisionWorld;
  actors: readonly Actor[];
  events: EventQueue;
  time: number;
  tick: number;
  dt: number;
  /** Resolve damage for a hit (armor, death, rewards). */
  onHit(info: HitInfo): void;
  /** Whether attacker's bullets can hit victim. */
  canHit(attacker: Actor, victim: Actor): boolean;
  /** Launch a grenade from the actor's eye along the view angles. */
  throwGrenade(a: Actor, id: GrenadeId, strength: number, yaw: number, pitch: number): void;
  /** A shot hit a car's body. */
  onVehicleHit?(attacker: Actor, vehicleId: number, damage: number): void;
}

/** Seconds after a throw before the next grenade is drawn. */
const THROW_RECOVER = 0.45;

const tr = makeTrace();
const eye = vec3();
const dir = vec3();
const end = vec3();
const right = vec3();
const up = vec3();
const spreadOut = { x: 0, y: 0 };
const recoilOut = { pitch: 0, yaw: 0 };
const hbHit: HitboxHit = { t: 0, group: HitGroup.Chest };

export function isReloading(a: Actor): boolean {
  return a.wpn.reloadEnd >= 0;
}

export function switchTo(a: Actor, slot: WeaponSlot, ctx: WeaponContext): void {
  if (slot === a.inv.active || !a.inv[slot]) return;
  equipSlot(a, slot, ctx);
}

/** Draw the weapon in a slot, redeploying even if that slot is in hand (its gun was just replaced). */
export function equipSlot(a: Actor, slot: WeaponSlot, ctx: WeaponContext): void {
  if (!a.inv[slot]) return;
  if (a.inv.active !== slot) {
    a.inv.last = a.inv.active;
    a.inv.active = slot;
  }
  const w = a.wpn;
  const def = activeItem(a.inv).def;
  w.reloadEnd = -1;
  w.deployEnd = ctx.time + def.deployTime;
  w.nextAttack = Math.max(w.nextAttack, w.deployEnd);
  w.fireInacc = 0;
  w.recoilIndex = 0;
  w.scope = 0;
  w.rescopeAt = -1;
  w.triggerHeld = true;
  w.pinPulled = false;
  w.thrownAt = -1;
  ctx.events.push({ type: 'deploy', actorId: a.id, weapon: def.id });
}

function startReload(a: Actor, item: WeaponItem, ctx: WeaponContext): void {
  const w = a.wpn;
  const def = item.def;
  if (def.magSize === 0 || w.reloadEnd >= 0 || item.clip >= def.magSize || item.reserve <= 0) return;
  w.reloadEnd = ctx.time + def.reloadTime;
  w.scope = 0;
  w.rescopeAt = -1;
  ctx.events.push({ type: 'reload', actorId: a.id, weapon: def.id });
  ctx.events.push({ type: 'sound', pos: vec3(a.move.pos.x, a.move.pos.y, a.move.pos.z), radius: 8, kind: 'reload', sourceId: a.id });
}

/** Current total inaccuracy for an actor's active weapon (mrad), for crosshair/AI. */
export function currentInaccuracy(a: Actor): number {
  const def = activeItem(a.inv).def;
  const m = a.move;
  return (
    inaccuracy(def, {
      speed: Math.hypot(m.vel.x, m.vel.z),
      onGround: m.onGround,
      ducked: m.ducked,
      scoped: a.wpn.scope > 0,
      fireInacc: a.wpn.fireInacc,
    }) + def.spread
  );
}

/** Run one tick of weapon logic for an actor. */
export function updateWeapon(a: Actor, cmd: UserCmd, ctx: WeaponContext): void {
  const inv = a.inv;
  const w = a.wpn;

  // Weapon selection.
  if (cmd.weaponSelect >= 0) {
    let slot: WeaponSlot | null = null;
    if (cmd.weaponSelect === SELECT_LAST) slot = inv.last;
    else if (cmd.weaponSelect === SELECT_NEXT) slot = cycleSlot(inv, 1);
    else if (cmd.weaponSelect === SELECT_PREV) slot = cycleSlot(inv, -1);
    else slot = slotFromNumber(cmd.weaponSelect);
    if (slot === 'grenade' && inv.active === 'grenade' && cmd.weaponSelect === 4) {
      // Pressing the grenade key again cycles through the types you carry.
      const next = nextGrenadeType(inv);
      if (next !== inv.nadeSel) {
        inv.nadeSel = next;
        syncGrenade(inv);
        equipSlot(a, 'grenade', ctx);
      }
    } else if (slot) switchTo(a, slot, ctx);
  }

  const item = activeItem(inv);
  const def = item.def;
  const t = ctx.time;

  // Finish reload.
  if (w.reloadEnd >= 0 && t >= w.reloadEnd) {
    const take = Math.min(def.magSize - item.clip, item.reserve);
    item.clip += take;
    item.reserve -= take;
    w.reloadEnd = -1;
  }

  w.fireInacc = decayFireInacc(def, w.fireInacc, ctx.dt);
  // Recoil recovers once you stop firing (a little grace so full-auto stays on pattern).
  if (t - w.lastShot > def.cycleTime + ctx.dt * 1.5 && w.recoilIndex > 0) {
    w.recoilIndex = Math.max(0, w.recoilIndex - ctx.dt * (8 + w.recoilIndex * 3));
  }

  if (w.rescopeAt >= 0 && t >= w.rescopeAt) {
    w.scope = w.rescopeLevel;
    w.rescopeAt = -1;
  }

  if (cmd.pressed & Buttons.RELOAD) startReload(a, item, ctx);
  if (cmd.pressed & Buttons.INSPECT) w.inspectAt = t;

  // Scope cycling (snipers).
  if (cmd.pressed & Buttons.ATTACK2 && def.zoomFovs && w.reloadEnd < 0 && t >= w.deployEnd) {
    w.scope = (w.scope + 1) % (def.zoomFovs.length + 1);
    w.rescopeAt = -1;
  }

  a.move.maxSpeed = w.scope > 0 && def.maxSpeedScoped ? def.maxSpeedScoped : def.maxSpeed;

  const attackDown = ((cmd.buttons | cmd.pressed) & Buttons.ATTACK) !== 0;
  const altDown = ((cmd.buttons | cmd.pressed) & Buttons.ATTACK2) !== 0;
  if (!attackDown) w.dryFired = false;

  const ready = t >= w.nextAttack && t >= w.deployEnd && w.reloadEnd < 0;
  if (def.category === 'knife') {
    if (ready && (attackDown || altDown)) knifeAttack(a, def, altDown && !attackDown, cmd, ctx);
    w.triggerHeld = attackDown;
    return;
  }
  if (def.category === 'grenade') {
    grenadeLogic(a, def.id as GrenadeId, attackDown, altDown, ready, cmd, ctx);
    w.triggerHeld = attackDown;
    return;
  }

  if (attackDown && ready && (def.automatic || !w.triggerHeld)) {
    if (item.clip <= 0) {
      if (!w.dryFired) {
        ctx.events.push({ type: 'dryfire', actorId: a.id });
        w.dryFired = true;
        w.nextAttack = t + 0.2;
      }
      if (item.reserve > 0) startReload(a, item, ctx);
    } else {
      const first = (cmd.pressed & Buttons.ATTACK) !== 0 && !w.triggerHeld;
      fire(a, item, first ? cmd.attackYaw : cmd.yaw, first ? cmd.attackPitch : cmd.pitch, ctx);
    }
  }
  w.triggerHeld = attackDown;
}

/**
 * Grenades, CS style: hold attack to pull the pin, release to throw. Primary alone is a full
 * throw, secondary alone an underhand lob, both together in between.
 */
function grenadeLogic(a: Actor, id: GrenadeId, attackDown: boolean, altDown: boolean, ready: boolean, cmd: UserCmd, ctx: WeaponContext): void {
  const w = a.wpn;
  const inv = a.inv;
  const t = ctx.time;
  if (w.thrownAt >= 0) {
    // Just threw: draw the next grenade once the arm has come back.
    if (t - w.thrownAt >= THROW_RECOVER) equipSlot(a, 'grenade', ctx);
    return;
  }
  if (!w.pinPulled) {
    if (ready && (attackDown || altDown) && inv.nades[id] > 0) {
      w.pinPulled = true;
      ctx.events.push({ type: 'nade_pin', actorId: a.id, weapon: id });
    }
  }
  if (!w.pinPulled) return;
  if (attackDown || altDown) {
    w.throwStrength = attackDown && altDown ? 0.7 : attackDown ? 1 : 0.4;
    return;
  }
  // Released: throw.
  w.pinPulled = false;
  w.lastShot = t;
  w.nextAttack = t + THROW_RECOVER;
  inv.nades[id]--;
  ctx.throwGrenade(a, id, w.throwStrength, cmd.yaw, cmd.pitch);
  ctx.events.push({ type: 'nade_throw', actorId: a.id, weapon: id });
  syncGrenade(inv);
  if (inv.active === 'grenade') w.thrownAt = t;
  else equipSlot(a, inv.active, ctx);
}

function viewBasis(yaw: number, pitch: number): void {
  anglesToForward(dir, yaw, pitch);
  right.x = Math.cos(yaw);
  right.y = 0;
  right.z = -Math.sin(yaw);
  // up = right × forward
  up.x = right.y * dir.z - right.z * dir.y;
  up.y = right.z * dir.x - right.x * dir.z;
  up.z = right.x * dir.y - right.y * dir.x;
}

function fire(a: Actor, item: WeaponItem, yaw: number, pitch: number, ctx: WeaponContext): void {
  const w = a.wpn;
  const def = item.def;
  const t = ctx.time;
  const base = t - w.nextAttack < ctx.dt ? w.nextAttack : t;
  w.nextAttack = base + def.cycleTime;

  // Recoil offset for this shot, then spread around it.
  patternAt(getPattern(def.pattern), w.recoilIndex, recoilOut);
  const inacc = inaccuracy(def, {
    speed: Math.hypot(a.move.vel.x, a.move.vel.z),
    onGround: a.move.onGround,
    ducked: a.move.ducked,
    scoped: w.scope > 0,
    fireInacc: w.fireInacc,
  });
  viewBasis(yaw + recoilOut.yaw * DEG, pitch + recoilOut.pitch * DEG);
  const rng = sfc32(hash4(a.id, ctx.tick, w.shotCounter, Salt.Spread));
  sampleSpread(rng, inacc, def.spread, spreadOut);
  dir.x += right.x * spreadOut.x + up.x * spreadOut.y;
  dir.y += right.y * spreadOut.x + up.y * spreadOut.y;
  dir.z += right.z * spreadOut.x + up.z * spreadOut.y;
  const l = Math.hypot(dir.x, dir.y, dir.z);
  dir.x /= l;
  dir.y /= l;
  dir.z /= l;

  w.shotCounter++;
  w.fireInacc += def.inaccFire;
  w.recoilIndex += 1;
  w.lastShot = t;
  item.clip--;

  eye.x = a.move.pos.x;
  eye.y = a.move.pos.y + eyeHeight(a.move);
  eye.z = a.move.pos.z;
  const hitPoint = hitscan(a, def, eye, dir, ctx);
  ctx.events.push({
    type: 'shot',
    shooterId: a.id,
    weapon: def.id,
    from: vec3(eye.x, eye.y, eye.z),
    to: hitPoint,
    tracer: def.tracerEvery > 0 && w.shotCounter % def.tracerEvery === 1 % def.tracerEvery,
  });
  ctx.events.push({
    type: 'sound',
    pos: vec3(eye.x, eye.y, eye.z),
    radius: GUNSHOT_RADIUS[def.sound] ?? 60,
    kind: 'gunshot',
    sourceId: a.id,
  });

  // Snipers unscope after the shot and rescope when the bolt has cycled.
  if (w.scope > 0 && def.zoomFovs) {
    w.rescopeLevel = w.scope;
    w.scope = 0;
    w.rescopeAt = t + def.cycleTime * 0.95;
  }
}

/**
 * Trace a bullet through the world and actors. Penetrable brushes thinner than the weapon's
 * penetration let the bullet continue with reduced damage. Returns the final end point.
 */
function hitscan(a: Actor, def: WeaponDef, start: Vec3, d: Vec3, ctx: WeaponContext): Vec3 {
  let sx = start.x;
  let sy = start.y;
  let sz = start.z;
  let travelled = 0;
  let scale = 1;
  let pens = def.id === 'awp' ? 2 : 1;
  const segStart = vec3();
  for (let seg = 0; seg < 3; seg++) {
    const len = def.range - travelled;
    if (len <= 0) break;
    segStart.x = sx;
    segStart.y = sy;
    segStart.z = sz;
    end.x = sx + d.x * len;
    end.y = sy + d.y * len;
    end.z = sz + d.z * len;
    ctx.world.traceRay(tr, segStart, end, MASK_SHOT);
    const worldT = tr.fraction * len;

    // Nearest actor in front of the wall.
    let victim: Actor | null = null;
    let vt = worldT;
    let vg: number = HitGroup.Chest;
    for (const o of ctx.actors) {
      if (o === a || !o.alive || !ctx.canHit(a, o)) continue;
      const p = o.move.pos;
      if (rayActor(sx, sy, sz, d.x, d.y, d.z, vt, p.x, p.y, p.z, o.yaw, bodyScale(o.move), hbHit)) {
        if (hbHit.t < vt) {
          vt = hbHit.t;
          vg = hbHit.group;
          victim = o;
        }
      }
    }
    if (victim) {
      const pos = vec3(sx + d.x * vt, sy + d.y * vt, sz + d.z * vt);
      ctx.onHit({
        attacker: a,
        victim,
        def,
        group: vg,
        distance: travelled + vt,
        damageScale: scale,
        penetrated: seg > 0,
        pos,
      });
      return pos;
    }

    const hit = vec3(tr.endX, tr.endY, tr.endZ);
    if (tr.fraction >= 1 || !tr.brush) return hit;
    ctx.events.push({
      type: 'impact',
      actorId: a.id,
      pos: hit,
      normal: vec3(tr.normal.x, tr.normal.y, tr.normal.z),
      material: tr.brush.material,
      chunkKey: tr.brush.chunkKey,
    });
    if (tr.brush.owner) {
      ctx.onVehicleHit?.(a, tr.brush.owner, rangeDamage(def.damage, def.rangeMod, travelled + worldT) * scale);
      return hit;
    }

    // Penetration.
    const b = tr.brush;
    if (pens <= 0 || (b.contents & Contents.PENETRABLE) === 0 || def.penetration <= 0) return hit;
    const probe = Math.min(2, def.penetration + 0.05);
    const ex = tr.endX + d.x * probe;
    const ey = tr.endY + d.y * probe;
    const ez = tr.endZ + d.z * probe;
    const exitF = rayExitFraction(b, tr.endX, tr.endY, tr.endZ, ex, ey, ez);
    if (exitF < 0 || exitF >= 1) return hit;
    const thickness = exitF * probe;
    if (thickness > def.penetration) return hit;
    scale *= Math.max(0.15, (1 - thickness / def.penetration) * 0.75);
    pens--;
    const ox = tr.endX + d.x * (thickness + 0.01);
    const oy = tr.endY + d.y * (thickness + 0.01);
    const oz = tr.endZ + d.z * (thickness + 0.01);
    ctx.events.push({
      type: 'impact',
      actorId: a.id,
      pos: vec3(ox, oy, oz),
      normal: vec3(d.x, d.y, d.z),
      material: b.material,
      chunkKey: b.chunkKey,
    });
    travelled += worldT + thickness;
    sx = ox;
    sy = oy;
    sz = oz;
  }
  return vec3(sx, sy, sz);
}

function knifeAttack(a: Actor, def: WeaponDef, alt: boolean, cmd: UserCmd, ctx: WeaponContext): void {
  const w = a.wpn;
  const reach = alt ? (def.altRange ?? 1) : (def.meleeRange ?? 1.3);
  w.nextAttack = ctx.time + (alt ? (def.altCycleTime ?? 1) : def.cycleTime);
  w.lastShot = ctx.time;
  w.shotCounter++;
  eye.x = a.move.pos.x;
  eye.y = a.move.pos.y + eyeHeight(a.move);
  eye.z = a.move.pos.z;
  viewBasis(cmd.yaw, cmd.pitch);
  end.x = eye.x + dir.x * reach;
  end.y = eye.y + dir.y * reach;
  end.z = eye.z + dir.z * reach;
  ctx.world.traceRay(tr, eye, end, MASK_SHOT);
  const worldT = tr.fraction * reach;
  let victim: Actor | null = null;
  let vt = worldT;
  let vg: number = HitGroup.Chest;
  for (const o of ctx.actors) {
    if (o === a || !o.alive || !ctx.canHit(a, o)) continue;
    const p = o.move.pos;
    // Knife uses a fat ray: test a few offsets so it feels like a swing, not a needle.
    for (const off of [0, 0.12, -0.12]) {
      if (rayActor(eye.x + right.x * off, eye.y, eye.z + right.z * off, dir.x, dir.y, dir.z, vt, p.x, p.y, p.z, o.yaw, bodyScale(o.move), hbHit)) {
        if (hbHit.t < vt) {
          vt = hbHit.t;
          vg = hbHit.group === HitGroup.Head ? HitGroup.Head : HitGroup.Chest;
          victim = o;
        }
      }
    }
  }
  ctx.events.push({ type: 'shot', shooterId: a.id, weapon: def.id, from: vec3(eye.x, eye.y, eye.z), to: vec3(end.x, end.y, end.z), tracer: false });
  ctx.events.push({ type: 'sound', pos: vec3(eye.x, eye.y, eye.z), radius: 6, kind: 'knife', sourceId: a.id });
  if (victim) {
    // Backstab: attacker is behind the victim (facing roughly the same way).
    const vf = { x: -Math.sin(victim.yaw), z: -Math.cos(victim.yaw) };
    const behind = vf.x * dir.x + vf.z * dir.z > 0.5;
    const base = alt ? (def.altDamage ?? 65) : def.damage;
    const dmgDef = { ...def, damage: behind ? base * (alt ? 2.8 : 2.25) : base };
    ctx.onHit({
      attacker: a,
      victim,
      def: dmgDef,
      group: vg === HitGroup.Head ? HitGroup.Chest : vg,
      distance: 0,
      damageScale: 1,
      penetrated: false,
      pos: vec3(eye.x + dir.x * vt, eye.y + dir.y * vt, eye.z + dir.z * vt),
    });
  } else if (tr.fraction < 1 && tr.brush) {
    ctx.events.push({
      type: 'impact',
      actorId: a.id,
      pos: vec3(tr.endX, tr.endY, tr.endZ),
      normal: vec3(tr.normal.x, tr.normal.y, tr.normal.z),
      material: tr.brush.material,
      chunkKey: tr.brush.chunkKey,
    });
    if (tr.brush.owner) ctx.onVehicleHit?.(a, tr.brush.owner, (alt ? (def.altDamage ?? 65) : def.damage) * 0.5);
  }
}
