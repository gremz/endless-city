import type { EncounterManager } from '../ai/EncounterManager';
import type { SimEvent } from '../core/events';
import { vec3, wrapAngle } from '../core/math';
import { makeActor, storePrev, Team, teleport, type Actor, type TeamId } from '../sim/Actor';
import type { Fire, Projectile, SmokeCloud } from '../sim/Grenades';
import type { PickupManager } from '../sim/Pickups';
import type { Simulation } from '../sim/Simulation';
import type { Vehicle } from '../sim/vehicle/Vehicle';
import { makeInventory, makeItem, syncGrenade, type Inventory } from '../weapons/Inventory';
import { WEAPONS } from '../weapons/weaponDefs';
import { makeVehicle, occupantIds, storeVehiclePrev, syncVehicleBrushes } from '../sim/vehicle/Vehicle';
import { CarFlag, Flag, fromNetPickup, type NetActor, type NetInv, type NetVehicle, type PrivateState, type ServerMsg, type Snapshot } from './protocol';

/** Other actors are drawn this far in the past, between two snapshots that already arrived. */
export const INTERP_DELAY = 0.1;
/** How far past the newest snapshot others may be extrapolated when packets are late. */
const MAX_EXTRAPOLATE = 0.05;

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  duck: number;
}

/** Events our own prediction already produced; the host's copies are dropped. */
const PREDICTED = new Set<SimEvent['type']>([
  'shot',
  'impact',
  'reload',
  'deploy',
  'dryfire',
  'nade_pin',
  'nade_throw',
  'jump',
  'land',
  'step',
  'flashlight',
  'car_door',
  'car_crash',
]);

function actorOf(e: SimEvent): number {
  if (e.type === 'shot') return e.shooterId;
  return 'actorId' in e ? e.actorId : -1;
}

/**
 * Keeps a client's copy of the simulation in step with the host: actors, the local player's
 * private state, grenades, pickups and progress. Nothing but the local player (see Prediction)
 * is simulated on the client; the presentation layer reads this mirror exactly as it reads a
 * local game. Everyone else is drawn INTERP_DELAY behind, smoothly between snapshots.
 */
export class Mirror {
  readonly roster = new Map<number, { name: string; team: number; dummy: boolean }>();
  private swapId = -1;
  private seen = new Set<number>();
  private samples = new Map<number, Sample[]>();
  private nadeSamples = new Map<number, Sample[]>();
  private carSamples = new Map<number, Sample[]>();
  private seenCars = new Set<number>();
  /** Host time minus local time (seconds), smoothed. */
  private clockOffset: number | null = null;

  constructor(
    private sim: Simulation,
    private localId: number,
    private pickups: PickupManager | null,
    private encounters: EncounterManager | null,
    /** The local player is predicted: keep its interpolation start and our own events. */
    private predicted = false,
  ) {}

  /** The host time other actors are being drawn at, for local time `now` (seconds). */
  renderTime(now: number): number {
    return this.clockOffset === null ? this.sim.time : now + this.clockOffset - INTERP_DELAY;
  }

  /** Track the host clock from a snapshot's arrival (local time `now`, seconds). */
  private syncClock(hostTime: number, now: number): void {
    const target = hostTime - now;
    if (this.clockOffset === null || Math.abs(target - this.clockOffset) > 0.25) this.clockOffset = target;
    // Late packets pull the clock back only a little; early ones pull it forward a bit more.
    else this.clockOffset += (target - this.clockOffset) * (target > this.clockOffset ? 0.1 : 0.02);
  }

  /** Apply a reliable message. Returns false for ones the game handles itself (chat). */
  applyMessage(m: ServerMsg): boolean {
    const sim = this.sim;
    switch (m.t) {
      case 'roster':
        for (const [id, name, team, dummy] of m.add) {
          this.roster.set(id, { name, team, dummy });
          const a = sim.getActor(id);
          if (a && id !== this.localId) a.name = name;
        }
        return true;
      case 'ev':
        for (const e of m.e) {
          if (this.predicted && PREDICTED.has(e.type) && actorOf(e) === this.localId) continue;
          // Doors and pieces change here right away (the world state catches up later).
          if (e.type === 'door') sim.doors.applyAction(e.chunkKey, e.index, e.state, e.side);
          else if (e.type === 'piece_break') sim.pieces.breakPiece(e.chunkKey, e.index, false);
          else if (e.type === 'breach_plant') sim.charges.addRemote(e);
          else if (e.type === 'breach_detonate') sim.charges.remove(e.id);
          sim.events.push(e);
        }
        return true;
      case 'pickups':
        this.pickups?.replicate(m.items.map(fromNetPickup), this.localId, this.swapId);
        return true;
      case 'world':
        sim.cleared.clear();
        for (const k of m.cleared) sim.cleared.add(k);
        this.encounters?.applyRemote(m.enc);
        sim.doors.restore(m.doors);
        sim.pieces.restore(m.pieces);
        return true;
      default:
        return false;
    }
  }

  /** Apply a snapshot that arrived at local time `now` (seconds). */
  applySnapshot(s: Snapshot, now = 0): void {
    const sim = this.sim;
    this.syncClock(s.time, now);
    sim.tick = s.tick;
    sim.time = s.time;
    sim.updateEnv();
    const seen = this.seen;
    seen.clear();
    for (const na of s.actors) {
      seen.add(na.id);
      let a = sim.getActor(na.id);
      const fresh = !a;
      const local = na.id === this.localId;
      if (!a) a = this.addActor(na);
      else if (!(local && this.predicted)) storePrev(a);
      this.applyActor(a, na, local);
      if (fresh) teleport(a, na.x, na.y, na.z);
      if (!local) this.record(this.samples, na.id, s.time, na.x, na.y, na.z, na.yaw, na.pitch, na.duck);
    }
    for (let i = sim.actors.length - 1; i >= 0; i--) {
      const a = sim.actors[i];
      if (seen.has(a.id) || a.id === this.localId) continue;
      if (a.team === Team.Player) sim.removePlayer(a);
      else sim.removeActor(a);
      this.samples.delete(a.id);
    }
    const me = sim.getActor(this.localId);
    this.applyVehicles(s);
    if (me && s.me) this.applyPrivate(me, s.me);
    this.applyGrenades(s, me ?? sim.player);
  }

  /**
   * Cars: everything the host sent, raw (the one we drive is then re-predicted on top), and
   * who is driving what.
   */
  private applyVehicles(s: Snapshot): void {
    const sim = this.sim;
    const me = sim.getActor(this.localId);
    const mine = this.predicted && me ? drivenBy(sim, me) : -1;
    const seen = this.seenCars;
    seen.clear();
    for (const nv of s.vehicles) {
      seen.add(nv.id);
      let v = sim.getVehicle(nv.id);
      if (!v) {
        v = makeVehicle(nv.id, nv.x, nv.y, nv.z, nv.yaw, nv.paint, !!(nv.flags & CarFlag.Hatch));
        sim.addVehicle(v);
        this.carSamples.delete(nv.id);
      } else if (nv.id !== mine) storeVehiclePrev(v);
      applyVehicle(v, nv);
      this.record(this.carSamples, nv.id, s.time, nv.x, nv.y, nv.z, nv.yaw, nv.pitch, nv.roll);
    }
    for (let i = sim.vehicles.length - 1; i >= 0; i--) {
      const v = sim.vehicles[i];
      if (seen.has(v.id)) continue;
      sim.removeVehicle(v);
      this.carSamples.delete(v.id);
    }
    for (const a of sim.actors) a.vehicle = -1;
    for (const v of sim.vehicles) {
      for (const id of occupantIds(v)) {
        const a = sim.getActor(id);
        if (a) a.vehicle = v.id;
      }
    }
  }

  private record(map: Map<number, Sample[]>, id: number, t: number, x: number, y: number, z: number, yaw: number, pitch: number, duck: number): void {
    let list = map.get(id);
    if (!list) map.set(id, (list = []));
    list.push({ t, x, y, z, yaw, pitch, duck });
    // A second of history is plenty.
    while (list.length > 2 && list[0].t < t - 1) list.shift();
  }

  /** Place everyone but the local player (and grenades) at host time `t`. */
  interpolate(t: number): void {
    const sim = this.sim;
    for (const a of sim.actors) {
      if (a.id === this.localId) continue;
      const list = this.samples.get(a.id);
      if (!list?.length) continue;
      const p = sampleAt(list, t);
      a.move.pos.x = a.prevPos.x = p.x;
      a.move.pos.y = a.prevPos.y = p.y;
      a.move.pos.z = a.prevPos.z = p.z;
      a.yaw = a.prevYaw = p.yaw;
      a.pitch = p.pitch;
      a.move.duckAmount = p.duck;
    }
    const me = sim.getActor(this.localId);
    const mine = this.predicted && me ? drivenBy(sim, me) : -1;
    for (const v of sim.vehicles) {
      if (v.id !== mine) {
        const list = this.carSamples.get(v.id);
        if (list?.length) {
          const p = sampleAt(list, t);
          const c = v.car;
          c.pos.x = v.prevPos.x = p.x;
          c.pos.y = v.prevPos.y = p.y;
          c.pos.z = v.prevPos.z = p.z;
          c.yaw = v.prevYaw = p.yaw;
          c.pitch = p.pitch;
          c.roll = p.duck;
        }
      }
      // Our own player collides with where everyone else's cars are drawn.
      syncVehicleBrushes(sim.world, v);
    }
    for (const g of sim.grenades.projectiles) {
      const list = this.nadeSamples.get(g.id);
      if (!list?.length) continue;
      const p = sampleAt(list, t);
      g.pos.x = g.prevPos.x = p.x;
      g.pos.y = g.prevPos.y = p.y;
      g.pos.z = g.prevPos.z = p.z;
    }
  }

  private addActor(na: NetActor): Actor {
    const r = this.roster.get(na.id);
    const a = makeActor(na.id, r?.name ?? '…', na.team as TeamId, na.x, na.y, na.z);
    a.dummy = !!(na.flags & Flag.Dummy);
    // The opening's hostage is on the players' side but isn't one.
    a.captive = !!(na.flags & Flag.Captive);
    a.inv = makeInventory(null);
    if (a.team === Team.Player && !a.captive) this.sim.players.push(a);
    this.sim.actors.push(a);
    return a;
  }

  private applyActor(a: Actor, na: NetActor, local: boolean): void {
    const m = a.move;
    const f = na.flags;
    m.pos.x = na.x;
    m.pos.y = na.y;
    m.pos.z = na.z;
    m.vel.x = na.vx;
    m.vel.y = na.vy;
    m.vel.z = na.vz;
    m.onGround = !!(f & Flag.OnGround);
    m.ducked = !!(f & Flag.Ducked);
    m.duckAmount = na.duck;
    m.noclip = !!(f & Flag.Noclip);
    a.yaw = na.yaw;
    a.pitch = na.pitch;
    a.alive = !!(f & Flag.Alive);
    a.health = na.health;
    a.armor = na.armor;
    a.helmet = !!(f & Flag.Helmet);
    a.flashlight = !!(f & Flag.Flashlight);
    a.engaging = !!(f & Flag.Engaging);
    a.diedAt = na.diedAt;
    if (local) return;
    // Others: just enough of the loadout to draw them.
    const inv = a.inv;
    inv.primary = f & Flag.HasPrimary ? (inv.primary ?? makeItem('ak47')) : null;
    inv.secondary = f & Flag.HasSecondary ? (inv.secondary ?? makeItem('glock')) : null;
    inv.active = na.slot;
    a.healEnd = f & Flag.Healing ? this.sim.time + 1 : -1;
  }

  private applyPrivate(a: Actor, p: PrivateState): void {
    a.money = p.money;
    a.medkits = p.medkits;
    a.healEnd = p.healEnd;
    [a.breachCharges, a.plantEnd] = p.breach ?? [0, -1];
    [a.flashStart, a.flashUntil, a.flashPeak] = p.flash;
    [a.lastDamagedAt, a.lastDealtAt, a.lastAttacker] = p.combat;
    a.inv = unpackInv(p.inv);
    Object.assign(a.wpn, p.wpn);
    [a.move.tagTime, a.move.maxSpeed, a.move.groundNormalY, a.move.mantleT, a.move.mantleTo.x, a.move.mantleTo.y, a.move.mantleTo.z] = p.mv;
    if (p.swap !== this.swapId) {
      this.swapId = p.swap;
      this.pickups?.setSwapCandidate(this.localId, p.swap);
    }
  }

  private applyGrenades(s: Snapshot, owner: Actor): void {
    const g = this.sim.grenades;
    const old = new Map(g.projectiles.map((p) => [p.id, p]));
    for (const id of this.nadeSamples.keys()) if (!s.nades.p.some((p) => p[0] === id)) this.nadeSamples.delete(id);
    const projectiles: Projectile[] = s.nades.p.map(([id, kind, x, y, z, restTime]) => {
      this.record(this.nadeSamples, id, s.time, x, y, z, 0, 0, 0);
      const p = old.get(id);
      if (p) {
        p.prevPos.x = p.pos.x;
        p.prevPos.y = p.pos.y;
        p.prevPos.z = p.pos.z;
        p.pos.x = x;
        p.pos.y = y;
        p.pos.z = z;
        p.restTime = restTime;
        return p;
      }
      return { id, kind, owner, pos: vec3(x, y, z), prevPos: vec3(x, y, z), vel: vec3(), spawnTime: s.time, restTime };
    });
    g.projectiles.length = 0;
    g.projectiles.push(...projectiles);
    const smokes: SmokeCloud[] = s.nades.s.map(([id, x, y, z, start, end]) => ({ id, pos: vec3(x, y, z), start, end }));
    g.smokes.length = 0;
    g.smokes.push(...smokes);
    const fires: Fire[] = s.nades.f.map(([id, x, y, z, radius, start, end]) => ({ id, pos: vec3(x, y, z), radius, start, end, owner, nextTick: Infinity }));
    if (fires.length !== g.fires.length) g.fireVersion++;
    g.fires.length = 0;
    g.fires.push(...fires);
  }
}

function applyVehicle(v: Vehicle, n: NetVehicle): void {
  const c = v.car;
  c.pos.x = n.x;
  c.pos.y = n.y;
  c.pos.z = n.z;
  c.vel.x = n.vx;
  c.vel.y = n.vy;
  c.vel.z = n.vz;
  c.yaw = n.yaw;
  c.yawRate = n.yawRate;
  c.steer = n.steer;
  c.throttle = n.throttle;
  c.pitch = n.pitch;
  c.roll = n.roll;
  c.onGround = !!(n.flags & CarFlag.OnGround);
  c.braking = !!(n.flags & CarFlag.Braking);
  v.paint = n.paint;
  v.hatch = !!(n.flags & CarFlag.Hatch);
  v.destroyed = !!(n.flags & CarFlag.Destroyed);
  v.health = n.health;
  v.driver = n.driver;
  v.passengers[0] = n.passengers[0];
  v.passengers[1] = n.passengers[1];
  v.passengers[2] = n.passengers[2];
  v.burnUntil = n.burnUntil;
}

const out: Sample = { t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, duck: 0 };

/** State at time t from a time-ordered sample list (clamped, with a short extrapolation). */
function sampleAt(list: readonly Sample[], t: number): Sample {
  const last = list[list.length - 1];
  let a = list[0];
  let b = last;
  if (t >= last.t) {
    if (list.length < 2) return last;
    a = list[list.length - 2];
    b = last;
    t = Math.min(t, last.t + MAX_EXTRAPOLATE);
  } else if (t <= a.t) {
    return a;
  } else {
    for (let i = 1; i < list.length; i++) {
      if (list[i].t >= t) {
        a = list[i - 1];
        b = list[i];
        break;
      }
    }
  }
  const span = b.t - a.t;
  const k = span > 1e-6 ? (t - a.t) / span : 1;
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  out.yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * k;
  out.pitch = a.pitch + (b.pitch - a.pitch) * k;
  out.duck = a.duck + (b.duck - a.duck) * k;
  return out;
}

/** Rebuild an inventory from its wire form. */
export function unpackInv(n: NetInv): Inventory {
  const inv = makeInventory(null);
  const item = (w: NetInv['p']) => (w && WEAPONS[w[0]] ? { def: WEAPONS[w[0]], clip: w[1], reserve: w[2] } : null);
  inv.primary = item(n.p);
  inv.secondary = item(n.s);
  inv.nades = { ...n.n };
  inv.nadeSel = n.sel;
  inv.active = n.a;
  inv.last = n.l;
  syncGrenade(inv);
  inv.active = n.a;
  if (!inv[inv.active]) inv.active = inv.primary ? 'primary' : inv.secondary ? 'secondary' : 'knife';
  return inv;
}

/** The car an actor is driving (the one their own prediction moves), or -1. */
function drivenBy(sim: Simulation, a: Actor): number {
  const v = sim.vehicleOf(a);
  return v && v.driver === a.id ? v.id : -1;
}
