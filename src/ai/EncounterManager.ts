import { CHUNK } from '../core/config';
import type { SoundEventKind } from '../core/events';
import { vec3, type Vec3 } from '../core/math';
import { hash3, Salt, sfc32, type Rand } from '../core/rng';
import { MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { eyeHeight } from '../player/pmove';
import { makeActor, Team, teleport, type Actor } from '../sim/Actor';
import type { Simulation, SimSystem } from '../sim/Simulation';
import { addGrenades, makeInventory, type Inventory } from '../weapons/Inventory';
import type { HitInfo } from '../weapons/WeaponSystem';
import { chunkDist, chunkKey, keyToCoords, worldToChunk } from '../world/chunkMath';
import type { ChunkData } from '../world/gen/ChunkData';
import { SPAWN_DROP } from '../world/gen/pickups';
import type { WorldStreamer } from '../world/WorldStreamer';
import { pickAmbushSlots, pickHostageSpot } from './ambush';
import { Bot, TargetHistory, type BotContext, type BotRole, type Squad } from './Bot';
import { BOT_NAMES, skillFor, weaponFor, type BotSkill } from './difficulty';
import { driveHostage, EXECUTE_FUSE, FUSE_RANGE, LAST_WORDS, makeHostage, PLEA_GAP, RESCUE_REWARD, say, WARN_TIME, type Hostage } from './hostage';
import { AStar } from './nav/astar';

/** How far a sound carries: rain drowns out footsteps and quieter noises (not gunfire). */
export function hearingRadius(kind: SoundEventKind, radius: number, rain: number): number {
  if (kind === 'footstep') return radius * (1 - 0.5 * rain);
  if (kind === 'reload') return radius * (1 - 0.3 * rain);
  return radius;
}

const ACTIVATE_DIST = 90;
const MIN_SPAWN_DIST = 25;
/** Reinforcements (the rest of a squad after a wave is wiped) may appear closer, still out of sight. */
const MIN_REINFORCE_DIST = 12;
/** A player inside the area this long with nowhere hidden left to bring the rest in: it counts as cleared. */
const REINFORCE_GIVE_UP = 15;
const MAX_BOTS = 16;
/** Bots in the opening ambush (plus one per extra co-op player). */
const OPENING_SQUAD = 2;
/** Below the easiest level: slow to react, wild aim, no headshots, no recoil control. */
const OPENING_SKILL: BotSkill = {
  ...skillFor(0),
  reaction: 1.1,
  aimError: 9,
  focusTime: 2.5,
  headChance: 0,
  turnRate: 120,
  recoilComp: 0,
  awareness: 1,
};
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
  /** When bringing in reinforcements first failed with a player inside the area. */
  stalledSince?: number;
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
  /** The opening's captured officer, while he's around. */
  hostage: Hostage | null = null;
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
        remaining:
          (d.opening ? OPENING_SQUAD : skill.squadSize + (skill.overwatch && d.perches.length ? 1 : 0)) +
          Math.min(2, Math.max(0, this.sim.players.length - 1)),
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
    if (this.hostage) this.updateHostage();
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

  /**
   * The hostage scene: light the fuse once a player is near enough to watch, free him once the
   * pair holding him are down, and clear him away with the bodies.
   */
  private updateHostage(): void {
    const sim = this.sim;
    const h = this.hostage!;
    const a = h.actor;
    const pos = a.move.pos;
    let nearest: Actor | null = null;
    let best = Infinity;
    for (const p of sim.players) {
      if (!p.alive) continue;
      const d = Math.hypot(p.move.pos.x - pos.x, p.move.pos.z - pos.z);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    if (h.phase === 'held') {
      if (!a.alive) {
        h.phase = 'executed';
        a.diedAt = sim.time;
        h.afterAt = sim.time + 1.2;
        this.hostageEvent();
      } else {
        if (h.executeAt < 0 && best <= FUSE_RANGE) {
          h.executeAt = sim.time + EXECUTE_FUSE;
          h.pleaAt = sim.time + 8;
          this.hostageEvent();
        }
        // Everyone in his area down: he's free.
        if (!this.bots.some((b) => b.actor.alive && b.squad.chunkKey === h.chunkKey)) this.freeHostage();
        else if (h.executeAt >= 0) this.sceneLines(h);
      }
    }
    // The shover gloats over the body (if he's still standing around), the officer says thanks.
    if (h.afterAt >= 0 && sim.time >= h.afterAt) {
      h.afterAt = -1;
      const shover = this.castBot(h.shoverId);
      if (shover?.state === 'idle') say(sim, h, shover.actor, 'shover', 'after', true);
    }
    if (h.thanksAt >= 0 && sim.time >= h.thanksAt) {
      h.thanksAt = -1;
      say(sim, h, a, 'officer', 'thanks', true);
    }
    const face = nearest ? Math.atan2(-(nearest.move.pos.x - pos.x), -(nearest.move.pos.z - pos.z)) : null;
    driveHostage(sim, h, face);
    if (h.phase === 'executed' && sim.time - a.diedAt > BODY_TIME) this.removeHostage();
  }

  /** The countdown in words: the officer pleads now and then, the gunman warns him, then his last words. */
  private sceneLines(h: Hostage): void {
    const sim = this.sim;
    const now = sim.time;
    const left = h.executeAt - now;
    if (h.pleaAt >= 0 && now >= h.pleaAt && left > WARN_TIME + 3 && say(sim, h, h.actor, 'officer', 'plead')) h.pleaAt = now + PLEA_GAP;
    // Only a gunman still holding him at gunpoint says his lines.
    const gunman = this.castBot(h.gunmanId);
    if (!gunman?.scene || !gunman.actor.alive) return;
    if (!h.warned && left <= WARN_TIME) {
      h.warned = true;
      say(sim, h, gunman.actor, 'gunman', 'warn', true);
    }
    if (!h.lastWords && left <= LAST_WORDS) {
      h.lastWords = true;
      say(sim, h, gunman.actor, 'gunman', 'execute', true);
    }
  }

  private castBot(id: number): Bot | undefined {
    return id < 0 ? undefined : this.bots.find((b) => b.actor.id === id && b.actor.alive);
  }

  private freeHostage(): void {
    const sim = this.sim;
    const h = this.hostage!;
    h.phase = 'freed';
    h.thanksAt = sim.time + 1.5;
    h.actor.executioner = -1;
    for (const p of sim.players) sim.economy.add(p, RESCUE_REWARD, 'officer rescued');
    this.hostageEvent();
  }

  private hostageEvent(): void {
    const h = this.hostage!;
    this.sim.events.push({ type: 'captive', actorId: h.actor.id, phase: h.phase, executeAt: h.executeAt });
  }

  private removeHostage(): void {
    if (!this.hostage) return;
    this.sim.removeActor(this.hostage.actor);
    this.hostage = null;
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
      if (this.spawnSquad(st, d, key)) {
        st.stalledSince = undefined;
      } else if (st.spawnedOnce && alive.some((p) => worldToChunk(p.move.pos.x) === d.cx && worldToChunk(p.move.pos.z) === d.cz)) {
        // The rest of the squad has nowhere hidden to come from while a player holds the area:
        // don't leave the map showing enemies that never turn up.
        st.stalledSince ??= sim.time;
        if (sim.time - st.stalledSince > REINFORCE_GIVE_UP) this.clear(st);
      }
    }
    // The officer stays put until the players leave his area behind.
    const h = this.hostage;
    if (h && h.phase !== 'held') {
      const [hx, hz] = keyToCoords(h.chunkKey);
      if (!this.streamer.resident.has(h.chunkKey) || sim.players.every((p) => chunkDist(hx, hz, worldToChunk(p.move.pos.x), worldToChunk(p.move.pos.z)) > 2)) {
        this.removeHostage();
      }
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

  private newSquad(key: number, d: ChunkData): Squad {
    return {
      id: this.squadIds++,
      chunkKey: key,
      homeCx: d.cx,
      homeCz: d.cz,
      members: [],
      lastKnown: null,
      lastKnownTime: -100,
      calloutAt: Infinity,
      lastSeen: this.sim.time,
      nextNadeAt: this.sim.time + 4,
    };
  }

  private patrolOf(d: ChunkData): Vec3[] {
    const patrol: Vec3[] = [];
    for (let i = 0; i < d.patrol.length; i += 3) patrol.push(vec3(d.patrol[i], d.patrol[i + 1], d.patrol[i + 2]));
    return patrol;
  }

  /** Put one bot into the world. `inv` and `skill` override the level's loadout and skill. */
  private makeBot(
    st: EncounterState,
    squad: Squad,
    patrol: Vec3[],
    r: Rand,
    pos: Vec3,
    role: BotRole,
    opts: { inv?: Inventory; skill?: BotSkill; yaw?: number; idleYaw?: number; keepLoot?: boolean } = {},
  ): Bot {
    const sim = this.sim;
    const skill = opts.skill ?? skillFor(st.level);
    const name = BOT_NAMES[Math.floor(r() * BOT_NAMES.length)];
    const a = makeActor(sim.newActorId(), name, Team.Bots, pos.x, pos.y, pos.z);
    a.yaw = a.prevYaw = opts.yaw ?? r() * Math.PI * 2 - Math.PI;
    if (opts.inv) a.inv = opts.inv;
    else {
      const wid = weaponFor(st.level, r(), role === 'overwatch');
      const isSecondary = wid === 'glock' || wid === 'deagle';
      a.inv = makeInventory(isSecondary ? wid : 'glock', isSecondary ? null : wid);
    }
    a.armor = skill.armor;
    a.helmet = skill.helmet;
    a.keepLoot = opts.keepLoot ?? false;
    if (role !== 'overwatch' && skill.nades > 0) {
      // Own stream so grenades never change the rest of the spawn.
      const gr = sfc32(hash3(sim.params.seed, a.id, st.level, Salt.Grenade));
      for (let i = 0; i < skill.nades; i++) addGrenades(a.inv, skill.nadeKinds[Math.floor(gr() * skill.nadeKinds.length)], 1);
    }
    teleport(a, pos.x, pos.y, pos.z);
    sim.addActor(a);
    const bot = new Bot(a, skill, squad, role, pos, patrol, sim.params.seed);
    if (opts.idleYaw !== undefined) bot.idleYaw = bot.lookYaw = bot.aimYaw = opts.idleYaw;
    squad.members.push(bot);
    this.bots.push(bot);
    return bot;
  }

  /**
   * The opening ambush: a pair in plain view of the spawn drop-in point, idle and looking away.
   * They're barely trained: one has an MP9 (it stays on the ground until taken), the rest only
   * knives. False if the spawn plaza isn't loaded (the
   * sight checks need its walls) or a player is already too close.
   */
  private spawnOpening(st: EncounterState, d: ChunkData, key: number): boolean {
    const sim = this.sim;
    const spawnKey = chunkKey(0, 0);
    if (!this.streamer.resident.has(spawnKey)) return false;
    const ex = SPAWN_DROP.x;
    const ez = SPAWN_DROP.z;
    const eye = vec3(ex, sim.findFloor(ex, ez, 20) + 1.6, ez);
    const room = Math.min(st.remaining, MAX_BOTS - this.aliveCount);
    const slots = pickAmbushSlots(sim, d, eye, room);
    // Someone already standing there (an old save, a guest): spawn the usual way instead.
    const crowded = slots.some((s) => sim.players.some((p) => p.alive && Math.hypot(s.x - p.move.pos.x, s.z - p.move.pos.z) < MIN_SPAWN_DIST));
    if (!slots.length || crowded) return false;
    const r = sfc32(hash3(sim.params.seed, d.cx, d.cz, Salt.Names));
    const squad = this.newSquad(key, d);
    const patrol = this.patrolOf(d);
    // A captured officer kneels just beyond the gunman, facing the plaza.
    const spot = this.hostage ? null : pickHostageSpot(sim, eye, slots[0], slots.slice(1));
    let hostage: Hostage | null = null;
    if (spot) {
      const l = Math.hypot(spot.x - eye.x, spot.z - eye.z) || 1;
      hostage = this.hostage = makeHostage(sim, spot, (spot.x - eye.x) / l, (spot.z - eye.z) / l, key);
    }
    slots.forEach((pos, i) => {
      // Facing away from the plaza, a little turned towards each other.
      const away = Math.atan2(-(pos.x - eye.x), -(pos.z - eye.z));
      const idleYaw = away + (i % 2 ? 0.35 : -0.35);
      // In the scene, facing the hostage.
      const hp = hostage?.actor.move.pos;
      const yaw = hp && i < 2 ? Math.atan2(-(hp.x - pos.x), -(hp.z - pos.z)) : idleYaw;
      const inv = i === 0 ? makeInventory(null, 'mp9') : makeInventory(null);
      const bot = this.makeBot(st, squad, patrol, r, pos, 'anchor', { inv, skill: OPENING_SKILL, yaw, idleYaw, keepLoot: true });
      if (hostage && i < 2) {
        bot.scene = { hostage, role: i === 0 ? 'gunman' : 'shover' };
        if (i === 0) hostage.gunmanId = bot.actor.id;
        else hostage.shoverId = bot.actor.id;
        bot.lookYaw = bot.aimYaw = yaw;
      }
    });
    if (hostage) this.hostageEvent();
    st.remaining -= squad.members.length;
    st.squad = squad;
    st.spawnedOnce = true;
    return true;
  }

  /** Returns false if nobody could be placed (every slot in sight or too close). */
  private spawnSquad(st: EncounterState, d: ChunkData, key: number): boolean {
    if (d.opening && !st.spawnedOnce && this.spawnOpening(st, d, key)) return true;
    const sim = this.sim;
    const skill = skillFor(st.level);
    const r = sfc32(hash3(sim.params.seed, d.cx, d.cz, Salt.Names) ^ (st.spawnedOnce ? 0x55 : 0));
    const eyes = sim.players
      .filter((p) => p.alive)
      .map((p) => vec3(p.move.pos.x, p.move.pos.y + eyeHeight(p.move), p.move.pos.z));
    // Slots out of every player's sight and not too close to anyone.
    const minDist = st.spawnedOnce ? MIN_REINFORCE_DIST : MIN_SPAWN_DIST;
    const hidden = (s: Vec3): boolean => {
      for (const eye of eyes) {
        if (Math.hypot(s.x - eye.x, s.z - eye.z) < minDist) return false;
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
    if (riflemen <= 0) return false; // try again next time (players may be looking at every slot)

    const squad = this.newSquad(key, d);
    const patrol = this.patrolOf(d);
    const make = (pos: Vec3, role: BotRole) => this.makeBot(st, squad, patrol, r, pos, role);
    for (let i = 0; i < riflemen; i++) {
      const role: BotRole = i === 0 && skill.canFlank && riflemen >= 3 ? 'flanker' : i % 2 === 1 ? 'patroller' : 'anchor';
      make(slots[i], role);
    }
    if (wantOverwatch) make(perches[Math.floor(r() * perches.length)], 'overwatch');
    st.remaining -= squad.members.length;
    st.squad = squad;
    st.spawnedOnce = true;
    return true;
  }

  private despawnSquad(st: EncounterState): void {
    const sq = st.squad;
    if (!sq) return;
    // Everyone's gone far away: the scene doesn't come back with the survivors.
    if (this.hostage?.chunkKey === st.key && this.hostage.phase === 'held') this.removeHostage();
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
      // A fall isn't an attack.
      if (info.attacker !== info.victim) victimBot.onDamaged(info.attacker, sim.time);
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
    if (info.victim.team === Team.Player && killed && !info.victim.captive) this.onPlayerDeath(info.victim);
  }

  private checkCleared(sq: Squad): void {
    if (sq.members.some((m) => m.actor.alive)) return;
    const st = this.states.get(sq.chunkKey);
    if (!st || st.remaining > 0) {
      // More bots still to come (e.g. spawn was capped): let the next manage() tick bring them in.
      if (st) st.squad = null;
      return;
    }
    this.clear(st);
  }

  private clear(st: EncounterState): void {
    st.cleared = true;
    st.squad = null;
    st.remaining = 0;
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
