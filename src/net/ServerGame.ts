import { EncounterManager } from '../ai/EncounterManager';
import { CHUNK } from '../core/config';
import type { SimEvent } from '../core/events';
import { FixedLoop } from '../core/loop';
import type { GameParams } from '../core/urlParams';
import { Buttons, MAX_PITCH, type UserCmd } from '../input/UserCmd';
import { teleport, type Actor } from '../sim/Actor';
import { buy, engagedNear, OUT_OF_COMBAT } from '../sim/buy';
import { applyPlayerSave, applyWorldSave, captureSave, type SaveData } from '../sim/save';
import { PickupManager } from '../sim/Pickups';
import { RESPAWN_DELAY, respawnPoint } from '../sim/respawn';
import { Simulation } from '../sim/Simulation';
import { Vehicles } from '../sim/vehicle/Vehicles';
import { WEAPONS, type BuyItem } from '../weapons/weaponDefs';
import type { ChunkSource } from '../world/WorldStreamer';
import { WorldStreamer } from '../world/WorldStreamer';
import { SPAWN_DROP } from '../world/gen/pickups';
import {
  Bin,
  binKind,
  decodeCmds,
  encodeSnapshot,
  MAX_PLAYERS,
  netActor,
  netParams,
  netPickup,
  netVehicle,
  privateState,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY,
  toJson,
  type ClientMsg,
  type NetGrenades,
  type SeqCmd,
  type ServerMsg,
} from './protocol';
import type { Payload, Transport } from './Transport';

/**
 * With more commands than this queued (a burst after a hitch, or a client clock running a bit
 * fast), a player runs extra commands per tick, up to MAX_PER_TICK, until caught up.
 */
const CATCH_UP = 2;
const MAX_PER_TICK = 4;
/** Commands queued beyond this are merged away (movement is lost, key presses are kept). */
const MAX_QUEUE = 64;
/**
 * Command budget: each tick earns a player this many commands (a little over one, for a client
 * clock that runs slightly fast), banked up to MAX_CREDIT for catching up after a hitch. Sending
 * commands faster than the tick rate can't make anyone move faster than that.
 */
const CMD_RATE = 1.05;
const MAX_CREDIT = MAX_QUEUE;
/** Seconds a connection may take to say hello, and connections allowed beyond the player cap. */
const HELLO_TIMEOUT = 15;
const SPARE_CONNS = 2;
/** Chat flood guard: a burst of this many messages, then this many per second. */
const CHAT_BURST = 5;
const CHAT_RATE = 1;
const MAX_CHAT = 200;
/** Ticks to wait for a command that's missing from the sequence (late or reordered packet). */
const GAP_WAIT = 3;
/** Lag compensation: how far back shots may be checked, and how much history is kept. */
const MAX_REWIND = 0.25;
const HISTORY = 64;
/** Positional events further than this from a player aren't sent to them. */
const EVENT_RANGE = 150;
const MAX_NAME = 20;
/** Cars further than this from a player aren't in their snapshots. */
const VEHICLE_RANGE = 160;
/** The first player to join (the host) always gets this actor id. */
const HOST_ID = 1;

interface Conn {
  transport: Transport;
  actor: Actor | null;
  name: string;
  /** Commands waiting to run, in sequence order. */
  queue: SeqCmd[];
  /** Last command sequence run. */
  ranSeq: number;
  /** Ticks spent waiting for a missing command before skipping past it. */
  gapWait: number;
  /** Host time this client draws other actors at (from its latest commands). */
  viewTime: number;
  /** Actor ids this client has been told the names of. */
  known: Set<number>;
  events: SimEvent[];
  pickupsJson: string;
  worldJson: string;
  scoresJson: string;
  ackSnapshot: number;
  /** Waiting for the ground under the spawn point to load. */
  pendingSpawn: { x: number; z: number } | null;
  /** Saved state to put this player back in once they're placed (the host continuing a save). */
  restore: SaveData | null;
  /** Commands this player may still run (see CMD_RATE). */
  credit: number;
  /** Host time this connection opened (hello timeout). */
  openedAt: number;
  chatCredit: number;
  chatAt: number;
}

const BUYABLE = new Set<string>([...Object.keys(WEAPONS), 'kevlar', 'helmet', 'ammo_primary', 'ammo_secondary']);

/**
 * The authoritative game on the host: runs the simulation, bots and pickups for every player,
 * takes their commands and sends back snapshots and events. Transport-agnostic and DOM-free, so
 * it runs in the host's worker (or a Node server, or a test).
 */
export class ServerGame {
  readonly sim: Simulation;
  readonly streamer: WorldStreamer;
  readonly encounters: EncounterManager | null;
  readonly pickups: PickupManager;
  readonly vehicles: Vehicles;
  private loop: FixedLoop;
  private conns: Conn[] = [];
  private cmds = new Map<number, UserCmd>();
  private lastUpdate = -1;
  /** Per actor, the last HISTORY ticks of x, y, z, duckAmount, yaw (lag compensation). */
  private history = new Map<number, Float32Array>();
  private saved: [Actor, number, number, number, number, number][] = [];
  /** Kills and deaths per player actor id. */
  private stats = new Map<number, { kills: number; deaths: number }>();

  /** The save this game continues, until the host (first player) has been put back in it. */
  private hostSave: SaveData | null;

  constructor(
    readonly params: GameParams,
    source: ChunkSource,
    readonly maxPlayers = MAX_PLAYERS,
    save: SaveData | null = null,
  ) {
    const dt = 1 / params.tickRate;
    this.loop = new FixedLoop(dt);
    this.sim = new Simulation(params, { autoBhop: false }, dt, false);
    this.streamer = new WorldStreamer(this.sim.world, source);
    this.streamer.addListener(this.sim.nav);
    this.streamer.addListener(this.sim.doors);
    this.streamer.addListener(this.sim.glass);
    this.encounters = params.world === 'city' ? new EncounterManager(this.sim, this.streamer) : null;
    if (this.encounters) this.sim.systems.push(this.encounters);
    this.pickups = new PickupManager(this.sim);
    this.streamer.addListener(this.pickups);
    this.sim.systems.push(this.pickups);
    this.vehicles = new Vehicles(this.sim);
    this.streamer.addListener(this.vehicles);
    this.sim.systems.push(this.vehicles);
    this.sim.lagComp = (p, cmd, fire) => this.rewound(p, cmd, fire);
    this.hostSave = save;
    // The host joins first and gets the first actor id: their saved stash waits for them.
    if (save) applyWorldSave(save, this.sim, this.pickups, this.encounters, this.vehicles, HOST_ID);
  }

  /**
   * Save the game from the host's side (their position and loadout, everyone's shared
   * progress). Returns the save, or why it can't be made right now.
   */
  save(explored: readonly number[], manual: boolean): SaveData | string {
    const host = this.conns[0]?.actor;
    if (!host || this.conns[0].pendingSpawn) return 'Still loading.';
    if (!host.alive) return 'You can’t save while dead.';
    const t = this.sim.time;
    const fighting = t - host.lastDamagedAt < OUT_OF_COMBAT || t - host.lastDealtAt < OUT_OF_COMBAT || engagedNear(this.sim, host);
    if (manual && fighting) return 'You can’t save during a fight.';
    if (host.vehicle >= 0) return 'Get out of the car to save.';
    return captureSave(this.sim, host, this.pickups, this.encounters, this.vehicles, explored);
  }

  get playerCount(): number {
    return this.conns.filter((c) => c.actor).length;
  }

  /** A client connected; it becomes a player once it says hello. */
  connect(transport: Transport): void {
    if (this.conns.length >= this.maxPlayers + SPARE_CONNS) {
      transport.send(toJson({ t: 'reject', reason: `The game is full (${this.maxPlayers} players).` } satisfies ServerMsg), true);
      transport.close();
      return;
    }
    const conn: Conn = {
      transport,
      actor: null,
      name: '',
      queue: [],
      ranSeq: 0,
      gapWait: 0,
      viewTime: 0,
      known: new Set(),
      events: [],
      pickupsJson: '',
      worldJson: '',
      scoresJson: '',
      ackSnapshot: 0,
      pendingSpawn: null,
      restore: null,
      credit: 0,
      openedAt: this.sim.time,
      chatCredit: CHAT_BURST,
      chatAt: this.sim.time,
    };
    this.conns.push(conn);
    transport.onMessage = (data) => this.receive(conn, data);
    transport.onClose = () => this.disconnect(conn);
  }

  /** Advance to wall-clock `now` (seconds): stream the world, run due ticks, send updates. */
  update(now: number): void {
    const dt = this.lastUpdate < 0 ? 0 : now - this.lastUpdate;
    this.lastUpdate = now;
    this.stream();
    this.loop.advance(dt, () => this.tick());
  }

  /** Seconds until the next tick is due (for scheduling the next update). */
  get untilNextTick(): number {
    return this.loop.untilNextTick;
  }

  /** Keep the world loaded around every player (and where joining players will appear). */
  stream(): void {
    const points: { x: number; z: number }[] = [];
    for (const c of this.conns) {
      if (c.pendingSpawn) points.push(c.pendingSpawn);
      else if (c.actor) points.push(c.actor.move.pos);
    }
    this.streamer.updateAround(points);
    this.streamer.apply(2, 2);
  }

  /** One fixed tick (tests call this directly). */
  tick(): void {
    const sim = this.sim;
    this.cmds.clear();
    for (const c of [...this.conns]) {
      const a = c.actor;
      if (!a) {
        if (sim.time - c.openedAt > HELLO_TIMEOUT) c.transport.close();
        continue;
      }
      if (c.pendingSpawn) {
        // Input from before we're in the world means nothing.
        if (c.queue.length) c.ranSeq = Math.max(c.ranSeq, c.queue[c.queue.length - 1].seq);
        c.queue.length = 0;
        const { x, z } = c.pendingSpawn;
        if (!this.streamer.allLoaded(x, z, 1)) continue;
        if (c.restore) {
          const s = c.restore.player;
          teleport(a, x, sim.findFloor(x, z, s.y + 1), z);
          applyPlayerSave(s, a, c.restore.money);
          c.restore = null;
        } else {
          teleport(a, x, sim.findFloor(x, z, 30), z);
        }
        c.pendingSpawn = null;
      }
      c.credit = Math.min(MAX_CREDIT, c.credit + CMD_RATE);
      // Never simulate someone standing on a chunk that hasn't loaded here yet.
      if (!this.streamer.isLoaded(a.move.pos.x, a.move.pos.z)) continue;
      // No command, no move: the player's state stays a pure function of their commands,
      // which is what lets their client predict it.
      const cmd = this.nextCmd(c);
      if (cmd) this.cmds.set(a.id, cmd);
    }
    sim.step(this.cmds);
    // Running behind: take extra commands this tick. Never dropping them keeps the player's
    // state what their client predicted.
    for (const c of this.conns) {
      const a = c.actor;
      if (!a || c.pendingSpawn || !this.cmds.has(a.id)) continue;
      for (let n = 1; n < MAX_PER_TICK && c.queue.length > CATCH_UP; n++) {
        const cmd = this.nextCmd(c);
        if (!cmd) break; // waiting on a late command
        if (a.alive) sim.runCmd(a, cmd);
      }
    }
    this.recordHistory();

    for (const c of this.conns) {
      const a = c.actor;
      if (!a || a.alive) continue;
      const cmd = this.cmds.get(a.id);
      if (!cmd || sim.time - a.diedAt < RESPAWN_DELAY || !(cmd.pressed & (Buttons.ATTACK | Buttons.JUMP))) continue;
      // Come back near a living teammate if there is one, else near where you fell.
      const mate = sim.players.find((p) => p.alive && p !== a);
      const { x, z } = respawnPoint(sim, mate ?? a, (key) => this.streamer.resident.has(key));
      sim.respawnPlayer(a, x, z);
    }

    const events = sim.events.drain();
    for (const e of events) if (e.type === 'kill') this.countKill(e.attackerId, e.victimId);
    if (events.length) for (const c of this.conns) if (c.actor) this.queueEvents(c, events);
    if (sim.tick % SNAPSHOT_EVERY === 0) this.broadcast();
  }

  private nextCmd(c: Conn): UserCmd | null {
    const q = c.queue;
    ServerGame.foldQueue(q);
    if (!q.length || c.credit < 1) return null;
    // A gap: the missing command may still be on its way in a reordered packet.
    if (q[0].seq > c.ranSeq + 1 && c.ranSeq > 0 && c.gapWait < GAP_WAIT && q.length <= CATCH_UP + GAP_WAIT) {
      c.gapWait++;
      return null;
    }
    c.gapWait = 0;
    const next = q.shift()!;
    c.ranSeq = next.seq;
    c.credit--;
    return next.cmd;
  }

  /** Far too far behind: fold the oldest commands into the next one, keeping their key presses. */
  private static foldQueue(q: SeqCmd[]): void {
    while (q.length > MAX_QUEUE) {
      const old = q.shift()!;
      q[0].cmd.pressed |= old.cmd.pressed;
      if (q[0].cmd.weaponSelect < 0) q[0].cmd.weaponSelect = old.cmd.weaponSelect;
    }
  }

  private recordHistory(): void {
    const slot = (this.sim.tick % HISTORY) * 5;
    for (const a of this.sim.actors) {
      let h = this.history.get(a.id);
      if (!h) this.history.set(a.id, (h = new Float32Array(HISTORY * 5).fill(Number.NaN)));
      h[slot] = a.move.pos.x;
      h[slot + 1] = a.move.pos.y;
      h[slot + 2] = a.move.pos.z;
      h[slot + 3] = a.move.duckAmount;
      h[slot + 4] = a.yaw;
    }
    if (this.history.size > this.sim.actors.length + 8) {
      for (const id of this.history.keys()) if (!this.sim.getActor(id)) this.history.delete(id);
    }
  }

  /**
   * Fire a player's weapon with everyone else put back where that player saw them (up to
   * MAX_REWIND ago), so a shot that was on target on their screen hits here too.
   */
  private rewound(p: Actor, cmd: UserCmd, fire: () => void): void {
    const c = this.conns.find((x) => x.actor === p);
    const sim = this.sim;
    const back = c ? Math.min(MAX_REWIND, Math.max(0, sim.time - c.viewTime)) : 0;
    if (back <= 0 || !(cmd.buttons & (Buttons.ATTACK | Buttons.ATTACK2))) {
      fire();
      return;
    }
    const at = sim.tick - back / sim.dt;
    const t0 = Math.floor(at);
    const k = at - t0;
    const i0 = (((t0 % HISTORY) + HISTORY) % HISTORY) * 5;
    const i1 = ((((t0 + 1) % HISTORY) + HISTORY) % HISTORY) * 5;
    const saved = this.saved;
    saved.length = 0;
    for (const a of sim.actors) {
      if (a === p || !a.alive) continue;
      const h = this.history.get(a.id);
      if (!h || Number.isNaN(h[i0]) || Number.isNaN(h[i1])) continue;
      const m = a.move;
      saved.push([a, m.pos.x, m.pos.y, m.pos.z, m.duckAmount, a.yaw]);
      m.pos.x = h[i0] + (h[i1] - h[i0]) * k;
      m.pos.y = h[i0 + 1] + (h[i1 + 1] - h[i0 + 1]) * k;
      m.pos.z = h[i0 + 2] + (h[i1 + 2] - h[i0 + 2]) * k;
      m.duckAmount = h[i0 + 3] + (h[i1 + 3] - h[i0 + 3]) * k;
      a.yaw = h[i0 + 4];
    }
    fire();
    for (const [a, x, y, z, duck, yaw] of saved) {
      a.move.pos.x = x;
      a.move.pos.y = y;
      a.move.pos.z = z;
      a.move.duckAmount = duck;
      a.yaw = yaw;
    }
  }

  /** Anything a client sends is untrusted: malformed input is dropped, never thrown. */
  private receive(c: Conn, data: Payload): void {
    try {
      this.handle(c, data);
    } catch {
      /* malformed message */
    }
  }

  private handle(c: Conn, data: Payload): void {
    if (data instanceof ArrayBuffer) {
      if (binKind(data) !== Bin.Cmds || !c.actor) return;
      const p = decodeCmds(data);
      if (!Number.isFinite(p.viewTime) || !p.cmds.every((sc) => validCmd(sc.cmd))) return;
      c.ackSnapshot = Math.max(c.ackSnapshot, p.ackSnapshot);
      c.viewTime = Math.max(c.viewTime, p.viewTime);
      for (const sc of p.cmds) {
        if (sc.seq <= c.ranSeq) continue;
        sc.cmd.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, sc.cmd.pitch));
        sc.cmd.attackPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, sc.cmd.attackPitch));
        // Keep the queue in order and free of duplicates (packets repeat commands, and may
        // arrive out of order).
        const q = c.queue;
        let i = q.length;
        while (i > 0 && q[i - 1].seq > sc.seq) i--;
        if (i > 0 && q[i - 1].seq === sc.seq) continue;
        q.splice(i, 0, sc);
      }
      ServerGame.foldQueue(c.queue);
      return;
    }
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ClientMsg | null;
    if (typeof msg !== 'object' || msg === null) return;
    if (msg.t === 'hello') this.hello(c, msg.name, msg.version, !!msg.autoBhop);
    else if (msg.t === 'buy' && c.actor && BUYABLE.has(msg.item)) {
      buy(this.sim, c.actor, msg.item as BuyItem, engagedNear(this.sim, c.actor));
    } else if (msg.t === 'chat' && c.actor && typeof msg.text === 'string') {
      const now = this.sim.time;
      c.chatCredit = Math.min(CHAT_BURST, c.chatCredit + (now - c.chatAt) * CHAT_RATE);
      c.chatAt = now;
      if (c.chatCredit < 1) return;
      const text = msg.text.slice(0, MAX_CHAT).trim();
      if (!text) return;
      c.chatCredit--;
      this.sendAll({ t: 'chat', from: c.name, text });
    }
  }

  private hello(c: Conn, rawName: unknown, version: unknown, autoBhop: boolean): void {
    if (c.actor) return;
    if (version !== PROTOCOL_VERSION) return this.reject(c, 'The host is running a different version of the game.');
    if (this.playerCount >= this.maxPlayers) return this.reject(c, `The game is full (${this.maxPlayers} players).`);
    const sim = this.sim;
    let name = (typeof rawName === 'string' ? rawName : '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Player';
    const taken = new Set(sim.players.map((p) => p.name));
    for (let i = 2; taken.has(name); i++) name = `${name.replace(/ \d+$/, '')} ${i}`;
    c.name = name;
    const a = sim.addPlayer(name);
    if (autoBhop) sim.autoBhopIds.add(a.id);
    c.actor = a;
    // Join near a living teammate (their nearest buy zone), else in the spawn plaza. A host
    // continuing a save goes back where they saved.
    const mate = sim.players.find((p) => p.alive && p !== a);
    let spot = mate
      ? respawnPoint(sim, mate, (key) => this.streamer.resident.has(key))
      : { x: this.params.spawnCx * CHUNK + SPAWN_DROP.x + (sim.players.length - 1) * 1.5, z: this.params.spawnCz * CHUNK + SPAWN_DROP.z };
    if (this.hostSave && a.id === HOST_ID) {
      c.restore = this.hostSave;
      spot = { x: this.hostSave.player.x, z: this.hostSave.player.z };
      a.yaw = this.hostSave.player.yaw;
    }
    this.hostSave = null;
    teleport(a, spot.x, 30, spot.z);
    c.pendingSpawn = spot;
    this.send(c, { t: 'welcome', actorId: a.id, params: netParams(this.params), tick: sim.tick, time: sim.time });
    sim.events.push({ type: 'message', actorId: -1, text: `${name} joined the game` });
  }

  private reject(c: Conn, reason: string): void {
    this.send(c, { t: 'reject', reason });
    c.transport.close();
  }

  private disconnect(c: Conn): void {
    const i = this.conns.indexOf(c);
    if (i >= 0) this.conns.splice(i, 1);
    const a = c.actor;
    if (!a) return;
    c.actor = null;
    this.pickups.clearStash(a.id);
    this.stats.delete(a.id);
    this.sim.removePlayer(a);
    this.sim.events.push({ type: 'message', actorId: -1, text: `${c.name} left the game` });
  }

  private countKill(attacker: number, victim: number): void {
    const stat = (id: number) => {
      let s = this.stats.get(id);
      if (!s) this.stats.set(id, (s = { kills: 0, deaths: 0 }));
      return s;
    };
    if (this.sim.isPlayer(victim)) stat(victim).deaths++;
    if (this.sim.isPlayer(attacker) && attacker !== victim) stat(attacker).kills++;
  }

  private queueEvents(c: Conn, events: readonly SimEvent[]): void {
    const me = c.actor!.move.pos;
    for (const e of events) {
      // Sounds are for the bots' ears; presentation never uses them.
      if (e.type === 'sound') continue;
      const pos = e.type === 'shot' ? e.from : e.type === 'impact' || e.type === 'step' || e.type === 'nade_bounce' ? e.pos : null;
      if (pos && Math.hypot(pos.x - me.x, pos.z - me.z) > EVENT_RANGE) continue;
      c.events.push(e);
    }
  }

  private broadcast(): void {
    const sim = this.sim;
    const actors = sim.actors.map(netActor);
    const nades = this.netGrenades();
    const nadesJson = toJson(nades);
    // Shared by every client's `known` below; replaced, never mutated.
    const ids = new Set(sim.actors.map((x) => x.id));
    const slow = sim.tick % (SNAPSHOT_EVERY * 8) === 0;
    const pickupsJson = slow ? toJson(this.pickups.items.map(netPickup)) : '';
    const world = slow ? this.worldState() : null;
    const worldJson = world ? toJson(world) : '';
    const scores: ServerMsg | null = slow
      ? {
          t: 'scores',
          s: sim.players.map((p) => {
            const st = this.stats.get(p.id);
            return [p.id, p.name, st?.kills ?? 0, st?.deaths ?? 0, p.money];
          }),
        }
      : null;
    const scoresJson = scores ? toJson(scores) : '';
    for (const c of this.conns) {
      const a = c.actor;
      if (!a) continue;
      // Names of actors this client hasn't met yet, before the snapshot that shows them.
      const add: [number, string, number, boolean][] = [];
      for (const x of sim.actors) if (!c.known.has(x.id)) add.push([x.id, x.name, x.team, x.dummy]);
      if (add.length) this.send(c, { t: 'roster', add });
      c.known = ids;
      if (c.events.length) {
        this.send(c, { t: 'ev', e: c.events });
        c.events = [];
      }
      if (slow && pickupsJson !== c.pickupsJson) {
        c.pickupsJson = pickupsJson;
        c.transport.send(`{"t":"pickups","items":${pickupsJson}}`, true);
      }
      if (world && worldJson !== c.worldJson) {
        c.worldJson = worldJson;
        this.send(c, world);
      }
      if (scores && scoresJson !== c.scoresJson) {
        c.scoresJson = scoresJson;
        c.transport.send(scoresJson, true);
      }
      const swap = this.pickups.swapCandidate(a.id)?.id ?? -1;
      const pos = a.move.pos;
      const vehicles = sim.vehicles.filter((v) => v.id === a.vehicle || Math.hypot(v.car.pos.x - pos.x, v.car.pos.z - pos.z) < VEHICLE_RANGE).map(netVehicle);
      const snap = encodeSnapshot({ tick: sim.tick, time: sim.time, ackCmd: c.ranSeq, actors, vehicles, me: privateState(a, swap), nades }, nadesJson);
      c.transport.send(snap, false);
    }
  }

  private worldState(): Extract<ServerMsg, { t: 'world' }> {
    return {
      t: 'world',
      cleared: [...this.sim.cleared],
      enc: (this.encounters?.summaries() ?? []).map((e) => ({ key: e.key, level: e.level, cleared: e.cleared, active: e.active })),
      doors: this.sim.doors.list(),
      glass: this.sim.glass.list(),
    };
  }

  private netGrenades(): NetGrenades {
    const g = this.sim.grenades;
    return {
      p: g.projectiles.map((p) => [p.id, p.kind, p.pos.x, p.pos.y, p.pos.z, p.restTime]),
      s: g.smokes.map((s) => [s.id, s.pos.x, s.pos.y, s.pos.z, s.start, s.end]),
      f: g.fires.map((f) => [f.id, f.pos.x, f.pos.y, f.pos.z, f.radius, f.start, f.end]),
    };
  }

  private send(c: Conn, msg: ServerMsg): void {
    c.transport.send(toJson(msg), true);
  }

  private sendAll(msg: ServerMsg): void {
    const json = toJson(msg);
    for (const c of this.conns) if (c.actor) c.transport.send(json, true);
  }

  dispose(): void {
    for (const c of [...this.conns]) c.transport.close();
    this.streamer.dispose();
  }
}

/** A command's angles must be real numbers (NaN would spread through the simulation). */
function validCmd(cmd: UserCmd): boolean {
  return Number.isFinite(cmd.yaw) && Number.isFinite(cmd.pitch) && Number.isFinite(cmd.attackYaw) && Number.isFinite(cmd.attackPitch);
}
