import { vec3, type Vec3 } from '../../core/math';
import { hash3, Salt, sfc32, type Rand } from '../../core/rng';
import { MASK_SHOT } from '../../physics/brush';
import { makeTrace } from '../../physics/trace';
import { makeActor, Team, teleport, type Actor } from '../../sim/Actor';
import type { Simulation, SimSystem } from '../../sim/Simulation';
import { makeInventory } from '../../weapons/Inventory';
import type { HitInfo } from '../../weapons/WeaponSystem';
import { chunkKey, worldToChunk } from '../../world/chunkMath';
import { District, Landmark, type ChunkData } from '../../world/gen/ChunkData';
import type { WorldStreamer } from '../../world/WorldStreamer';
import { hearingRadius } from '../EncounterManager';
import { Axis, clearPath, cornerCoord, edgeChunks, edgeKey, heightAt, probeEdge, type AxisId, type Edge } from './sidewalks';

/** Most pedestrians alive at once (the renderers' budget is shared with bots and players). */
export const MAX_CIVS = 24;
/** Money a player loses for killing a civilian. */
export const CIV_FINE = 300;
/** Pedestrians per chunk around the players, by district (Spawn, Industrial, Old Town, Downtown, Gym). */
const DISTRICT_DENSITY = [2.5, 1, 2.5, 3.5, 0];
/** Extra pedestrians in a plaza or park. */
const OPEN_SPACE_BONUS = 1;
/** New pedestrians appear this far from every player (m), out of sight. */
const MIN_SPAWN_DIST = 30;
const MAX_SPAWN_DIST = 100;
/** Out of sight and this far from every player (m): gone. Past HARD_DESPAWN, gone even if seen. */
const DESPAWN_DIST = 115;
const HARD_DESPAWN = 160;
const BODY_TIME = 15;
const WALK_SPEED = [1.15, 1.6] as const;
const RUN_SPEED = [4.4, 5.4] as const;
/** Sideways offset from the walking line: people keep to their right. */
const LANE = 0.2;
/** Look-ahead along the edge when steering back to the line (m). */
const LOOK_AHEAD = 1.5;
/** Chance of stopping for a while at a corner, and for how long (s). */
const WAIT_CHANCE = 0.15;
const WAIT_TIME = [2, 6] as const;
/** Sounds and hits this close set people running; panic spreads this far. */
const ALARM_HIT_RANGE = 15;
const SPREAD_RANGE = 10;
/** Running stops this far from the danger, into cowering if it's still going on. */
const SAFE_DIST = 45;
/** Seconds after the last alarm before cowering people get up, and running people slow down. */
const COWER_TIME = 10;
const CALM_TIME = 12;
/** Turn rate (rad/s). */
const TURN = 7;
/** Probed edges that couldn't be walked are asked about again after this long (a car may have moved). */
const RETRY_BLOCKED = 30;

type CivState = 'walk' | 'wait' | 'panic' | 'cower';

export interface Civilian {
  actor: Actor;
  /** Corner (lattice) walked from and to. */
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  edge: Edge;
  state: CivState;
  /** End of a wait. */
  until: number;
  walkSpeed: number;
  runSpeed: number;
  threat: Vec3 | null;
  alarmedAt: number;
  /** Brain phase (4 Hz, spread over ticks). */
  phase: number;
}

/**
 * Ambient pedestrians: civilians who walk the sidewalk lattice (sidewalks.ts) around the players,
 * run from gunfire and explosions, cower once clear of it, and cost a player money if they get
 * killed. They're ordinary actors on Team.Civilian (so they can be shot, and co-op mirrors them
 * like anyone), but with no pmove or pathfinding: a kinematic walker steers them along the line.
 * Bots don't target them. Host only, like the bots.
 */
export class Pedestrians implements SimSystem {
  readonly civs: Civilian[] = [];
  /** Density multiplier (0 = none; the settings' "Pedestrians"). */
  density = 1;
  private edges = new Map<number, Edge | null>();
  private blockedAt = new Map<number, number>();
  private bodies: { civ: Civilian; at: number }[] = [];
  private tr = makeTrace();
  private spawns = 0;
  private loaded = (cx: number, cz: number) => this.sim.nav.hasChunk(cx, cz);

  constructor(
    private sim: Simulation,
    private streamer: WorldStreamer,
    /** Chunks with a fight going on (no one wanders in). */
    private hot: (key: number) => boolean = () => false,
  ) {}

  get aliveCount(): number {
    let n = 0;
    for (const c of this.civs) if (c.actor.alive) n++;
    return n;
  }

  update(sim: Simulation): void {
    if ((sim.tick & 31) === 7) this.manage();
    this.listen();
    const dt = sim.dt;
    for (const c of this.civs) {
      if (!c.actor.alive) continue;
      if ((sim.tick & 15) === c.phase) this.think(c);
      this.move(c, dt);
    }
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      if (sim.time - this.bodies[i].at > BODY_TIME) {
        this.remove(this.bodies[i].civ);
        this.bodies.splice(i, 1);
      }
    }
  }

  onHit(sim: Simulation, info: HitInfo, killed: boolean): void {
    const civ = this.civs.find((c) => c.actor === info.victim);
    if (!civ) {
      if (info.attacker !== info.victim) this.hitNear(info.pos);
      return;
    }
    const from = info.attacker !== info.victim ? info.attacker.move.pos : info.pos;
    this.alarm(civ, from, true);
    if (!killed) return;
    this.bodies.push({ civ, at: sim.time });
    const a = info.attacker;
    if (a !== info.victim && sim.isPlayer(a.id)) {
      sim.economy.add(a, -CIV_FINE, 'civilian killed');
      sim.events.push({ type: 'message', actorId: a.id, text: `Civilian killed  −$${CIV_FINE}` });
    }
  }

  /** Remove every pedestrian (turned off in the settings). */
  clear(): void {
    for (const c of [...this.civs]) this.remove(c);
    this.bodies = [];
  }

  // ---- Edges

  /** The probed edge from corner (ix, iz) towards +axis (cached), or null if it can't be walked. */
  edge(ix: number, iz: number, axis: AxisId): Edge | null {
    const key = edgeKey(ix, iz, axis);
    const cached = this.edges.get(key);
    if (cached) return cached;
    if (cached === null) {
      if (this.sim.time - (this.blockedAt.get(key) ?? 0) < RETRY_BLOCKED) return null;
    }
    const e = probeEdge(this.sim.world, this.loaded, ix, iz, axis);
    if (e === undefined) return null;
    if (this.edges.size > 4000) {
      this.edges.clear();
      this.blockedAt.clear();
    }
    this.edges.set(key, e);
    if (!e) this.blockedAt.set(key, this.sim.time);
    return e;
  }

  /** The edge between two neighbouring corners (either way round). */
  private edgeBetween(ax: number, az: number, bx: number, bz: number): Edge | null {
    if (az === bz) return this.edge(Math.min(ax, bx), az, Axis.X);
    return this.edge(ax, Math.min(az, bz), Axis.Z);
  }

  private edgeHot(e: Edge): boolean {
    const [ax, az, bx, bz] = edgeChunks(e.ix, e.iz, e.axis);
    return this.chunkHot(ax, az) || this.chunkHot(bx, bz);
  }

  /** A fight's going on there, or the opening's execution scene is still waiting for the players. */
  private chunkHot(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    if (this.hot(key)) return true;
    const d = this.streamer.getChunk(cx, cz);
    return !!d?.opening && !this.sim.cleared.has(key);
  }

  // ---- Spawning

  /** How many pedestrians the players' surroundings call for right now. */
  target(): number {
    const sim = this.sim;
    if (this.density <= 0 || sim.params.world !== 'city') return 0;
    const counted = new Set<number>();
    let sum = 0;
    for (const p of sim.players) {
      if (!p.alive) continue;
      const pcx = worldToChunk(p.move.pos.x);
      const pcz = worldToChunk(p.move.pos.z);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const d = this.streamer.getChunk(pcx + dx, pcz + dz);
          if (!d || counted.has(d.key)) continue;
          counted.add(d.key);
          sum += chunkDensity(d);
        }
      }
    }
    const env = sim.env;
    const mood = (1 - 0.65 * env.darkness) * (1 - 0.5 * env.rain);
    return Math.min(MAX_CIVS, Math.floor(sum * mood * this.density));
  }

  /** Spawns, despawns (2 Hz). */
  private manage(): void {
    const sim = this.sim;
    const alive = sim.players.filter((p) => p.alive);
    for (const c of [...this.civs]) {
      if (!c.actor.alive) continue;
      const pos = c.actor.move.pos;
      const gone = !this.loaded(worldToChunk(pos.x), worldToChunk(pos.z));
      const near = nearestDist(alive.length ? alive : sim.players, pos);
      if (gone || near > HARD_DESPAWN || (near > DESPAWN_DIST && !this.seen(pos, alive))) this.remove(c);
    }
    if (!alive.length) return;
    // Catch up quicker when far short (arriving somewhere new).
    const short = this.target() - this.aliveCount;
    for (let i = 0; i < Math.min(short, 3); i++) if (!this.spawnOne(alive)) break;
  }

  private spawnOne(players: Actor[]): boolean {
    const sim = this.sim;
    const r = sfc32(hash3(sim.params.seed, sim.tick, this.spawns, Salt.Civilian));
    for (let attempt = 0; attempt < 8; attempt++) {
      const p = players[Math.floor(r() * players.length)];
      const cx = worldToChunk(p.move.pos.x) + Math.floor(r() * 5) - 2;
      const cz = worldToChunk(p.move.pos.z) + Math.floor(r() * 5) - 2;
      const d = this.streamer.getChunk(cx, cz);
      if (!d || chunkDensity(d) <= 0) continue;
      // Either of the chunk's low corners, along either axis: its four sidewalks and (half the time) a crossing.
      const ix = 2 * cx + (r() < 0.5 ? 0 : 1);
      const iz = 2 * cz + (r() < 0.5 ? 0 : 1);
      const axis: AxisId = r() < 0.5 ? Axis.X : Axis.Z;
      const e = this.edge(ix, iz, axis);
      if (!e || this.edgeHot(e)) continue;
      const t = 1 + r() * (e.len - 2);
      const ax = cornerCoord(ix);
      const az = cornerCoord(iz);
      const x = axis === Axis.X ? ax + t : ax;
      const z = axis === Axis.Z ? az + t : az;
      const pos = vec3(x, heightAt(e, t), z);
      const near = nearestDist(players, pos);
      if (near < MIN_SPAWN_DIST || near > MAX_SPAWN_DIST || this.seen(pos, players)) continue;
      const forward = r() < 0.5;
      const [bx, bz] = axis === Axis.X ? [ix + 1, iz] : [ix, iz + 1];
      this.spawn(pos, forward ? ix : bx, forward ? iz : bz, forward ? bx : ix, forward ? bz : iz, e, r);
      return true;
    }
    return false;
  }

  /** Put a pedestrian on an edge, walking from corner (fx, fz) to (tx, tz). */
  spawn(pos: Vec3, fx: number, fz: number, tx: number, tz: number, edge: Edge, r: Rand): Civilian {
    const sim = this.sim;
    const a = makeActor(sim.newActorId(), 'Civilian', Team.Civilian, pos.x, pos.y, pos.z);
    a.inv = makeInventory(null);
    a.move.onGround = true;
    const dx = cornerCoord(tx) - cornerCoord(fx);
    const dz = cornerCoord(tz) - cornerCoord(fz);
    a.yaw = a.prevYaw = Math.atan2(-dx, -dz);
    teleport(a, pos.x, pos.y, pos.z);
    sim.addActor(a);
    this.spawns++;
    const civ: Civilian = {
      actor: a,
      fx,
      fz,
      tx,
      tz,
      edge,
      state: 'walk',
      until: 0,
      walkSpeed: WALK_SPEED[0] + r() * (WALK_SPEED[1] - WALK_SPEED[0]),
      runSpeed: RUN_SPEED[0] + r() * (RUN_SPEED[1] - RUN_SPEED[0]),
      threat: null,
      alarmedAt: -100,
      phase: a.id & 15,
    };
    this.civs.push(civ);
    return civ;
  }

  private remove(c: Civilian): void {
    this.sim.removeActor(c.actor);
    const i = this.civs.indexOf(c);
    if (i >= 0) this.civs.splice(i, 1);
  }

  /** Can any of these players see this spot? */
  private seen(pos: Vec3, players: readonly Actor[]): boolean {
    const to = vec3(pos.x, pos.y + 1.2, pos.z);
    for (const p of players) {
      const from = vec3(p.move.pos.x, p.move.pos.y + 1.6, p.move.pos.z);
      if (Math.hypot(to.x - from.x, to.z - from.z) > HARD_DESPAWN) continue;
      this.sim.world.traceRay(this.tr, from, to, MASK_SHOT);
      if (this.tr.fraction >= 0.999) return true;
    }
    return false;
  }

  // ---- Fear

  /** Gunfire and explosions this tick set people running. */
  private listen(): void {
    const sim = this.sim;
    if (!this.civs.length) return;
    for (const s of sim.events.tickSounds) {
      if (s.kind !== 'gunshot' && s.kind !== 'grenade') continue;
      const radius = hearingRadius(s.kind, s.radius, sim.env.rain) * 0.8;
      for (const c of this.civs) {
        if (!c.actor.alive) continue;
        const p = c.actor.move.pos;
        if (Math.hypot(p.x - s.pos.x, p.z - s.pos.z) < radius) this.alarm(c, s.pos, true);
      }
    }
  }

  /** Something frightening happened at `at`: run from it. `spread` passes it on to people nearby. */
  alarm(c: Civilian, at: Vec3, spread: boolean): void {
    const sim = this.sim;
    const fresh = c.state === 'walk' || c.state === 'wait';
    c.threat = vec3(at.x, at.y, at.z);
    c.alarmedAt = sim.time;
    if (!fresh) return;
    c.state = 'panic';
    // Heading towards it: turn round.
    const pos = c.actor.move.pos;
    const bx = cornerCoord(c.tx);
    const bz = cornerCoord(c.tz);
    if ((bx - pos.x) * (at.x - pos.x) + (bz - pos.z) * (at.z - pos.z) > 0) this.reverse(c);
    if (!spread) return;
    for (const o of this.civs) {
      if (o === c || !o.actor.alive || (o.state !== 'walk' && o.state !== 'wait')) continue;
      const q = o.actor.move.pos;
      if (Math.hypot(q.x - pos.x, q.z - pos.z) < SPREAD_RANGE) this.alarm(o, at, false);
    }
  }

  /** Hits near someone frighten them too (bullets whizzing past are loud). */
  hitNear(at: Vec3): void {
    for (const c of this.civs) {
      if (!c.actor.alive) continue;
      const p = c.actor.move.pos;
      if (Math.hypot(p.x - at.x, p.z - at.z) < ALARM_HIT_RANGE) this.alarm(c, at, false);
    }
  }

  // ---- Walking

  private reverse(c: Civilian): void {
    [c.fx, c.fz, c.tx, c.tz] = [c.tx, c.tz, c.fx, c.fz];
  }

  /** Brain (4 Hz): state changes and a look ahead for things in the way. */
  private think(c: Civilian): void {
    const sim = this.sim;
    const a = c.actor;
    const since = sim.time - c.alarmedAt;
    switch (c.state) {
      case 'wait':
        if (sim.time >= c.until) c.state = 'walk';
        return;
      case 'cower':
        if (since > COWER_TIME) {
          c.state = 'walk';
          c.threat = null;
        }
        return;
      case 'panic': {
        const t = c.threat;
        const far = !t || Math.hypot(a.move.pos.x - t.x, a.move.pos.z - t.z) > SAFE_DIST;
        if (since > CALM_TIME) {
          c.state = 'walk';
          c.threat = null;
        } else if (far && since < COWER_TIME / 2) {
          c.state = 'cower';
        }
        break;
      }
      default:
        break;
    }
    // Something in the way (a car left on the sidewalk): turn back.
    const pos = a.move.pos;
    const [dx, dz] = this.dir(c);
    if (!clearPath(sim.world, pos.x, pos.z, pos.x + dx * 1.2, pos.z + dz * 1.2)) this.reverse(c);
  }

  /** Unit direction from the from-corner to the to-corner. */
  private dir(c: Civilian): [number, number] {
    return [Math.sign(c.tx - c.fx), Math.sign(c.tz - c.fz)];
  }

  private move(c: Civilian, dt: number): void {
    const a = c.actor;
    const m = a.move;
    const cower = c.state === 'cower';
    m.ducked = cower;
    m.duckAmount = Math.max(0, Math.min(1, m.duckAmount + (cower ? dt : -dt) * 5));
    m.onGround = true;
    if (c.state === 'wait' || cower) {
      m.vel.x = m.vel.z = m.vel.y = 0;
      return;
    }
    const ax = cornerCoord(c.fx);
    const az = cornerCoord(c.fz);
    const [dx, dz] = this.dir(c);
    const len = c.edge.len;
    // Distance along the edge from the from-corner, and the steering point ahead on my lane.
    const t = Math.max(0, Math.min(len, (m.pos.x - ax) * dx + (m.pos.z - az) * dz));
    const look = Math.min(len, t + LOOK_AHEAD);
    const gx = ax + dx * look - dz * LANE;
    const gz = az + dz * look + dx * LANE;
    const speed = c.state === 'panic' ? c.runSpeed : c.walkSpeed;
    const vx = gx - m.pos.x;
    const vz = gz - m.pos.z;
    const d = Math.hypot(vx, vz);
    const step = Math.min(d, speed * dt);
    const ox = m.pos.x;
    const oz = m.pos.z;
    if (d > 1e-4) {
      m.pos.x += (vx / d) * step;
      m.pos.z += (vz / d) * step;
    }
    const along = (m.pos.x - ax) * dx + (m.pos.z - az) * dz;
    // Heights run from the edge's low end.
    const low = dx + dz > 0 ? along : len - along;
    m.pos.y = heightAt(c.edge, low);
    m.vel.x = (m.pos.x - ox) / dt;
    m.vel.z = (m.pos.z - oz) / dt;
    m.vel.y = 0;
    this.face(a, m.vel.x, m.vel.z, dt);
    if (c.state === 'panic') this.sim.footsteps(a);
    if (along >= len - 0.3) this.arrive(c);
  }

  private face(a: Actor, vx: number, vz: number, dt: number): void {
    if (vx * vx + vz * vz < 0.01) return;
    const want = Math.atan2(-vx, -vz);
    let diff = want - a.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const max = TURN * dt;
    a.yaw += Math.max(-max, Math.min(max, diff));
    a.pitch = 0;
  }

  /** At a corner: pick the next edge (away from danger when running). */
  private arrive(c: Civilian): void {
    const sim = this.sim;
    const r = sfc32(hash3(sim.params.seed, c.actor.id, sim.tick, Salt.Civilian));
    const x = c.tx;
    const z = c.tz;
    const [dx, dz] = this.dir(c);
    const options: { x: number; z: number; e: Edge; w: number }[] = [];
    for (const [ox, oz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + ox;
      const nz = z + oz;
      const e = this.edgeBetween(x, z, nx, nz);
      if (!e) continue;
      const back = ox === -dx && oz === -dz;
      let w: number;
      if (c.state === 'panic' && c.threat) {
        // Whichever corner is furthest from the danger.
        w = Math.hypot(cornerCoord(nx) - c.threat.x, cornerCoord(nz) - c.threat.z);
      } else {
        w = back ? 0.05 : ox === dx && oz === dz ? 2 : 1;
        if (this.edgeHot(e)) w *= 0.05;
      }
      options.push({ x: nx, z: nz, e, w });
    }
    if (!options.length) {
      // Nowhere to go: stand here until the despawn takes me.
      c.state = 'wait';
      c.until = Infinity;
      return;
    }
    let pick = options[0];
    if (c.state === 'panic' && c.threat) {
      for (const o of options) if (o.w > pick.w) pick = o;
    } else {
      let total = 0;
      for (const o of options) total += o.w;
      let roll = r() * total;
      for (const o of options) {
        roll -= o.w;
        if (roll <= 0) {
          pick = o;
          break;
        }
      }
      if (r() < WAIT_CHANCE) {
        c.state = 'wait';
        c.until = sim.time + WAIT_TIME[0] + r() * (WAIT_TIME[1] - WAIT_TIME[0]);
      }
    }
    c.fx = x;
    c.fz = z;
    c.tx = pick.x;
    c.tz = pick.z;
    c.edge = pick.e;
  }
}

/** Pedestrians a chunk adds around the players. */
export function chunkDensity(d: ChunkData): number {
  const base = DISTRICT_DENSITY[d.district] ?? 0;
  if (base <= 0 || d.district === District.Gym) return 0;
  return base + (d.landmark === Landmark.Plaza || d.landmark === Landmark.Park ? OPEN_SPACE_BONUS : 0);
}

function nearestDist(players: readonly Actor[], pos: Vec3): number {
  let best = Infinity;
  for (const p of players) best = Math.min(best, Math.hypot(p.move.pos.x - pos.x, p.move.pos.z - pos.z));
  return best;
}
