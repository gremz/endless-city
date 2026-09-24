import { HitGroup } from '../../ai/hitboxes';
import { vec3 } from '../../core/math';
import { MASK_PLAYER } from '../../physics/brush';
import { makeTrace } from '../../physics/trace';
import { hullMaxs, hullMins } from '../../player/pmove';
import { CAR_HIT } from '../../weapons/weaponDefs';
import { chunkKey, worldToChunk } from '../../world/chunkMath';
import { VEHICLE_STRIDE, type ChunkData } from '../../world/gen/ChunkData';
import type { StreamerListener } from '../../world/WorldStreamer';
import { Team, type Actor } from '../Actor';
import type { Simulation, SimSystem } from '../Simulation';
import { CAR_HALF_L, CAR_HALF_W, carSpeed, footprintDistance } from './carPhysics';
import {
  coastVehicle,
  makeVehicle,
  runOverDamage,
  syncVehicleBrushes,
  vehicleAtRest,
  VEHICLE_HEALTH,
  type Vehicle,
} from './Vehicle';

/** Cars that have been moved are remembered (where they were left) up to this many. */
export const MAX_MOVED = 32;
/** Someone this close to a moving car's footprint gets hit (about a body's half width). */
const HIT_MARGIN = 0.45;
/** Seconds before the same car can hurt the same actor again. */
const HIT_COOLDOWN = 0.6;
const MAX_ID = 60000;

/** A moved car as stored in a save (cars still in their parking spot are regenerated). */
export interface SavedVehicle {
  pos: [number, number, number];
  yaw: number;
  paint: number;
  hatch: boolean;
  health: number;
  destroyed: boolean;
}

export interface VehicleSave {
  /** Parking slots ("chunkKey:slot") whose car was moved or wrecked. */
  taken: string[];
  cars: SavedVehicle[];
}

/**
 * The driveable cars' lifecycle on the host (or in a solo game): cars appear in their parking
 * spots as chunks load. Once driven or damaged a car stays wherever it is left (asleep while its
 * chunk is unloaded) and its spot stays empty. Each tick, driverless cars roll to a stop, moving
 * cars knock people over, and every car's collision boxes follow it.
 */
export class Vehicles implements SimSystem, StreamerListener {
  /** Moved cars whose chunk isn't loaded right now. */
  private asleep: Vehicle[] = [];
  private taken = new Set<string>();
  private nextId = 1;
  private tr = makeTrace();

  constructor(private sim: Simulation) {}

  onChunkLoaded(data: ChunkData): void {
    const sim = this.sim;
    const spots = data.vehicles;
    for (let i = 0; i < spots.length / VEHICLE_STRIDE; i++) {
      const home = `${data.key}:${i}`;
      if (this.taken.has(home) || sim.vehicles.some((v) => v.home === home)) continue;
      const o = i * VEHICLE_STRIDE;
      const v = makeVehicle(this.newId(), spots[o], spots[o + 1], spots[o + 2], spots[o + 3], spots[o + 4], spots[o + 5] > 0.5, home);
      this.add(v);
    }
    for (let i = this.asleep.length - 1; i >= 0; i--) {
      const v = this.asleep[i];
      if (keyAt(v) !== data.key) continue;
      this.asleep.splice(i, 1);
      v.id = this.newId();
      v.brushPose[0] = NaN;
      this.add(v);
    }
  }

  onChunkUnloaded(key: number): void {
    const sim = this.sim;
    for (let i = sim.vehicles.length - 1; i >= 0; i--) {
      const v = sim.vehicles[i];
      if (v.driver >= 0 || keyAt(v) !== key) continue;
      sim.removeVehicle(v);
      if (v.moved) this.sleep(v);
    }
  }

  onChunkVisibility(): void {}

  private add(v: Vehicle): void {
    this.sim.addVehicle(v);
    syncVehicleBrushes(this.sim.world, v);
  }

  private sleep(v: Vehicle): void {
    v.hitCooldown.clear();
    this.asleep.push(v);
    this.trimMoved();
  }

  /** Forget the oldest sleeping cars (wrecks first) beyond MAX_MOVED moved cars. */
  private trimMoved(): void {
    let moved = this.asleep.length + this.sim.vehicles.filter((v) => v.moved).length;
    while (moved > MAX_MOVED && this.asleep.length) {
      const i = this.asleep.findIndex((v) => v.destroyed);
      this.asleep.splice(i >= 0 ? i : 0, 1);
      moved--;
    }
  }

  private newId(): number {
    for (;;) {
      const id = this.nextId;
      this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1;
      if (!this.sim.getVehicle(id)) return id;
    }
  }

  update(sim: Simulation): void {
    for (const v of sim.vehicles) {
      if (v.driver >= 0) {
        const d = sim.getActor(v.driver);
        if (!d || !d.alive || d.vehicle !== v.id) v.driver = -1;
      }
      if (v.moved && v.home && !this.taken.has(v.home)) this.taken.add(v.home);
      // The driver's command moved the car already; the others roll to a stop.
      if (v.driver < 0 && !vehicleAtRest(v)) coastVehicle(sim, v);
      if (carSpeed(v.car) > 1) this.runOver(v);
      syncVehicleBrushes(sim.world, v);
    }
  }

  /** Knock aside anyone the car drives into, hurting enemies of whoever is (or was) driving. */
  private runOver(v: Vehicle): void {
    const sim = this.sim;
    const c = v.car;
    const speed = carSpeed(c);
    const driver = sim.getActor(v.driver >= 0 ? v.driver : v.lastDriver) ?? null;
    const local = { s: 0, t: 0 };
    for (const a of sim.actors) {
      if (!a.alive || a.vehicle >= 0 || a.move.noclip) continue;
      const p = a.move.pos;
      const dy = p.y - c.pos.y;
      if (dy < -1.2 || dy > 1.3) continue;
      if (footprintDistance(c, p.x, p.z, local) > HIT_MARGIN) continue;
      // Out the nearest side of the footprint.
      const outF = CAR_HALF_L + HIT_MARGIN - local.s;
      const outB = local.s + CAR_HALF_L + HIT_MARGIN;
      const outR = CAR_HALF_W + HIT_MARGIN - local.t;
      const outL = local.t + CAR_HALF_W + HIT_MARGIN;
      const min = Math.min(outF, outB, outR, outL);
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      let dirX: number;
      let dirZ: number;
      if (min === outF) [dirX, dirZ] = [fx, fz];
      else if (min === outB) [dirX, dirZ] = [-fx, -fz];
      else if (min === outR) [dirX, dirZ] = [-fz, fx];
      else [dirX, dirZ] = [fz, -fx];
      this.shove(a, dirX * min, dirZ * min);
      // Thrown along with the car.
      const closing = Math.max(0, c.vel.x * dirX + c.vel.z * dirZ);
      if (!a.dummy) {
        a.move.vel.x += dirX * (1.5 + closing * 0.7);
        a.move.vel.z += dirZ * (1.5 + closing * 0.7);
        if (closing > 3) {
          a.move.vel.y = Math.max(a.move.vel.y, Math.min(4, closing * 0.25));
          a.move.onGround = false;
        }
      }
      const until = v.hitCooldown.get(a.id) ?? -1;
      if (until > sim.time) continue;
      v.hitCooldown.set(a.id, sim.time + HIT_COOLDOWN);
      // Hitting someone costs the car some speed.
      if (closing > 1) {
        const keep = a.team === Team.Bots ? 0.85 : 0.92;
        c.vel.x *= keep;
        c.vel.z *= keep;
      }
      const dmg = runOverDamage(Math.max(closing, speed * 0.6));
      if (dmg > 0 && driver && driver !== a && sim.canHit(driver, a)) this.hurt(driver, a, dmg);
    }
    if (v.hitCooldown.size > 16) for (const [id, t] of v.hitCooldown) if (t <= sim.time) v.hitCooldown.delete(id);
  }

  private hurt(driver: Actor, victim: Actor, dmg: number): void {
    this.sim.onHit({
      attacker: driver,
      victim,
      def: { ...CAR_HIT, damage: dmg },
      group: HitGroup.Chest,
      distance: 0,
      damageScale: 1,
      penetrated: false,
      pos: vec3(victim.move.pos.x, victim.move.pos.y + 1, victim.move.pos.z),
    });
  }

  /** Push an actor sideways, traced so nobody gets shoved into a wall. */
  private shove(a: Actor, dx: number, dz: number): void {
    if (a.dummy) return;
    const m = a.move;
    const end = vec3(m.pos.x + dx, m.pos.y, m.pos.z + dz);
    this.sim.world.traceBox(this.tr, m.pos, end, hullMins(m), hullMaxs(m), MASK_PLAYER);
    if (this.tr.startSolid) return;
    m.pos.x = this.tr.endX;
    m.pos.z = this.tr.endZ;
  }

  serialize(): VehicleSave {
    const moved = [...this.sim.vehicles.filter((v) => v.moved), ...this.asleep];
    return {
      taken: [...this.taken],
      cars: moved.map((v) => ({
        pos: [v.car.pos.x, v.car.pos.y, v.car.pos.z],
        yaw: v.car.yaw,
        paint: v.paint,
        hatch: v.hatch,
        health: v.health,
        destroyed: v.destroyed,
      })),
    };
  }

  /** Bring back saved cars (before the world streams in: they wake up with their chunks). */
  restore(s: VehicleSave): void {
    this.taken = new Set(s.taken);
    this.asleep = s.cars.map((c) => {
      const v = makeVehicle(0, c.pos[0], c.pos[1], c.pos[2], c.yaw, c.paint, c.hatch);
      v.moved = true;
      v.health = Math.max(0, Math.min(VEHICLE_HEALTH, c.health));
      v.destroyed = c.destroyed || v.health <= 0;
      if (v.destroyed) v.health = 0;
      return v;
    });
  }
}

function keyAt(v: Vehicle): number {
  return chunkKey(worldToChunk(v.car.pos.x), worldToChunk(v.car.pos.z));
}
