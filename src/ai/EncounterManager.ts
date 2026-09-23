import { CHUNK } from '../core/config';
import { vec3, type Vec3 } from '../core/math';
import { hash3, Salt, sfc32 } from '../core/rng';
import { MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { eyeHeight } from '../player/pmove';
import { makeActor, Team, teleport } from '../sim/Actor';
import type { Simulation, SimSystem } from '../sim/Simulation';
import { makeInventory } from '../weapons/Inventory';
import type { HitInfo } from '../weapons/WeaponSystem';
import { chunkDist, chunkKey, worldToChunk } from '../world/chunkMath';
import type { ChunkData } from '../world/gen/ChunkData';
import type { WorldStreamer } from '../world/WorldStreamer';
import { Bot, TargetHistory, type BotContext, type BotRole, type Squad } from './Bot';
import { BOT_NAMES, skillFor, weaponFor } from './difficulty';
import { AStar } from './nav/astar';

const ACTIVATE_DIST = 90;
const MIN_SPAWN_DIST = 25;
const MAX_BOTS = 16;
const DESPAWN_UNSEEN = 10;
const BODY_TIME = 12;

interface EncounterState {
  key: number;
  cx: number;
  cz: number;
  level: number;
  cleared: boolean;
  /** Bots still to spawn (fresh = full squad; after a despawn = survivors). */
  remaining: number;
  squad: Squad | null;
  spawnedOnce: boolean;
}

/** Spawns squads in encounter chunks as the player approaches, runs the bots, pays for clears. */
export class EncounterManager implements SimSystem {
  readonly states = new Map<number, EncounterState>();
  readonly bots: Bot[] = [];
  private astar: AStar;
  private history = new TargetHistory();
  private ctx: BotContext;
  private tr = makeTrace();
  private squadIds = 1;
  private deadBodies: { bot: Bot; at: number }[] = [];
  enabled = true;

  constructor(
    private sim: Simulation,
    private streamer: WorldStreamer,
  ) {
    this.astar = new AStar(sim.nav);
    this.ctx = { sim, astar: this.astar, history: this.history, pathBudget: 2 };
  }

  get aliveCount(): number {
    return this.bots.filter((b) => b.actor.alive).length;
  }

  get pathQueries(): number {
    return this.astar.queries;
  }

  private levelOf(d: ChunkData): number {
    return this.sim.params.level >= 0 ? this.sim.params.level : d.level;
  }

  private stateFor(d: ChunkData): EncounterState {
    let s = this.states.get(d.key);
    if (!s) {
      const skill = skillFor(this.levelOf(d));
      s = {
        key: d.key,
        cx: d.cx,
        cz: d.cz,
        level: this.levelOf(d),
        cleared: false,
        remaining: skill.squadSize + (skill.overwatch && d.perches.length ? 1 : 0),
        squad: null,
        spawnedOnce: false,
      };
      this.states.set(d.key, s);
    }
    return s;
  }

  update(sim: Simulation): void {
    const p = sim.player;
    this.history.record(p, sim.tick);
    this.ctx.pathBudget = 2;
    if (this.enabled && (sim.tick & 15) === 0) this.manage();
    for (const b of this.bots) b.update(this.ctx);
    // Hearing: this tick's sounds made by the player.
    const sounds = sim.events.tickSounds;
    if (sounds.length) {
      for (const s of sounds) {
        if (s.sourceId !== p.id) continue;
        for (const b of this.bots) {
          if (!b.actor.alive) continue;
          b.hear(s.pos, this.losTo(b, s.pos) ? s.radius : s.radius * 0.6, sim.time);
        }
      }
    }
    // Remove bodies after a while.
    for (let i = this.deadBodies.length - 1; i >= 0; i--) {
      if (sim.time - this.deadBodies[i].at > BODY_TIME) {
        this.removeBot(this.deadBodies[i].bot);
        this.deadBodies.splice(i, 1);
      }
    }
  }

  private losTo(b: Bot, pos: Vec3): boolean {
    const a = b.actor.move.pos;
    const from = vec3(a.x, a.y + 1.5, a.z);
    const to = vec3(pos.x, pos.y + 1.0, pos.z);
    this.sim.world.traceRay(this.tr, from, to, MASK_SHOT);
    return this.tr.fraction >= 0.999;
  }

  /** Activation, despawn and clear checks (4 Hz). */
  private manage(): void {
    const sim = this.sim;
    const p = sim.player.move.pos;
    const pcx = worldToChunk(p.x);
    const pcz = worldToChunk(p.z);
    for (const [key, r] of this.streamer.resident) {
      const d = r.data;
      if (!d.hasEncounter || this.sim.params.noBots) continue;
      const st = this.stateFor(d);
      if (st.cleared || st.squad || st.remaining <= 0) continue;
      const cxw = (d.cx + 0.5) * CHUNK;
      const czw = (d.cz + 0.5) * CHUNK;
      if (Math.hypot(cxw - p.x, czw - p.z) > ACTIVATE_DIST || !sim.player.alive) continue;
      if (this.aliveCount >= MAX_BOTS) break;
      this.spawnSquad(st, d, key);
    }
    // Despawn squads the player has left far behind.
    for (const st of this.states.values()) {
      const sq = st.squad;
      if (!sq) continue;
      const far = chunkDist(st.cx, st.cz, pcx, pcz) > 2;
      const unseen = sim.time - sq.lastSeen > DESPAWN_UNSEEN;
      const unloaded = !this.streamer.resident.has(st.key);
      if ((far && unseen) || unloaded) this.despawnSquad(st);
    }
  }

  private spawnSquad(st: EncounterState, d: ChunkData, key: number): void {
    const sim = this.sim;
    const skill = skillFor(st.level);
    const r = sfc32(hash3(sim.params.seed, d.cx, d.cz, Salt.Names) ^ (st.spawnedOnce ? 0x55 : 0));
    const p = sim.player;
    const eye = vec3(p.move.pos.x, p.move.pos.y + eyeHeight(p.move), p.move.pos.z);
    // Slots out of the player's sight and not too close.
    const slots: Vec3[] = [];
    for (let i = 0; i < d.spawns.length; i += 3) {
      const s = vec3(d.spawns[i], d.spawns[i + 1], d.spawns[i + 2]);
      if (Math.hypot(s.x - eye.x, s.z - eye.z) < MIN_SPAWN_DIST) continue;
      this.sim.world.traceRay(this.tr, eye, vec3(s.x, s.y + 1.6, s.z), MASK_SHOT);
      if (this.tr.fraction >= 0.999) continue;
      slots.push(s);
    }
    const perches: Vec3[] = [];
    for (let i = 0; i < d.perches.length; i += 3) {
      const s = vec3(d.perches[i], d.perches[i + 1], d.perches[i + 2]);
      if (Math.hypot(s.x - eye.x, s.z - eye.z) < MIN_SPAWN_DIST) continue;
      this.sim.world.traceRay(this.tr, eye, vec3(s.x, s.y + 1.6, s.z), MASK_SHOT);
      if (this.tr.fraction >= 0.999) continue;
      perches.push(s);
    }
    const wantOverwatch = skill.overwatch && perches.length > 0 && st.remaining > 1;
    const riflemen = Math.min(st.remaining - (wantOverwatch ? 1 : 0), slots.length, MAX_BOTS - this.aliveCount);
    if (riflemen <= 0) return; // try again next time (player may be looking at every slot)

    const squad: Squad = {
      id: this.squadIds++,
      chunkKey: key,
      homeCx: d.cx,
      homeCz: d.cz,
      members: [],
      lastKnown: null,
      lastKnownTime: -100,
      calloutAt: Infinity,
      lastSeen: sim.time,
    };
    const patrol: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < d.patrol.length; i += 3) patrol.push({ x: d.patrol[i], y: d.patrol[i + 1], z: d.patrol[i + 2] });

    const make = (pos: Vec3, role: BotRole) => {
      const name = BOT_NAMES[Math.floor(r() * BOT_NAMES.length)];
      const a = makeActor(sim.newActorId(), name, Team.Bots, pos.x, pos.y, pos.z);
      a.yaw = a.prevYaw = r() * Math.PI * 2 - Math.PI;
      const wid = weaponFor(st.level, r(), role === 'overwatch');
      const isSecondary = wid === 'glock' || wid === 'deagle';
      a.inv = makeInventory(isSecondary ? wid : 'glock', isSecondary ? null : wid);
      a.armor = skill.armor;
      a.helmet = skill.helmet;
      teleport(a, pos.x, pos.y, pos.z);
      sim.addActor(a);
      const bot = new Bot(a, skill, squad, role, pos, patrol, sim.params.seed);
      squad.members.push(bot);
      this.bots.push(bot);
    };
    for (let i = 0; i < riflemen; i++) {
      const role: BotRole = i === 0 && skill.canFlank && riflemen >= 3 ? 'flanker' : i % 2 === 1 ? 'patroller' : 'anchor';
      make(slots[i], role);
    }
    if (wantOverwatch) make(perches[Math.floor(r() * perches.length)], 'overwatch');
    st.remaining -= squad.members.length;
    st.squad = squad;
    st.spawnedOnce = true;
  }

  private despawnSquad(st: EncounterState): void {
    const sq = st.squad;
    if (!sq) return;
    let survivors = 0;
    for (const b of sq.members) {
      if (b.actor.alive) survivors++;
      this.removeBot(b);
    }
    this.deadBodies = this.deadBodies.filter((d) => d.bot.squad !== sq);
    st.remaining += survivors;
    st.squad = null;
  }

  private removeBot(b: Bot): void {
    this.sim.removeActor(b.actor);
    const i = this.bots.indexOf(b);
    if (i >= 0) this.bots.splice(i, 1);
  }

  onHit(sim: Simulation, info: HitInfo, killed: boolean): void {
    const victimBot = this.bots.find((b) => b.actor === info.victim);
    if (victimBot) {
      victimBot.onDamaged(info.attacker.move.pos, sim.time);
      // The rest of the squad hears about it quickly.
      for (const m of victimBot.squad.members) {
        if (m !== victimBot && m.actor.alive) m.awareness = Math.max(m.awareness, 0.5);
      }
      if (killed) {
        this.deadBodies.push({ bot: victimBot, at: sim.time });
        if (info.attacker === sim.player) sim.economy.add(info.def.killReward, 'kill');
        this.checkCleared(victimBot.squad);
      }
    }
    if (info.victim === sim.player && killed) this.onPlayerDeath();
  }

  private checkCleared(sq: Squad): void {
    if (sq.members.some((m) => m.actor.alive)) return;
    const st = this.states.get(sq.chunkKey);
    if (!st || st.remaining > 0) {
      // More bots still to come (e.g. spawn was capped): let the next manage() tick bring them in.
      if (st) st.squad = null;
      return;
    }
    st.cleared = true;
    st.squad = null;
    this.sim.cleared.add(st.key);
    const bonus = 500 + 200 * st.level;
    this.sim.economy.add(bonus, 'clear');
    this.sim.events.push({ type: 'chunkCleared', chunkKey: st.key, bonus, level: st.level });
  }

  /** Squads heal and forget when the player dies. */
  private onPlayerDeath(): void {
    for (const b of this.bots) {
      if (!b.actor.alive) continue;
      b.actor.health = 100;
      b.reset(this.sim.time);
      b.squad.lastKnown = null;
      b.squad.calloutAt = Infinity;
    }
  }

  /** Uncleared encounter chunks near a position (for the compass). */
  nearbyEncounters(x: number, z: number, radius = 2): { cx: number; cz: number; level: number; active: boolean }[] {
    const out: { cx: number; cz: number; level: number; active: boolean }[] = [];
    const pcx = worldToChunk(x);
    const pcz = worldToChunk(z);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = this.streamer.getChunk(pcx + dx, pcz + dz);
        if (!d || !d.hasEncounter) continue;
        const st = this.states.get(chunkKey(d.cx, d.cz));
        if (st?.cleared) continue;
        out.push({ cx: d.cx, cz: d.cz, level: this.levelOf(d), active: !!st?.squad });
      }
    }
    return out;
  }

  isCleared(key: number): boolean {
    return this.states.get(key)?.cleared ?? false;
  }
}
