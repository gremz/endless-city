import { describe, expect, it } from 'vitest';
import { HitGroup } from '../ai/hitboxes';
import { HU, TICK } from '../core/config';
import { DEG } from '../core/math';
import { sfc32 } from '../core/rng';
import { parseParams } from '../core/urlParams';
import { Buttons, makeCmd } from '../input/UserCmd';
import { makeBrush, SOLID } from '../physics/brush';
import { eyeHeight } from '../player/pmove';
import { teleport } from '../sim/Actor';
import { armorDamage, bulletDamage, rangeDamage } from '../sim/damage';
import { Simulation } from '../sim/Simulation';
import { inaccuracy, moveFraction, sampleSpread } from './inaccuracy';
import { giveWeapon } from './Inventory';
import { getPattern } from './sprayPatterns';
import { WEAPONS } from './weaponDefs';

function makeSim() {
  const sim = new Simulation(parseParams('', 1), { autoBhop: false }, TICK);
  sim.world.addChunk(1, [makeBrush(-200, -1, -200, 200, 0, 200, SOLID)]);
  teleport(sim.player, 0, 0.01, 0);
  for (let i = 0; i < 8; i++) sim.step(makeCmd());
  return sim;
}

function equip(sim: Simulation, id: 'ak47' | 'awp' | 'glock' | 'deagle') {
  giveWeapon(sim.player.inv, id);
  sim.player.inv.active = WEAPONS[id].slot;
  sim.player.wpn.deployEnd = 0;
  sim.player.wpn.nextAttack = 0;
}

describe('inaccuracy', () => {
  const ak = WEAPONS.ak47;
  const base = { onGround: true, ducked: false, scoped: false, fireInacc: 0 };

  it('orders crouch < stand < walk-speed < running < air', () => {
    const crouch = inaccuracy(ak, { ...base, speed: 0, ducked: true });
    const stand = inaccuracy(ak, { ...base, speed: 0 });
    const walk = inaccuracy(ak, { ...base, speed: ak.maxSpeed * 0.6 });
    const run = inaccuracy(ak, { ...base, speed: ak.maxSpeed });
    const air = inaccuracy(ak, { ...base, speed: 0, onGround: false });
    expect(crouch).toBeLessThan(stand);
    expect(stand).toBeLessThan(walk);
    expect(walk).toBeLessThan(run);
    expect(stand).toBeLessThan(air);
  });

  it('is unaffected by movement below 34% of max speed', () => {
    expect(moveFraction(ak, ak.maxSpeed * 0.33)).toBe(0);
    expect(moveFraction(ak, ak.maxSpeed * 0.35)).toBeGreaterThan(0);
    expect(moveFraction(ak, ak.maxSpeed)).toBeCloseTo(1, 5);
  });

  it('spread sampling is deterministic for the same seed', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    sampleSpread(sfc32(9), 10, 1, a);
    sampleSpread(sfc32(9), 10, 1, b);
    expect(a).toEqual(b);
    expect(Math.hypot(a.x, a.y)).toBeLessThanOrEqual(0.011 + 1e-9);
  });
});

describe('damage', () => {
  it('AK: 111 to a helmeted head, 27 to a Kevlar chest, 144 to a bare head', () => {
    expect(bulletDamage(36, 1, 0, HitGroup.Head, 0.775, 100, true).health).toBe(111);
    expect(bulletDamage(36, 1, 0, HitGroup.Chest, 0.775, 100, false).health).toBe(27);
    expect(bulletDamage(36, 1, 0, HitGroup.Head, 0.775, 100, false).health).toBe(144);
  });

  it('armor overflow goes to health', () => {
    const r = armorDamage(100, HitGroup.Chest, 0.5, 5, false);
    expect(r.armor).toBe(5);
    expect(r.health).toBe(90);
  });

  it('range falloff', () => {
    expect(rangeDamage(36, 0.98, 12.7)).toBeCloseTo(36 * 0.98, 5);
    expect(rangeDamage(36, 0.98, 0)).toBe(36);
  });
});

describe('firing', () => {
  it('AK fires 10 rounds per second at 64 tick and empties 30 rounds in ~2.9 s', () => {
    const sim = makeSim();
    equip(sim, 'ak47');
    const cmd = makeCmd();
    cmd.buttons = Buttons.ATTACK;
    cmd.pressed = Buttons.ATTACK;
    const item = sim.player.inv.primary!;
    let lastShotTick = 0;
    for (let i = 0; i < 64 * 4; i++) {
      const before = item.clip;
      sim.step(cmd);
      cmd.pressed = 0;
      if (item.clip < before) lastShotTick = i;
      if (i === 63) expect(30 - item.clip).toBeGreaterThanOrEqual(10);
      if (i === 63) expect(30 - item.clip).toBeLessThanOrEqual(11);
    }
    expect(item.clip).toBe(0);
    expect(lastShotTick * TICK).toBeGreaterThan(2.8);
    expect(lastShotTick * TICK).toBeLessThan(3.0);
  });

  it('semi-auto pistols need a trigger release per shot', () => {
    const sim = makeSim();
    equip(sim, 'glock');
    const cmd = makeCmd();
    cmd.buttons = Buttons.ATTACK;
    cmd.pressed = Buttons.ATTACK;
    const item = sim.player.inv.secondary!;
    for (let i = 0; i < 64; i++) {
      sim.step(cmd);
      cmd.pressed = 0;
    }
    expect(item.clip).toBe(19);
  });

  it('reload takes the weapon reload time and refills the clip', () => {
    const sim = makeSim();
    equip(sim, 'ak47');
    const item = sim.player.inv.primary!;
    item.clip = 5;
    const cmd = makeCmd();
    cmd.pressed = Buttons.RELOAD;
    sim.step(cmd);
    cmd.pressed = 0;
    let ticks = 0;
    while (item.clip === 5 && ticks < 1000) {
      sim.step(cmd);
      ticks++;
    }
    expect(item.clip).toBe(30);
    expect(item.reserve).toBe(65);
    expect(ticks * TICK).toBeCloseTo(WEAPONS.ak47.reloadTime, 1);
  });

  it('with zero spread, spray shot n lands on pattern[n]', () => {
    const sim = makeSim();
    equip(sim, 'ak47');
    // A wall 10 m in front (-Z), no spread: recover angles from impact points.
    sim.world.addChunk(2, [makeBrush(-50, 0, -10.5, 50, 30, -10, SOLID)]);
    const ak = WEAPONS.ak47;
    const saved = { ...ak };
    Object.assign(ak, { spread: 0, inaccStand: 0, inaccFire: 0, inaccMove: 0 });
    try {
      const cmd = makeCmd();
      cmd.buttons = Buttons.ATTACK;
      const impacts: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < 64 * 3 && impacts.length < 30; i++) {
        sim.step(cmd);
        for (const e of sim.events.drain()) if (e.type === 'impact') impacts.push(e.pos);
      }
      const pat = getPattern('ak');
      const eyeY = sim.player.move.pos.y + eyeHeight(sim.player.move);
      for (let n = 0; n < 30; n++) {
        const p = impacts[n];
        const dist = Math.abs(p.z - sim.player.move.pos.z);
        const pitch = Math.atan2(p.y - eyeY, dist) / DEG;
        const yaw = Math.atan2(-p.x + sim.player.move.pos.x, dist) / DEG;
        expect(pitch).toBeCloseTo(pat.pitch[n], 1);
        expect(yaw).toBeCloseTo(pat.yaw[n], 1);
      }
    } finally {
      Object.assign(ak, saved);
    }
  });

  it('a standing first shot hits a head at 20 m at least 95% of the time', () => {
    const sim = makeSim();
    equip(sim, 'ak47');
    const dummy = sim.spawnDummy(0, 0.01, -20, 0);
    for (let i = 0; i < 16; i++) sim.step(makeCmd());
    const eyeY = sim.player.move.pos.y + eyeHeight(sim.player.move);
    const headY = dummy.move.pos.y + 1.66;
    const pitch = Math.atan2(headY - eyeY, 20);
    let heads = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      // Wait for full recovery between taps.
      const idle = makeCmd();
      idle.pitch = pitch;
      for (let k = 0; k < 40; k++) sim.step(idle);
      sim.events.drain();
      dummy.health = 100;
      dummy.alive = true;
      const cmd = makeCmd();
      cmd.pitch = cmd.attackPitch = pitch;
      cmd.buttons = cmd.pressed = Buttons.ATTACK;
      sim.step(cmd);
      for (const e of sim.events.drain()) if (e.type === 'hit' && e.group === HitGroup.Head) heads++;
      sim.player.inv.primary!.clip = 30;
    }
    expect(heads / N).toBeGreaterThanOrEqual(0.95);
  });

  it('running shots scatter far more than standing shots', () => {
    const ak = WEAPONS.ak47;
    const run = inaccuracy(ak, { speed: 215 * HU, onGround: true, ducked: false, scoped: false, fireInacc: 0 });
    const stand = inaccuracy(ak, { speed: 0, onGround: true, ducked: false, scoped: false, fireInacc: 0 });
    expect(run / stand).toBeGreaterThan(20);
  });

  it('bullets penetrate thin penetrable walls with reduced damage', async () => {
    const { Contents } = await import('../physics/brush');
    const sim = makeSim();
    equip(sim, 'ak47');
    sim.world.addChunk(3, [makeBrush(-2, 0, -5.1, 2, 3, -5, SOLID | Contents.PENETRABLE)]);
    const dummy = sim.spawnDummy(0, 0.01, -8, 0);
    for (let i = 0; i < 16; i++) sim.step(makeCmd());
    const cmd = makeCmd();
    cmd.buttons = cmd.pressed = Buttons.ATTACK;
    cmd.pitch = cmd.attackPitch = Math.atan2(1.275 - eyeHeight(sim.player.move), 8);
    sim.step(cmd);
    const hits = sim.events.drain().filter((e) => e.type === 'hit');
    expect(hits.length).toBe(1);
    const h = hits[0];
    if (h.type === 'hit') {
      expect(h.victimId).toBe(dummy.id);
      expect(h.damage).toBeLessThan(36);
      expect(h.damage).toBeGreaterThan(5);
    }
  });
});
