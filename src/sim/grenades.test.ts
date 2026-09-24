import { describe, expect, it } from 'vitest';
import { TICK } from '../core/config';
import { DEG, vec3 } from '../core/math';
import { parseParams } from '../core/urlParams';
import { Buttons, makeCmd } from '../input/UserCmd';
import { makeBrush, SOLID } from '../physics/brush';
import { eyeHeight } from '../player/pmove';
import { addGrenades, grenadeTotal } from '../weapons/Inventory';
import { makeActor, Team, teleport, type Actor } from './Actor';
import { buy, priceOf, unavailableReason } from './buy';
import { FIRE_DURATION, flashAmount, HE_RADIUS, simulateThrow, SMOKE_DURATION, throwOrigin, throwVelocity } from './Grenades';
import { Simulation } from './Simulation';

type Box = [number, number, number, number, number, number];

function makeSim(boxes: Box[] = []) {
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(1, [makeBrush(-200, -1, -200, 200, 0, 200, SOLID), ...boxes.map((b) => makeBrush(...b, SOLID))]);
  teleport(sim.player, 0, 0.01, 0);
  for (let i = 0; i < 8; i++) sim.step(makeCmd());
  return sim;
}

function run(sim: Simulation, seconds: number) {
  const cmd = makeCmd();
  for (let i = 0; i < Math.round(seconds / TICK); i++) sim.step(cmd);
}

/** A standing bot-team actor that isn't a range dummy (so flashes and fires affect it). */
function target(sim: Simulation, x: number, z: number, yaw = 0): Actor {
  const a = makeActor(sim.newActorId(), 'target', Team.Bots, x, 0.01, z);
  a.yaw = a.prevYaw = yaw;
  sim.addActor(a);
  return a;
}

describe('throwing', () => {
  it('pulls the pin on press and throws on release, using up the grenade', () => {
    const sim = makeSim();
    const p = sim.player;
    addGrenades(p.inv, 'hegrenade', 1);
    const sel = makeCmd();
    sel.weaponSelect = 4;
    sim.step(sel);
    expect(p.inv.active).toBe('grenade');
    run(sim, 1);
    const hold = makeCmd();
    hold.buttons = hold.pressed = Buttons.ATTACK;
    sim.step(hold);
    hold.pressed = 0;
    for (let i = 0; i < 10; i++) sim.step(hold);
    expect(p.wpn.pinPulled).toBe(true);
    expect(sim.grenades.projectiles).toHaveLength(0);
    sim.events.drain();
    sim.step(makeCmd());
    expect(sim.grenades.projectiles).toHaveLength(1);
    expect(sim.events.drain().some((e) => e.type === 'nade_throw')).toBe(true);
    expect(p.inv.nades.hegrenade).toBe(0);
    // Out of grenades: back to the gun.
    expect(p.inv.active).not.toBe('grenade');
  });

  it('pressing 4 again cycles grenade types', () => {
    const sim = makeSim();
    const p = sim.player;
    addGrenades(p.inv, 'flashbang', 2);
    addGrenades(p.inv, 'smokegrenade', 1);
    const sel = makeCmd();
    sel.weaponSelect = 4;
    sim.step(sel);
    const first = p.inv.nadeSel;
    sim.step(sel);
    expect(p.inv.nadeSel).not.toBe(first);
    expect(p.inv.grenade?.def.id).toBe(p.inv.nadeSel);
  });

  it('flies deterministically and matches the offline prediction', () => {
    const land = () => {
      const sim = makeSim();
      sim.grenades.throw(sim.player, 'hegrenade', 1, 0.3, 20 * DEG);
      let last = vec3();
      sim.events.drain();
      for (let i = 0; i < 200; i++) {
        sim.step(makeCmd());
        const boom = sim.events.drain().find((e) => e.type === 'nade_detonate');
        if (boom && boom.type === 'nade_detonate') return boom.pos;
        if (sim.grenades.projectiles[0]) last = { ...sim.grenades.projectiles[0].pos };
      }
      return last;
    };
    const a = land();
    const b = land();
    expect(a).toEqual(b);

    const sim = makeSim();
    const p = sim.player;
    const start = throwOrigin(sim.world, vec3(p.move.pos.x, p.move.pos.y + eyeHeight(p.move), p.move.pos.z), 0.3, 20 * DEG, vec3());
    const vel = throwVelocity(0.3, 20 * DEG, 1, p.move.vel, vec3());
    const pred = simulateThrow(sim.world, 'hegrenade', start, vel, TICK);
    // The live grenade is stepped once per tick after the throw tick, so it lands at the same spot.
    expect(Math.hypot(pred.pos.x - a.x, pred.pos.z - a.z)).toBeLessThan(0.5);
    expect(Math.hypot(a.x, a.z)).toBeGreaterThan(8);
  });

  it('bounces off walls instead of passing through', () => {
    // Wall 6 m ahead (yaw 0 faces -Z).
    const sim = makeSim([[-10, 0, -6.4, 10, 5, -6]]);
    sim.grenades.throw(sim.player, 'smokegrenade', 1, 0, 5 * DEG);
    let minZ = 0;
    for (let i = 0; i < 64 * 5 && sim.grenades.projectiles.length; i++) {
      sim.step(makeCmd());
      for (const g of sim.grenades.projectiles) minZ = Math.min(minZ, g.pos.z);
    }
    expect(minZ).toBeGreaterThan(-6);
    // It came back off the wall, came to rest and popped.
    expect(sim.grenades.smokes).toHaveLength(1);
    expect(sim.grenades.smokes[0].pos.z).toBeGreaterThan(-6);
  });
});

describe('detonations', () => {
  it('HE damages by distance and is blocked by walls', () => {
    const sim = makeSim([[4, 0, -1, 4.3, 3, 1]]);
    const near = target(sim, -2, 0);
    const far = target(sim, -6, 0);
    const behind = target(sim, 6, 0);
    const g = sim.grenades.throw(sim.player, 'hegrenade', 1, 0, 0);
    // Place it on the floor at the origin, beside the player.
    g.pos.x = 0;
    g.pos.y = 0.05;
    g.pos.z = 0;
    g.vel.x = g.vel.y = g.vel.z = 0;
    run(sim, 2);
    expect(near.health).toBeLessThan(far.health);
    expect(far.health).toBeLessThan(100);
    expect(behind.health).toBe(100);
    // The thrower isn't hurt by their own grenade.
    expect(sim.player.health).toBe(100);
    expect(6).toBeLessThan(HE_RADIUS);
  });

  it('flashes blind longer when you look at them', () => {
    const sim = makeSim();
    // The flash goes off at z = -5. Yaw 0 looks toward -Z.
    const looking = target(sim, -1, 0, 0);
    const away = target(sim, 1, 0, Math.PI);
    const g = sim.grenades.throw(sim.player, 'flashbang', 1, 0, 0);
    g.pos.x = 0;
    g.pos.y = 1.5;
    g.pos.z = -5;
    g.vel.x = g.vel.y = g.vel.z = 0;
    g.restTime = 0;
    run(sim, 1.7);
    expect(looking.flashUntil - looking.flashStart).toBeGreaterThan(away.flashUntil - away.flashStart);
    expect(flashAmount(looking, sim.time)).toBeGreaterThan(0.5);
    run(sim, 5);
    expect(flashAmount(looking, sim.time)).toBe(0);
  });

  it('smoke blocks sight through it, not beside it, and clears', () => {
    const sim = makeSim();
    const g = sim.grenades.throw(sim.player, 'smokegrenade', 0.4, 0, -60 * DEG);
    run(sim, 3);
    expect(sim.grenades.smokes).toHaveLength(1);
    const s = sim.grenades.smokes[0].pos;
    expect(g).toBeTruthy();
    run(sim, 1.5);
    expect(sim.grenades.blocksSight(vec3(s.x - 10, 1.5, s.z), vec3(s.x + 10, 1.5, s.z))).toBe(true);
    expect(sim.grenades.blocksSight(vec3(s.x - 10, 1.5, s.z + 6), vec3(s.x + 10, 1.5, s.z + 6))).toBe(false);
    // Looking out from inside the cloud.
    expect(sim.grenades.blocksSight(vec3(s.x, 1.5, s.z), vec3(s.x + 20, 1.5, s.z))).toBe(true);
    run(sim, SMOKE_DURATION);
    expect(sim.grenades.smokes).toHaveLength(0);
    expect(sim.grenades.blocksSight(vec3(s.x - 10, 1.5, s.z), vec3(s.x + 10, 1.5, s.z))).toBe(false);
  });

  it('molotov burns whoever stands in it, and a smoke puts it out', () => {
    const sim = makeSim();
    // Thrown down at the feet of a target 3 m ahead.
    const t = target(sim, 0, -3);
    t.armor = 100;
    sim.grenades.throw(sim.player, 'molotov', 0.4, 0, -45 * DEG);
    run(sim, 1);
    expect(sim.grenades.fires).toHaveLength(1);
    run(sim, 1);
    expect(t.health).toBeLessThan(100);
    // Armor doesn't help against fire.
    expect(t.armor).toBe(100);
    const f = sim.grenades.fires[0].pos;
    const s = sim.grenades.throw(sim.player, 'smokegrenade', 1, 0, 0);
    s.pos.x = f.x;
    s.pos.y = f.y + 0.05;
    s.pos.z = f.z;
    s.vel.x = s.vel.y = s.vel.z = 0;
    run(sim, 1);
    expect(sim.grenades.fires).toHaveLength(0);
    expect(FIRE_DURATION).toBeGreaterThan(2);
  });

  it('molotov that never hits the floor bursts in the air without fire', () => {
    const sim = makeSim();
    // Straight up: its 2 s fuse runs out before it comes down.
    sim.grenades.throw(sim.player, 'molotov', 1, 0, 89 * DEG);
    sim.events.drain();
    run(sim, 2.2);
    const ev = sim.events.drain().find((e) => e.type === 'nade_detonate');
    expect(ev && ev.type === 'nade_detonate' && ev.airburst).toBe(true);
    expect(sim.grenades.fires).toHaveLength(0);
  });
});

describe('buying grenades', () => {
  function shop() {
    const sim = makeSim();
    sim.time = 100;
    sim.economy.money = 10000;
    return sim;
  }

  it('caps each type and the total', () => {
    const sim = shop();
    expect(priceOf(sim, 'hegrenade')).toBe(300);
    expect(buy(sim, 'hegrenade', false)).toBe(true);
    expect(unavailableReason(sim, 'hegrenade')).toBe('Already owned');
    expect(buy(sim, 'flashbang', false)).toBe(true);
    expect(buy(sim, 'flashbang', false)).toBe(true);
    expect(unavailableReason(sim, 'flashbang')).toMatch(/Carrying 2/);
    expect(buy(sim, 'smokegrenade', false)).toBe(true);
    expect(grenadeTotal(sim.player.inv)).toBe(4);
    expect(unavailableReason(sim, 'molotov')).toMatch(/Grenades full/);
    expect(buy(sim, 'molotov', false)).toBe(false);
    // Buying doesn't pull out the grenade.
    expect(sim.player.inv.active).toBe('secondary');
  });

  it('are lost on death with the rest of the loadout', () => {
    const sim = shop();
    buy(sim, 'hegrenade', false);
    sim.resetLoadout(sim.player);
    expect(grenadeTotal(sim.player.inv)).toBe(0);
    expect(sim.player.inv.grenade).toBeNull();
  });
});
