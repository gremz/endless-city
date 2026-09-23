import { HitGroup } from '../ai/hitboxes';
import { EventQueue } from '../core/events';
import { vec3 } from '../core/math';
import type { GameParams } from '../core/urlParams';
import type { UserCmd } from '../input/UserCmd';
import { makeCmd } from '../input/UserCmd';
import { CollisionWorld } from '../physics/CollisionWorld';
import { MASK_PLAYER } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { STAND_MAXS, STAND_MINS } from '../player/movementConfig';
import { playerMove } from '../player/pmove';
import { makeInventory, makeWeaponState } from '../weapons/Inventory';
import { updateWeapon, type HitInfo, type WeaponContext } from '../weapons/WeaponSystem';
import { makeActor, storePrev, Team, teleport, type Actor } from './Actor';
import { applyDamage, bulletDamage } from './damage';

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
  readonly player: Actor;
  readonly actors: Actor[] = [];
  readonly systems: SimSystem[] = [];
  tick = 0;
  time = 0;
  private nextActorId = 1;
  private dummyGear = new Map<number, [number, boolean]>();

  constructor(
    readonly params: GameParams,
    public opts: SimOptions,
    readonly dt: number,
  ) {
    this.player = makeActor(this.nextActorId++, 'You', Team.Player, 0, 0, 0);
    this.actors.push(this.player);
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

  step(cmd: UserCmd): void {
    this.tick++;
    this.time += this.dt;
    for (const a of this.actors) storePrev(a);

    const p = this.player;
    if (p.alive) {
      p.yaw = cmd.yaw;
      p.pitch = cmd.pitch;
      const wasGround = p.move.onGround;
      playerMove(p.move, cmd, this.world, this.dt, { autoBhop: this.opts.autoBhop });
      if (p.move.jumped) this.events.push({ type: 'jump', actorId: p.id });
      if (p.move.landed && !wasGround) this.events.push({ type: 'land', actorId: p.id, speed: p.move.landSpeed });
      updateWeapon(p, cmd, this);
    }

    for (const s of this.systems) s.update(this);

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

  // ---- WeaponContext ----

  canHit(attacker: Actor, victim: Actor): boolean {
    return attacker.team !== victim.team;
  }

  onHit(info: HitInfo): void {
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
    const god = victim === this.player && this.params.god;
    const killed = applyDamage(victim, res, god);
    victim.lastAttacker = attacker.id;
    victim.lastDamagedAt = this.time;
    attacker.lastDealtAt = this.time;
    if (killed) victim.diedAt = this.time;
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

  /** Reset an actor's loadout to the default pistol + knife (death penalty). */
  resetLoadout(a: Actor): void {
    a.inv = makeInventory('glock');
    a.wpn = makeWeaponState();
    a.armor = 0;
    a.helmet = false;
  }
}
