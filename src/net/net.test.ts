import { describe, expect, it } from 'vitest';
import { EncounterManager } from '../ai/EncounterManager';
import { CHUNK, TICK } from '../core/config';
import { sfc32 } from '../core/rng';
import { parseParams } from '../core/urlParams';
import { Buttons, makeCmd, type UserCmd } from '../input/UserCmd';
import { Contents, SOLID } from '../physics/brush';
import { makeActor, storePrev, Team, teleport } from '../sim/Actor';
import { eyeHeight } from '../player/pmove';
import { PickupManager } from '../sim/Pickups';
import { Simulation } from '../sim/Simulation';
import { chunkKey } from '../world/chunkMath';
import { BrushWriter } from '../world/gen/BrushWriter';
import { Material, type ChunkData } from '../world/gen/ChunkData';
import { bakeNav } from '../world/gen/navBake';
import { SyncChunkSource, WorldStreamer } from '../world/WorldStreamer';
import { WEAPONS } from '../weapons/weaponDefs';
import { Mirror } from './Mirror';
import { Prediction } from './Prediction';
import { NetClient } from './NetClient';
import { CarFlag, decodeCmds, decodeSnapshot, encodeCmds, encodeSnapshot, netActor, netVehicle } from './protocol';
import { makeVehicle } from '../sim/vehicle/Vehicle';
import { ServerGame } from './ServerGame';
import { LoopbackTransport } from './Transport';

/** Flat ground everywhere; chunk (1, 0) holds an encounter behind a wall. */
function flatChunk(seed: number, cx: number, cz: number): ChunkData {
  const w = new BrushWriter();
  w.box(0, -1, 0, 64, 0, 64, Material.Concrete, SOLID | Contents.FLOOR);
  const encounter = cx === 1 && cz === 0;
  if (encounter) w.box(0, 0, 30, 64, 4, 30.5, Material.Concrete, SOLID);
  if (cx === 0 && cz === -1) {
    // Climbing course: a 6 m block with a ladder on its -X wall, and a 1.9 m wall to mantle.
    w.box(20, 0, 10, 28, 6, 18, Material.Concrete, SOLID | Contents.FLOOR);
    w.ladder(2, 20, 14, 0, 6);
    w.box(20, 0, 30, 40, 1.9, 34, Material.Concrete, SOLID | Contents.FLOOR);
  }
  const brushes = w.finish();
  const nav = bakeNav(brushes);
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  return {
    cx,
    cz,
    key: chunkKey(cx, cz),
    seed,
    brushes,
    meshes: [],
    district: 0,
    level: 2,
    navCol: nav.col,
    navFloor: nav.floor,
    navFlags: nav.flags,
    navCover: nav.cover,
    navLinks: nav.links,
    spawns: encounter ? new Float32Array([ox + 20, 0.02, oz + 50, ox + 32, 0.02, oz + 50, ox + 44, 0.02, oz + 50]) : new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    pickups: new Float32Array(0),
    // A car parked east of the spawn point, facing -Z.
    vehicles: cx === 0 && cz === 0 ? new Float32Array([50, 0, 40, 0, 2, 0]) : new Float32Array(0),
    hasEncounter: encounter,
    genMs: 0,
  };
}

/** A client as the game runs it: connection, mirror sim, and the pieces the HUD reads. */
function joinClient(server: ServerGame, name: string) {
  const [a, b] = LoopbackTransport.pair();
  server.connect(b);
  const net = new NetClient(a, name, false);
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  const pickups = new PickupManager(sim);
  // The client builds the same city from the seed for its own collision (prediction).
  const streamer = new WorldStreamer(sim.world, new SyncChunkSource(7, flatChunk));
  streamer.addListener(sim.nav);
  const encounters = new EncounterManager(sim, streamer);
  let mirror: Mirror | null = null;
  let prediction: Prediction | null = null;
  let synced = false;
  const cmd = makeCmd();
  const chat: string[] = [];
  /** Predicted position after each command, by sequence number. */
  const predicted = new Map<number, [number, number, number]>();
  return {
    net,
    sim,
    link: a,
    hostLink: b,
    cmd,
    chat,
    predicted,
    get me() {
      return sim.getActor(net.actorId)!;
    },
    get prediction() {
      return prediction;
    },
    get mirror() {
      return mirror;
    },
    /** One frame at local time `now`: apply what arrived, then send and predict this tick's input. */
    frame(now: number) {
      if (!mirror && net.actorId >= 0) {
        sim.player.id = net.actorId;
        sim.player.name = name;
        mirror = new Mirror(sim, net.actorId, pickups, encounters, true);
        prediction = new Prediction(sim, sim.player);
      }
      let view = 0;
      streamer.update(sim.player.move.pos.x, sim.player.move.pos.z);
      streamer.apply(8, 8);
      if (prediction) prediction.active = streamer.isLoaded(sim.player.move.pos.x, sim.player.move.pos.z);
      if (mirror && prediction) {
        for (const m of net.takeMessages()) if (!mirror.applyMessage(m) && m.t === 'chat') chat.push(`${m.from}: ${m.text}`);
        const s = net.takeSnapshot();
        if (s) {
          const { x, y, z } = sim.player.move.pos;
          mirror.applySnapshot(s, now);
          prediction.reconcile(s.ackCmd, s.tick, s.time, x, y, z);
          synced = true;
        }
        view = mirror.renderTime(now);
        mirror.interpolate(view);
      }
      const seq = net.sendCmd(cmd, view);
      if (synced && prediction) {
        prediction.predict(seq, cmd);
        const p = sim.player.move.pos;
        predicted.set(seq, [p.x, p.y, p.z]);
      }
      cmd.pressed = 0;
    },
  };
}

type Client = ReturnType<typeof joinClient>;

let clock = 0;
function run(server: ServerGame, clients: Client[], ticks: number, each?: () => void) {
  for (let i = 0; i < ticks; i++) {
    clock += TICK;
    for (const c of clients) c.frame(clock);
    server.stream();
    server.tick();
    each?.();
  }
}

function makeServer(search = '?seed=7', maxPlayers?: number) {
  return new ServerGame(parseParams(search, 1), new SyncChunkSource(7, flatChunk), maxPlayers);
}

describe('wire format', () => {
  it('round-trips commands and snapshots', () => {
    const cmd: UserCmd = { ...makeCmd(), yaw: 1.5, pitch: -0.25, forward: 1, side: -1, buttons: Buttons.ATTACK | Buttons.DUCK, pressed: Buttons.ATTACK, weaponSelect: 3 };
    const back = decodeCmds(encodeCmds({ ackSnapshot: 42, viewTime: 12.25, cmds: [{ seq: 9, cmd }] }));
    expect(back.ackSnapshot).toBe(42);
    expect(back.viewTime).toBe(12.25);
    expect(back.cmds[0].seq).toBe(9);
    expect(back.cmds[0].cmd).toMatchObject({ forward: 1, side: -1, buttons: cmd.buttons, pressed: cmd.pressed, weaponSelect: 3 });
    expect(back.cmds[0].cmd.yaw).toBeCloseTo(1.5, 5);

    const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
    sim.player.move.pos.x = 12.5;
    sim.player.health = 73;
    const car = makeVehicle(3, 10.25, 0, -4, 1.25, 4, true);
    car.driver = sim.player.id;
    car.health = 321;
    car.car.steer = -0.5;
    const parked = makeVehicle(9, 0, 0, 0, 0, 0, false);
    const snap = decodeSnapshot(
      encodeSnapshot({
        tick: 100,
        time: 1.5,
        ackCmd: 7,
        actors: [netActor(sim.player)],
        vehicles: [netVehicle(car), netVehicle(parked)],
        me: null,
        nades: { p: [], s: [], f: [] },
      }),
    );
    expect(snap).toMatchObject({ tick: 100, time: 1.5, ackCmd: 7, me: null });
    expect(snap.actors[0]).toMatchObject({ id: sim.player.id, x: 12.5, health: 73, slot: 'secondary' });
    expect(snap.vehicles).toHaveLength(2);
    expect(snap.vehicles[0]).toMatchObject({ id: 3, paint: 4, driver: sim.player.id, health: 321, x: 10.25, flags: CarFlag.OnGround | CarFlag.Hatch });
    expect(snap.vehicles[0].yaw).toBeCloseTo(1.25, 5);
    expect(snap.vehicles[0].steer).toBeCloseTo(-0.5, 5);
    expect(snap.vehicles[1]).toMatchObject({ id: 9, driver: -1, flags: CarFlag.OnGround });
  });
});

describe('co-op over the network', () => {
  it('two clients join and see each other move', () => {
    const server = makeServer();
    const one = joinClient(server, 'Ann');
    const two = joinClient(server, 'Ann');
    run(server, [one, two], 64);
    expect(one.net.actorId).toBeGreaterThan(0);
    expect(two.net.actorId).not.toBe(one.net.actorId);
    // Same name twice gets a suffix.
    expect(server.sim.players.map((p) => p.name)).toEqual(['Ann', 'Ann 2']);
    expect(two.sim.players).toHaveLength(2);
    const annOnTwo = two.sim.getActor(one.net.actorId)!;
    expect(annOnTwo.name).toBe('Ann');
    expect(annOnTwo.alive).toBe(true);

    // Ann walks forward (-Z): the other client sees it.
    const start = annOnTwo.move.pos.z;
    one.cmd.forward = 1;
    run(server, [one, two], 64);
    expect(annOnTwo.move.pos.z).toBeLessThan(start - 2);
    // Ann's own screen runs ahead (prediction), the other one ~0.1 s behind (interpolation).
    const host = server.sim.getActor(one.net.actorId)!;
    expect(one.me.move.pos.z).toBeLessThanOrEqual(host.move.pos.z + 1e-6);
    expect(annOnTwo.move.pos.z).toBeGreaterThan(host.move.pos.z);
    expect(annOnTwo.move.pos.z - host.move.pos.z).toBeLessThan(1.5);
    expect(two.sim.time).toBeGreaterThan(1);
  });

  it('keeps moving through heavy packet loss', () => {
    const server = makeServer();
    const one = joinClient(server, 'Lossy');
    const r = sfc32(5);
    one.link.loss = 0.3;
    one.link.rand = r;
    run(server, [one], 32);
    one.cmd.forward = 1;
    const start = server.sim.players[0].move.pos.z;
    run(server, [one], 128);
    // 2 s of running at 250 u/s is about 12.7 m; redundancy covers most losses.
    expect(start - server.sim.players[0].move.pos.z).toBeGreaterThan(10);
  });

  it('buys through the host, spawns bots for everyone and forwards kills', () => {
    const server = makeServer();
    const one = joinClient(server, 'Buyer');
    run(server, [one], 32);
    const before = one.me.money;
    one.net.sendBuy('kevlar');
    run(server, [one], 4);
    expect(one.me.money).toBe(before - 650);
    expect(one.me.armor).toBe(100);

    // Walk towards the encounter chunk: its squad wakes up and shows up on the client, named.
    one.cmd.yaw = -Math.PI / 2; // face +X
    one.cmd.forward = 1;
    let kinds = new Set<string>();
    run(server, [one], 64 * 6, () => {
      for (const e of one.sim.events.drain()) kinds.add(e.type);
    });
    const bots = one.sim.actors.filter((a) => a.team === Team.Bots);
    expect(bots.length).toBeGreaterThan(0);
    expect(bots.every((b) => b.name !== '…')).toBe(true);
    expect(kinds.has('step')).toBe(true);
    const enc = server.encounters!.summaries().find((e) => e.key === chunkKey(1, 0));
    expect(enc?.active).toBe(true);

    // A clear on the host reaches the client's map and money.
    kinds = new Set();
    const money = one.me.money;
    // Squads can come in waves (spawn slots in view are skipped): keep killing until clear.
    for (let wave = 0; wave < 10 && !server.encounters!.isCleared(chunkKey(1, 0)); wave++) {
      for (const b of server.sim.actors.filter((a) => a.team === Team.Bots && a.alive)) {
        b.health = 1;
        b.armor = 0;
        server.sim.onHit({ attacker: server.sim.players[0], victim: b, def: b.inv.secondary!.def, group: 0, distance: 5, damageScale: 1, penetrated: false, pos: b.move.pos });
      }
      run(server, [one], 32, () => {
        for (const e of one.sim.events.drain()) kinds.add(e.type);
      });
    }
    expect(kinds.has('kill')).toBe(true);
    expect(kinds.has('chunkCleared')).toBe(true);
    expect(one.sim.cleared.has(chunkKey(1, 0))).toBe(true);
    expect(one.me.money).toBeGreaterThan(money);
  });

  it('removes players who leave and turns away a full game', () => {
    const server = makeServer('?seed=7', 2);
    const one = joinClient(server, 'A');
    const two = joinClient(server, 'B');
    const three = joinClient(server, 'C');
    run(server, [one, two, three], 16);
    expect(three.net.closedReason).toMatch(/full/);
    expect(one.sim.players).toHaveLength(2);
    two.net.close();
    run(server, [one], 16);
    expect(server.sim.players).toHaveLength(1);
    expect(one.sim.players).toHaveLength(1);
    const msgs = one.sim.events.drain().filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.text : ''));
    expect(msgs).toContain('B left the game');
  });

  it('relays chat', () => {
    const server = makeServer();
    const one = joinClient(server, 'A');
    const two = joinClient(server, 'B');
    run(server, [one, two], 8);
    one.net.sendChat('  hello there ');
    run(server, [one, two], 2);
    expect(two.chat).toEqual(['A: hello there']);
  });
});

describe('driving online', () => {
  it('drives a car: predicted exactly by its driver, seen by everyone else', () => {
    const server = makeServer();
    const one = joinClient(server, 'Driver');
    const two = joinClient(server, 'Watcher');
    run(server, [one, two], 48);
    const host = server.sim.getActor(one.net.actorId)!;
    teleport(host, 48.4, 0.05, 40);
    run(server, [one, two], 16);
    expect(one.me.move.pos.x).toBeCloseTo(48.4, 1);
    expect(one.sim.vehicles).toHaveLength(1);

    one.cmd.pressed = Buttons.USE;
    run(server, [one, two], 1);
    run(server, [one, two], 16);
    const car = server.sim.vehicles[0];
    expect(car.driver).toBe(host.id);
    expect(host.vehicle).toBe(car.id);
    expect(one.me.vehicle).toBe(car.id);

    one.prediction!.corrections = 0;
    const errors: number[] = [];
    let i = 0;
    run(server, [one, two], 256, () => {
      one.cmd.forward = i < 180 ? 1 : -1;
      one.cmd.side = i > 60 && i < 110 ? 0.6 : 0;
      one.cmd.buttons = i > 150 && i < 170 ? Buttons.JUMP : 0;
      i++;
      const mine = one.predicted.get(server['conns'][0].ranSeq);
      if (mine) errors.push(Math.hypot(mine[0] - host.move.pos.x, mine[1] - host.move.pos.y, mine[2] - host.move.pos.z));
    });
    expect(car.car.pos.z).toBeLessThan(25);
    expect(errors.length).toBeGreaterThan(200);
    expect(Math.max(...errors)).toBeLessThan(1e-3);
    expect(one.prediction!.corrections).toBe(0);

    // The other player sees the car driving (a little behind) with its driver in it.
    const seen = two.sim.getVehicle(car.id)!;
    expect(seen.driver).toBe(host.id);
    expect(two.sim.getActor(host.id)!.vehicle).toBe(car.id);
    expect(Math.hypot(seen.car.pos.x - car.car.pos.x, seen.car.pos.z - car.car.pos.z)).toBeLessThan(3);
    // It's solid on their side too.
    expect(two.sim.world.hasDynamic(car.id)).toBe(true);

    // Stop and get out.
    one.cmd.forward = 0;
    one.cmd.side = 0;
    one.cmd.buttons = Buttons.JUMP;
    run(server, [one, two], 192);
    one.cmd.buttons = 0;
    one.cmd.pressed = Buttons.USE;
    run(server, [one, two], 1);
    run(server, [one, two], 16);
    expect(host.vehicle).toBe(-1);
    expect(car.driver).toBe(-1);
    expect(one.me.vehicle).toBe(-1);
    expect(Math.hypot(one.me.move.pos.x - host.move.pos.x, one.me.move.pos.z - host.move.pos.z)).toBeLessThan(0.05);
  });
});

describe('prediction and lag compensation', () => {
  it('predicts its own movement exactly', () => {
    const server = makeServer();
    const one = joinClient(server, 'Runner');
    run(server, [one], 48);
    one.prediction!.corrections = 0;
    const p = server.sim.players[0];
    // Run, strafe, jump, crouch and turn: all predicted without corrections.
    const script = (i: number) => {
      one.cmd.forward = i % 90 < 60 ? 1 : -1;
      one.cmd.side = i % 50 < 25 ? 1 : 0;
      one.cmd.yaw = Math.sin(i / 40);
      one.cmd.buttons = (i % 70 < 5 ? Buttons.JUMP : 0) | (i % 120 > 100 ? Buttons.DUCK : 0);
      one.cmd.pressed = i % 70 === 0 ? Buttons.JUMP : 0;
    };
    let i = 0;
    const errors: number[] = [];
    run(server, [one], 256, () => {
      script(i++);
      // The host's position after the command it last ran vs. what the client predicted then.
      const mine = one.predicted.get(server['conns'][0].ranSeq);
      if (mine) errors.push(Math.hypot(mine[0] - p.move.pos.x, mine[1] - p.move.pos.y, mine[2] - p.move.pos.z));
    });
    expect(errors.length).toBeGreaterThan(200);
    expect(Math.max(...errors)).toBeLessThan(1e-3);
    expect(one.prediction!.corrections).toBe(0);
  });

  it('predicts through packet loss and reordering without corrections', () => {
    const server = makeServer();
    const one = joinClient(server, 'Lossy');
    one.link.reorder = 0.2;
    one.hostLink.reorder = 0.2;
    one.link.loss = 0.1;
    one.link.rand = sfc32(9);
    one.hostLink.loss = 0.1;
    one.hostLink.rand = sfc32(10);
    run(server, [one], 48);
    one.prediction!.corrections = 0;
    let i = 0;
    run(server, [one], 256, () => {
      i++;
      one.cmd.forward = i % 90 < 60 ? 1 : -1;
      one.cmd.side = i % 50 < 25 ? 1 : 0;
      one.cmd.yaw = Math.sin(i / 40);
    });
    expect(one.prediction!.corrections).toBe(0);
  });

  it('predicts ladder climbs and mantles without corrections', () => {
    const server = makeServer();
    const one = joinClient(server, 'Climber');
    run(server, [one], 48);
    const p = server.sim.players[0];
    const start = (x: number, z: number) => {
      teleport(p, x, 0.02, z);
      one.cmd.forward = 0;
      one.cmd.buttons = 0;
      one.cmd.yaw = -Math.PI / 2; // face +X
      run(server, [one], 64);
      one.prediction!.corrections = 0;
    };
    start(18.5, -50);
    one.cmd.forward = 1;
    let climbed = false;
    run(server, [one], 64 * 3, () => {
      climbed ||= one.me.move.onLadder;
      if (one.me.move.onGround && one.me.move.pos.y > 5) one.cmd.forward = 0;
    });
    expect(climbed).toBe(true);
    expect(p.move.pos.y).toBeCloseTo(6, 1);
    expect(one.prediction!.corrections).toBe(0);

    start(19.3, -32);
    one.cmd.forward = 1;
    one.cmd.buttons = Buttons.JUMP;
    one.cmd.pressed = Buttons.JUMP;
    let mantled = false;
    run(server, [one], 64 * 2, () => {
      mantled ||= one.me.move.mantleT > 0;
      if (one.me.move.onGround && one.me.move.pos.y > 1.5) one.cmd.forward = 0;
    });
    expect(mantled).toBe(true);
    expect(p.move.pos.y).toBeCloseTo(1.9, 1);
    expect(one.prediction!.corrections).toBe(0);
  });

  it("hits a moving target where the shooter saw it", () => {
    const server = makeServer();
    const shooter = joinClient(server, 'Shooter');
    run(server, [shooter], 64);
    const sp = server.sim.players[0];
    teleport(sp, 20, sp.move.pos.y, 22);
    // A bot 6 m away, running sideways at 6 m/s: 0.1 s of lag puts it 0.6 m (a body width) off.
    const bot = makeActor(server.sim.newActorId(), 'Runner', Team.Bots, 17, sp.move.pos.y, 16);
    bot.health = 1000;
    server.sim.addActor(bot);
    let dir = 1;
    const move = () => {
      storePrev(bot);
      bot.move.pos.x += dir * 6 * TICK;
      bot.move.vel.x = dir * 6;
      if (bot.move.pos.x > 23 || bot.move.pos.x < 17) dir = -dir;
    };
    run(server, [shooter], 32, move);
    let i = 0;
    let naive = 0;
    run(server, [shooter], 40, () => {
      move();
      i++;
      // Aim at the chest of the bot as drawn on the shooter's screen.
      const seen = shooter.sim.getActor(bot.id)!;
      const me = shooter.me;
      const dx = seen.move.pos.x - me.move.pos.x;
      const dz = seen.move.pos.z - me.move.pos.z;
      const dy = seen.move.pos.y + 1.2 - (me.move.pos.y + eyeHeight(me.move));
      shooter.cmd.yaw = shooter.cmd.attackYaw = Math.atan2(-dx, -dz);
      shooter.cmd.pitch = shooter.cmd.attackPitch = Math.atan2(dy, Math.hypot(dx, dz));
      if (i === 20) {
        shooter.cmd.buttons = Buttons.ATTACK;
        shooter.cmd.pressed = Buttons.ATTACK;
        naive = Math.abs(seen.move.pos.x - bot.move.pos.x);
      } else shooter.cmd.buttons = 0;
    });
    // Without rewinding, the shot would have gone where the bot no longer was.
    expect(naive).toBeGreaterThan(0.5);
    expect(sp.wpn.shotCounter).toBe(1);
    expect(bot.health).toBeLessThan(1000);
  });
});

describe('co-op saves', () => {
  it('the host saves shared progress and continues it later', () => {
    const server = makeServer();
    const host = joinClient(server, 'Host');
    const guest = joinClient(server, 'Guest');
    run(server, [host, guest], 48);
    const hp = server.sim.players[0];
    hp.money = 4321;
    hp.inv.primary = { def: WEAPONS.ak47, clip: 12, reserve: 60 };
    teleport(hp, 40, hp.move.pos.y, 40);
    server.sim.cleared.add(chunkKey(1, 0));
    run(server, [host, guest], 8);
    const save = server.save([chunkKey(0, 0)], true);
    if (typeof save === 'string') throw new Error(save);
    expect(save).toMatchObject({ money: 4321, cleared: [chunkKey(1, 0)], explored: [chunkKey(0, 0)] });
    expect(save.player).toMatchObject({ x: 40, z: 40, primary: { id: 'ak47', clip: 12, reserve: 60 } });

    // A new session from the save: the host is back where they were, the guest starts fresh.
    const next = new ServerGame(parseParams('?seed=7', 1), new SyncChunkSource(7, flatChunk), undefined, JSON.parse(JSON.stringify(save)));
    const host2 = joinClient(next, 'Host');
    const guest2 = joinClient(next, 'Guest');
    run(next, [host2, guest2], 48);
    const [h, g] = next.sim.players;
    expect(h.money).toBe(4321);
    expect(h.inv.primary).toMatchObject({ clip: 12, reserve: 60 });
    expect(Math.hypot(h.move.pos.x - 40, h.move.pos.z - 40)).toBeLessThan(0.5);
    expect(g.money).toBe(800);
    expect(g.inv.primary).toBeNull();
    expect(next.sim.cleared.has(chunkKey(1, 0))).toBe(true);
    expect(host2.sim.cleared.has(chunkKey(1, 0))).toBe(true);
  });
});
