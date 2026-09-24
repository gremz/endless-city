import { CHUNK } from '../core/config';
import type { SoundEventKind } from '../core/events';
import { vec3, type Vec3 } from '../core/math';
import { hash3, Salt, sfc32 } from '../core/rng';
import { MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { eyeHeight } from '../player/pmove';
import { makeActor, Team, teleport, type Actor } from '../sim/Actor';
import type { Simulation, SimSystem } from '../sim/Simulation';
import { addGrenades, makeInventory } from '../weapons/Inventory';
import type { HitInfo } from '../weapons/WeaponSystem';
import { chunkDist, chunkKey, keyToCoords, worldToChunk } from '../world/chunkMath';
import type { ChunkData } from '../world/gen/ChunkData';
import type { WorldStreamer } from '../world/WorldStreamer';
import { Bot, TargetHistory, type BotContext, type BotRole, type Squad } from './Bot';
import { BOT_NAMES, skillFor, weaponFor } from './difficulty';
import { AStar } from './nav/astar';

/** How far a sound carries: rain drowns out footsteps and quieter noises (not gunfire). */
export function hearingRadius(kind: SoundEventKind, radius: number, rain: number): number {
  if (kind === 'footstep') return radius * (1 - 0.5 * rain);
  if (kind === 'reload') return radius * (1 - 0.3 * rain);
  return radius;
}

const ACTIVATE_DIST = 90;
const MIN_SPAWN_DIST = 25;
const MAX_BOTS = 16;
const DESPAWN_UNSEEN = 10;
const BODY_TIME = 12;

/** An encounter area as stored in a save: squads in progress are saved as their survivors. */
export interface SavedEncounter {
  key: number;
  level: number;
  cleared: boolean;
  remaining: number;
  spawnedOnce: boolean;
}

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
  /** Squad in the field on the host (online clients, which run no bots). */
  remoteActive?: boolean;
}

/** An encounter area for maps and radars. */
export interface EncounterSummary {
  key: number;
  cx: number;
  cz: number;
  level: number;
  cleared: boolean;
  active: boolean;
}

/** Spawns squads in encounter chunks as players approach, runs the bots, pays for clears. */
export class EncounterManager implements SimSystem {
  readonly states = new Map<number, EncounterState>();
  readonly bots: Bot[] = [];
  private astar: AStar;
  private histories = new Map<number, TargetHistory>();
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
    this.ctx = { sim, astar: this.astar, histories: this.histories, pathBudget: 2 };
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
        cleared: this.sim.cleared.has(d.key),
        // One more bot per extra player (up to two): co-op fights stay fights.
        remaining: skill.squadSize + (skill.overwatch && d.perches.length ? 1 : 0) + Math.min(2, Math.max(0, this.sim.players.length - 1)),
        squad: null,
        spawnedOnce: false,
      };
      this.states.set(d.key, s);
    }
    return s;
  }

  update(sim: Simulation): void {
    for (const p of sim.players) {
      let h = this.histories.get(p.id);
      if (!h) this.histories.set(p.id, (h = new TargetHistory()));
      h.record(p, sim.tick);
    }
    if (this.histories.size > sim.players.length) {
      for (const id of this.histories.keys()) if (!sim.isPlayer(id)) this.histories.delete(id);
    }
    this.ctx.pathBudget = 2;
    if (this.enabled && (sim.tick & 15) === 0) this.manage();
    for (const b of this.bots) b.update(this.ctx);
    // Hearing: this tick's sounds made by players.
    const sounds = sim.events.tickSounds;
    if (sounds.length) {
      for (const s of sounds) {
        if (!sim.isPlayer(s.sourceId)) continue;
        // Grenades give away that you're around, not where you are.
        const reveal = s.kind !== 'grenade';
        const radius = hearingRadius(s.kind, s.radius, sim.env.rain);
        for (const b of this.bots) {
          if (!b.actor.alive) continue;
          b.hear(s.pos, this.losTo(b, s.pos) ? radius : radius * 0.6, sim.time, reveal);
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
    return this.tr.fraction >= 0.999 && !this.sim.grenades.blocksSight(from, to);
  }

  /** Activation, despawn and clear checks (4 Hz). */
  private manage(): void {
    const sim = this.sim;
    const alive = sim.players.filter((p) => p.alive);
    for (const [key, r] of this.streamer.resident) {
      const d = r.data;
      if (!d.hasEncounter || this.sim.params.noBots) continue;
      const st = this.stateFor(d);
      if (st.cleared || st.squad || st.remaining <= 0) continue;
      const cxw = (d.cx + 0.5) * CHUNK;
      const czw = (d.cz + 0.5) * CHUNK;
      if (!alive.some((p) => Math.hypot(cxw - p.move.pos.x, czw - p.move.pos.z) <= ACTIVATE_DIST)) continue;
      if (this.aliveCount >= MAX_BOTS) break;
      this.spawnSquad(st, d, key);
    }
    // Despawn squads every player has left far behind.
    for (const st of this.states.values()) {
      const sq = st.squad;
      if (!sq) continue;
      const far = sim.players.every((p) => chunkDist(st.cx, st.cz, worldToChunk(p.move.pos.x), worldToChunk(p.move.pos.z)) > 2);
      const unseen = sim.time - sq.lastSeen > DESPAWN_UNSEEN;
      const unloaded = !this.streamer.resident.has(st.key);
      if ((far && unseen) || unloaded) this.despawnSquad(st);
    }
  }

  private spawnSquad(st: EncounterState, d: ChunkData, key: number): void {
    const sim = this.sim;
    const skill = skillFor(st.level);
    const r = sfc32(hash3(sim.params.seed, d.cx, d.cz, Salt.Names) ^ (st.spawnedOnce ? 0x55 : 0));
    const eyes = sim.players
      .filter((p) => p.alive)
      .map((p) => vec3(p.move.pos.x, p.move.pos.y + eyeHeight(p.move), p.move.pos.z));
    // Slots out of every player's sight and not too close to anyone.
    const hidden = (s: Vec3): boolean => {
      for (const eye of eyes) {
        if (Math.hypot(s.x - eye.x, s.z - eye.z) < MIN_SPAWN_DIST) return false;
        this.sim.world.traceRay(this.tr, eye, vec3(s.x, s.y + 1.6, s.z), MASK_SHOT);
        if (this.tr.fraction >= 0.999) return false;
      }
      return true;
    };
    const slots: Vec3[] = [];
    for (let i = 0; i < d.spawns.length; i += 3) {
      const s = vec3(d.spawns[i], d.spawns[i + 1], d.spawns[i + 2]);
      if (hidden(s)) slots.push(s);
    }
    const perches: Vec3[] = [];
    for (let i = 0; i < d.perches.length; i += 3) {
      const s = vec3(d.perches[i], d.perches[i + 1], d.perches[i + 2]);
      if (hidden(s)) perches.push(s);
    }
    const wantOverwatch = skill.overwatch && perches.length > 0 && st.remaining > 1;
    const riflemen = Math.min(st.remaining - (wantOverwatch ? 1 : 0), slots.length, MAX_BOTS - this.aliveCount);
    if (riflemen <= 0) return; // try again next time (players may be looking at every slot)

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
      nextNadeAt: sim.time + 4,
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
      if (role !== 'overwatch' && skill.nades > 0) {
        // Own stream so grenades never change the rest of the spawn.
        const gr = sfc32(hash3(sim.params.seed, a.id, st.level, Salt.Grenade));
        for (let i = 0; i < skill.nades; i++) addGrenades(a.inv, skill.nadeKinds[Math.floor(gr() * skill.nadeKinds.length)], 1);
      }
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
      victimBot.onDamaged(info.attacker, sim.time);
      // The rest of the squad hears about it quickly.
      for (const m of victimBot.squad.members) {
        if (m !== victimBot && m.actor.alive) m.awareness = Math.max(m.awareness, 0.5);
      }
      if (killed) {
        this.deadBodies.push({ bot: victimBot, at: sim.time });
        if (info.attacker.team === Team.Player) {
          // Fighting in the dark pays a quarter more.
          const night = sim.env.darkness > 0.5;
          const reward = Math.round(info.def.killReward * (night ? 1.25 : 1));
          sim.economy.add(info.attacker, reward, night ? 'kill (night bonus)' : 'kill');
        }
        this.checkCleared(victimBot.squad);
      }
    }
    if (info.victim.team === Team.Player && killed) this.onPlayerDeath(info.victim);
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
    // Everyone on the team gets the bonus, wherever they are.
    for (const p of this.sim.players) this.sim.economy.add(p, bonus, 'clear');
    this.sim.events.push({ type: 'chunkCleared', chunkKey: st.key, bonus, level: st.level });
  }

  /**
   * A player died: bots after them look for someone else. Once every player is down, squads
   * heal and forget, as in solo play.
   */
  private onPlayerDeath(victim: Actor): void {
    const allDown = this.sim.players.every((p) => !p.alive);
    for (const b of this.bots) {
      if (!b.actor.alive) continue;
      if (allDown) {
        b.actor.health = 100;
        b.reset(this.sim.time);
        b.squad.lastKnown = null;
        b.squad.calloutAt = Infinity;
      } else if (b.target === victim) {
        b.target = null;
      }
    }
  }

  serialize(): SavedEncounter[] {
    return [...this.states.values()].map((s) => ({
      key: s.key,
      level: s.level,
      cleared: s.cleared,
      // A squad in the field comes back later as its survivors, like a despawn.
      remaining: s.remaining + (s.squad?.members.filter((m) => m.actor.alive).length ?? 0),
      spawnedOnce: s.spawnedOnce,
    }));
  }

  /** Recreate encounter progress from a save (before any chunk streams in). */
  restore(list: readonly SavedEncounter[]): void {
    for (const e of list) {
      const [cx, cz] = keyToCoords(e.key);
      this.states.set(e.key, {
        key: e.key,
        cx,
        cz,
        level: e.level,
        cleared: e.cleared || this.sim.cleared.has(e.key),
        remaining: e.remaining,
        squad: null,
        spawnedOnce: e.spawnedOnce,
      });
    }
  }

  /** Every encounter area seen so far. */
  summaries(): EncounterSummary[] {
    return [...this.states.values()].map((s) => ({
      key: s.key,
      cx: s.cx,
      cz: s.cz,
      level: s.level,
      cleared: s.cleared,
      active: !!s.squad || !!s.remoteActive,
    }));
  }

  /** Take over the host's progress (online clients: no bots run here). */
  applyRemote(list: readonly { key: number; level: number; cleared: boolean; active: boolean }[]): void {
    this.states.clear();
    for (const e of list) {
      const [cx, cz] = keyToCoords(e.key);
      this.states.set(e.key, { key: e.key, cx, cz, level: e.level, cleared: e.cleared, remaining: 0, squad: null, spawnedOnce: true, remoteActive: e.active });
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
        out.push({ cx: d.cx, cz: d.cz, level: this.levelOf(d), active: !!st?.squad || !!st?.remoteActive });
      }
    }
    return out;
  }

  isCleared(key: number): boolean {
    return this.states.get(key)?.cleared ?? false;
  }
}
