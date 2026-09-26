import { HitGroup } from '../ai/hitboxes';
import { NavGrid } from '../ai/nav/NavGrid';
import { EventQueue } from '../core/events';
import { vec3 } from '../core/math';
import type { GameParams } from '../core/urlParams';
import type { UserCmd } from '../input/UserCmd';
import { Buttons, makeCmd } from '../input/UserCmd';
import { CollisionWorld } from '../physics/CollisionWorld';
import { MASK_PLAYER, type Brush } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { HU } from '../core/config';
import { MOVE, STAND_MAXS, STAND_MINS } from '../player/movementConfig';
import { hullMaxs, hullMins, playerMove } from '../player/pmove';
import { makeInventory, makeWeaponState } from '../weapons/Inventory';
import { updateWeapon, type HitInfo, type WeaponContext } from '../weapons/WeaponSystem';
import { FALL_HIT, type GrenadeId } from '../weapons/weaponDefs';
import { makeActor, storePrev, Team, teleport, type Actor } from './Actor';
import { applyDamage, bulletDamage } from './damage';
import { Economy, START_MONEY } from './Economy';
import { envAt, type Env, type EnvOverride } from './Environment';
import { DoorSystem } from './Doors';
import { GlassSystem } from './Glass';
import { GrenadeSystem } from './Grenades';
import { updateHeal } from './medkit';
import { damageVehicle, driveVehicle, exitVehicle, storeVehiclePrev, useVehicle, occupantIds, seatActor, seatOf, type Vehicle } from './vehicle/Vehicle';

export interface SimOptions {
  autoBhop: boolean;
}

/** Hook for systems that run inside the tick (bots, encounters, economy). */
export interface SimSystem {
  /** Called after the player moved and fired, before events are handed to presentation. */
  update(sim: Simulation): void;
  onHit?(sim: Simulation, info: HitInfo, killed: boolean): void;
}

const idleCmd = makeCmd();

/** Headless game simulation: owns collision, actors and game rules. Never touches the DOM or three.js. */
export class Simulation implements WeaponContext {
  readonly world = new CollisionWorld();
  readonly events = new EventQueue();
  readonly nav = new NavGrid();
  readonly economy = new Economy(this.events);
  /** Chunk keys the players have cleared (shared buy zones and respawn points). */
  readonly cleared = new Set<number>();
  /** Human players, in join order. */
  readonly players: Actor[] = [];
  readonly actors: Actor[] = [];
  readonly systems: SimSystem[] = [];
  readonly grenades = new GrenadeSystem(this);
  readonly doors = new DoorSystem(this);
  readonly glass = new GlassSystem(this);
  /** Driveable cars in the loaded world (Vehicles spawns them; online clients mirror them). */
  readonly vehicles: Vehicle[] = [];
  /** Time of day and weather, recomputed every tick from the clock. */
  readonly env: Env;
  /** Fixed time of day / weather (URL parameters, settings). */
  envOverride: EnvOverride = {};
  tick = 0;
  time = 0;
  /** Each player's command for the current tick (systems read edge-triggered buttons like USE). */
  private cmds = new Map<number, UserCmd>();
  /** Players whose E got them into or out of a car this tick (it doesn't also pick things up). */
  private vehicleUsers = new Set<number>();
  private nextActorId = 1;
  private dummyGear = new Map<number, [number, boolean]>();

  /**
   * Client-side prediction: weapons fire and move as usual, but hits do no damage and grenades
   * aren't launched (the host is authoritative for both).
   */
  predicting = false;
  /**
   * Online client: doors and glass change only when the host says so (they are still in the
   * collision world, for prediction).
   */
  replica = false;
  /**
   * Lag compensation (host): wraps the weapon update of a player's command, e.g. to rewind the
   * other actors to where that player saw them.
   */
  lagComp: ((p: Actor, cmd: UserCmd, fire: () => void) => void) | null = null;
  /** Players who turned auto-bhop on for themselves (online; `opts.autoBhop` covers solo). */
  readonly autoBhopIds = new Set<number>();

  constructor(
    readonly params: GameParams,
    public opts: SimOptions,
    readonly dt: number,
    /** Start with the solo player ('You'). A host adds its players as they join instead. */
    soloPlayer = true,
  ) {
    if (soloPlayer) this.addPlayer('You');
    this.envOverride = { hour: params.hour ?? undefined, weather: params.weather ?? undefined };
    this.env = envAt(params.seed, 0, this.envOverride);
  }

  /** Recompute the environment now (after the clock or overrides changed outside a tick). */
  updateEnv(): void {
    envAt(this.params.seed, this.time, this.envOverride, this.env);
  }

  /** The first player: the only one in solo play (tests and single-player code). */
  get player(): Actor {
    return this.players[0];
  }

  /** Add a human player with the starting loadout and money (placed by the caller). */
  addPlayer(name: string): Actor {
    const a = makeActor(this.newActorId(), name, Team.Player, 0, 0, 0);
    a.money = START_MONEY;
    this.players.push(a);
    this.actors.push(a);
    return a;
  }

  removePlayer(a: Actor): void {
    this.leaveVehicle(a);
    const i = this.players.indexOf(a);
    if (i >= 0) this.players.splice(i, 1);
    this.removeActor(a);
    this.cmds.delete(a.id);
    this.autoBhopIds.delete(a.id);
  }

  isPlayer(id: number): boolean {
    return this.players.some((p) => p.id === id);
  }

  /** The command an actor's player sent this tick (idle for bots and absent players). */
  cmdFor(a: Actor): UserCmd {
    return this.cmds.get(a.id) ?? idleCmd;
  }

  newActorId(): number {
    return this.nextActorId++;
  }

  addActor(a: Actor): void {
    this.actors.push(a);
  }

  removeActor(a: Actor): void {
    const i = this.actors.indexOf(a);
    if (i >= 0) this.actors.splice(i, 1);
  }

  getActor(id: number): Actor | undefined {
    return this.actors.find((a) => a.id === id);
  }

  getVehicle(id: number): Vehicle | undefined {
    return this.vehicles.find((v) => v.id === id);
  }

  addVehicle(v: Vehicle): void {
    this.vehicles.push(v);
  }

  /** Take a car out of the world (anyone in it is left standing where they sat). */
  removeVehicle(v: Vehicle): void {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.world.clearDynamic(v.id);
    for (const id of occupantIds(v)) {
      const a = this.getActor(id);
      if (a && a.vehicle === v.id) a.vehicle = -1;
    }
    v.driver = -1;
    v.passengers.fill(-1);
  }

  /** The car an actor is in (driving or riding). */
  vehicleOf(a: Actor): Vehicle | undefined {
    return a.vehicle >= 0 ? this.getVehicle(a.vehicle) : undefined;
  }

  /** Put an actor out of their car (beside it) if they're in one. */
  leaveVehicle(a: Actor): void {
    const v = this.vehicleOf(a);
    if (v) exitVehicle(this, a, v, true);
    a.vehicle = -1;
  }

  /** The player's E this tick went to a car (so it shouldn't also swap a gun). */
  usedVehicle(id: number): boolean {
    return this.vehicleUsers.has(id);
  }

  /** Height a standing hull comes to rest at when dropped at (x, z) from fromY. */
  findFloor(x: number, z: number, fromY: number): number {
    const tr = makeTrace();
    this.world.traceBox(tr, vec3(x, fromY, z), vec3(x, fromY - 60, z), STAND_MINS, STAND_MAXS, MASK_PLAYER);
    return tr.fraction < 1 ? tr.endY : 0.05;
  }

  /** Static respawning target for the shooting range. */
  spawnDummy(x: number, y: number, z: number, yaw: number, armor = 0, helmet = false): Actor {
    const a = makeActor(this.newActorId(), `Dummy ${this.actors.length}`, Team.Bots, x, y, z);
    a.dummy = true;
    a.yaw = a.prevYaw = yaw;
    a.armor = armor;
    a.helmet = helmet;
    a.inv = makeInventory(null);
    this.dummyGear.set(a.id, [armor, helmet]);
    this.actors.push(a);
    return a;
  }

  /**
   * Advance one tick. `cmds` maps player actor ids to their input; a single command drives the
   * first player (solo play).
   */
  step(cmds: UserCmd | ReadonlyMap<number, UserCmd>): void {
    this.cmds.clear();
    this.vehicleUsers.clear();
    if (isCmd(cmds)) {
      if (this.player) this.cmds.set(this.player.id, cmds);
    } else {
      for (const [id, c] of cmds) this.cmds.set(id, c);
    }
    this.tick++;
    this.time += this.dt;
    this.events.beginTick();
    this.updateEnv();
    for (const a of this.actors) storePrev(a);
    for (const v of this.vehicles) storeVehiclePrev(v);

    for (const p of this.players) {
      const cmd = this.cmds.get(p.id);
      if (cmd && p.alive) this.runCmd(p, cmd);
    }

    for (const s of this.systems) s.update(this);
    this.doors.update();
    this.grenades.update();
    this.separateActors();

    // Dummies: stand still, respawn a moment after dying.
    for (const a of this.actors) {
      if (!a.dummy) continue;
      if (!a.alive && this.time - a.diedAt > 2) {
        a.alive = true;
        a.health = 100;
        const gear = this.dummyGear.get(a.id) ?? [0, false];
        a.armor = gear[0];
        a.helmet = gear[1];
        teleport(a, a.spawnPos.x, a.spawnPos.y, a.spawnPos.z);
        this.events.push({ type: 'respawn', actorId: a.id });
      } else if (a.alive) {
        playerMove(a.move, idleCmd, this.world, this.dt);
      }
    }
  }

  /**
   * Run one command for a player: look, move, medkit, weapon, footsteps. The host also calls
   * it for a player's backlogged commands, and a client for its own predicted ones (`heal` off:
   * medkits are the host's business).
   */
  runCmd(p: Actor, cmd: UserCmd, heal = true): void {
    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    if (cmd.pressed & Buttons.USE) {
      const was = p.vehicle;
      useVehicle(this, p);
      // E opens a door when it didn't get into or out of a car (and then picks nothing up).
      if (p.vehicle !== was || (p.vehicle < 0 && this.doors.use(p))) this.vehicleUsers.add(p.id);
    }
    const car = this.vehicleOf(p);
    if (car) {
      // Driving: the car moves, the driver rides along with their guns put away. Passengers just ride.
      const seat = seatOf(car, p.id);
      if (seat === 0) driveVehicle(this, p, car, cmd);
      else if (seat > 0) seatActor(p, car, seat);
      if (seat >= 0) return;
    }
    p.vehicle = -1;
    const wasGround = p.move.onGround;
    playerMove(p.move, cmd, this.world, this.dt, { autoBhop: this.opts.autoBhop || this.autoBhopIds.has(p.id) });
    if (p.move.jumped) this.events.push({ type: 'jump', actorId: p.id });
    if (p.move.landed && !wasGround) this.events.push({ type: 'land', actorId: p.id, speed: p.move.landSpeed });
    this.fallDamage(p);
    if (cmd.pressed & Buttons.FLASHLIGHT) {
      p.flashlight = !p.flashlight;
      this.events.push({ type: 'flashlight', actorId: p.id, on: p.flashlight });
    }
    if (heal) updateHeal(p, cmd, this);
    if (this.lagComp) this.lagComp(p, cmd, () => updateWeapon(p, cmd, this));
    else updateWeapon(p, cmd, this);
    this.footsteps(p);
  }

  /**
   * CS fall damage for an actor that landed this tick: none up to 580 HU/s (about a 5 m drop),
   * rising linearly to fatal at 1024 HU/s (about 17 m).
   */
  fallDamage(a: Actor): void {
    const m = a.move;
    if (!m.landed || m.landSpeed <= MOVE.safeFallSpeed || !a.alive) return;
    const dmg = ((m.landSpeed - MOVE.safeFallSpeed) * 100) / (MOVE.fatalFallSpeed - MOVE.safeFallSpeed);
    this.onHit({
      attacker: a,
      victim: a,
      def: { ...FALL_HIT, damage: dmg },
      group: HitGroup.Chest,
      distance: 0,
      damageScale: 1,
      penetrated: false,
      pos: vec3(m.pos.x, m.pos.y + 0.2, m.pos.z),
    });
  }

  /**
   * Footsteps: running (above 150 HU/s) on the ground makes noise every ~1.3 m; walking and
   * crouching are silent, as in CS.
   */
  footsteps(a: Actor): void {
    const m = a.move;
    if (m.onLadder && !m.onGround) {
      // Rungs clank every 0.6 m climbed; ladders are loud.
      a.stepAccum += Math.abs(m.vel.y) * this.dt;
      if (a.stepAccum < 0.6) return;
      a.stepAccum = 0;
      const pos = vec3(m.pos.x, m.pos.y, m.pos.z);
      this.events.push({ type: 'step', actorId: a.id, pos, material: 6 });
      this.events.push({ type: 'sound', pos, radius: 18, kind: 'footstep', sourceId: a.id });
      return;
    }
    if (!m.onGround || m.noclip) return;
    const speed = Math.hypot(m.vel.x, m.vel.z);
    if (speed < 150 * HU) {
      a.stepAccum = Math.min(a.stepAccum, 0.6);
      return;
    }
    a.stepAccum += speed * this.dt;
    if (a.stepAccum < 1.3) return;
    a.stepAccum = 0;
    const pos = vec3(m.pos.x, m.pos.y, m.pos.z);
    this.events.push({ type: 'step', actorId: a.id, pos, material: 0 });
    this.events.push({ type: 'sound', pos, radius: 18, kind: 'footstep', sourceId: a.id });
  }

  /** Push overlapping actors apart (traced, so nobody gets shoved into a wall). */
  private separateActors(): void {
    const list = this.actors;
    const minD = 0.75;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive || a.move.noclip || a.vehicle >= 0) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive || b.move.noclip || b.vehicle >= 0) continue;
        const dx = b.move.pos.x - a.move.pos.x;
        const dz = b.move.pos.z - a.move.pos.z;
        const dy = Math.abs(b.move.pos.y - a.move.pos.y);
        const d = Math.hypot(dx, dz);
        if (d >= minD || dy > 1.6) continue;
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        const push = (minD - d) * 0.5;
        this.nudge(a, -nx * push, -nz * push);
        this.nudge(b, nx * push, nz * push);
      }
    }
  }

  private sepTrace = makeTrace();
  private nudge(a: Actor, dx: number, dz: number): void {
    if (a.dummy) return;
    const m = a.move;
    const end = vec3(m.pos.x + dx, m.pos.y, m.pos.z + dz);
    this.world.traceBox(this.sepTrace, m.pos, end, hullMins(m), hullMaxs(m), MASK_PLAYER);
    m.pos.x = this.sepTrace.endX;
    m.pos.z = this.sepTrace.endZ;
  }

  // ---- WeaponContext ----

  canHit(attacker: Actor, victim: Actor): boolean {
    if (victim.captive) return attacker.id === victim.executioner;
    return attacker.team !== victim.team;
  }

  throwGrenade(a: Actor, id: GrenadeId, strength: number, yaw: number, pitch: number): void {
    if (this.predicting) return;
    this.grenades.throw(a, id, strength, yaw, pitch);
  }

  onVehicleHit(attacker: Actor, vehicleId: number, damage: number): void {
    const v = this.getVehicle(vehicleId);
    if (v) damageVehicle(this, v, damage, attacker.id);
  }

  onDoorHit(_attacker: Actor, owner: number, damage: number): void {
    this.doors.damage(owner, damage);
  }

  onGlassHit(pane: Brush): void {
    this.glass.hit(pane);
  }

  onHit(info: HitInfo): void {
    if (this.predicting) return;
    const { attacker, victim, def } = info;
    const res = bulletDamage(
      def.damage * info.damageScale,
      def.rangeMod,
      info.distance,
      info.group,
      def.armorPen,
      victim.armor,
      victim.helmet,
    );
    const god = victim.team === Team.Player && this.params.god;
    const killed = applyDamage(victim, res, god);
    victim.lastAttacker = attacker.id;
    victim.lastDamagedAt = this.time;
    attacker.lastDealtAt = this.time;
    if (killed) {
      victim.diedAt = this.time;
      // The body falls out of the car.
      this.leaveVehicle(victim);
    }
    this.events.push({
      type: 'hit',
      attackerId: attacker.id,
      victimId: victim.id,
      damage: res.health,
      group: info.group,
      pos: vec3(info.pos.x, info.pos.y, info.pos.z),
      helmetHit: res.helmetHit,
      killed,
    });
    if (killed) {
      this.events.push({
        type: 'kill',
        attackerId: attacker.id,
        victimId: victim.id,
        weapon: def.id,
        headshot: info.group === HitGroup.Head,
        penetrated: info.penetrated,
      });
    }
    for (const s of this.systems) s.onHit?.(this, info, killed);
  }

  /** Bring a player back: full health, default loadout (bought gear is lost), money kept. */
  respawnPlayer(p: Actor, x: number, z: number): void {
    this.leaveVehicle(p);
    p.alive = true;
    p.health = 100;
    p.diedAt = -1;
    this.resetLoadout(p);
    p.move.ducked = false;
    p.move.duckAmount = 0;
    teleport(p, x, this.findFloor(x, z, 30), z);
    this.events.push({ type: 'respawn', actorId: p.id });
  }

  /** Reset an actor's loadout to the default pistol + knife (death penalty). */
  resetLoadout(a: Actor): void {
    a.inv = makeInventory('glock');
    a.wpn = makeWeaponState();
    a.armor = 0;
    a.helmet = false;
    a.medkits = 0;
    a.healEnd = -1;
    a.flashUntil = -10;
    a.flashlight = false;
  }
}

function isCmd(c: UserCmd | ReadonlyMap<number, UserCmd>): c is UserCmd {
  return typeof (c as UserCmd).buttons === 'number';
}
