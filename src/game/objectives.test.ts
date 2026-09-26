import { describe, expect, it } from 'vitest';
import { makeActor, Team } from '../sim/Actor';
import { makeInventory } from '../weapons/Inventory';
import { BRIEFING, Objectives, Tips, type ObjectiveContext, type TipId } from './Objectives';

const at = (x: number, z: number) => ({ x, y: 0, z });

function context(over: Partial<ObjectiveContext> = {}): ObjectiveContext {
  const player = makeActor(1, 'Me', Team.Player, 0, 0, 0);
  player.money = 800;
  return {
    now: 0,
    player,
    inBuyZone: false,
    inCombat: false,
    openingCleared: false,
    captive: null,
    openingBots: [at(0, 40), at(4, 40)],
    openingCenter: at(32, 96),
    mp9: null,
    car: at(10, -20),
    nextArea: { pos: at(100, 150), level: 1 },
    ...over,
  };
}

describe('objectives', () => {
  it('walks through the opening, then stops after the next area is cleared, an upgrade and the briefing', () => {
    const o = new Objectives('ambush');
    const c = context();
    let v = o.update(c)!;
    expect(o.step).toBe('ambush');
    expect(v.target).toMatchObject({ x: 2, z: 40 });

    c.openingCleared = true;
    c.openingBots = [];
    c.mp9 = at(3, 41);
    v = o.update(c)!;
    expect(o.step).toBe('loot');
    expect(v.title).toMatch(/MP9/);
    expect(v.target).toBe(c.mp9);

    // Picked up, but still holding the pistol.
    c.player.inv = makeInventory('glock', 'mp9');
    c.player.inv.active = 'secondary';
    v = o.update(c)!;
    expect(o.step).toBe('loot');
    expect(v.title).toBe('Switch to the MP9');
    c.player.inv.active = 'primary';
    v = o.update(c)!;
    expect(o.step).toBe('car');
    expect(v.target).toBe(c.car);

    c.player.vehicle = 3;
    v = o.update(c)!;
    expect(o.step).toBe('hunt');
    expect(v.sub).toMatch(/\+\$700/);
    expect(v.target).toBe(c.nextArea!.pos);

    // Cleared it: nothing shows while the fight dies down, then the upgrade in the new buy zone.
    o.onEvent({ type: 'chunkCleared', chunkKey: 5, bonus: 700, level: 1 }, 1);
    c.player.vehicle = -1;
    c.player.money = 1500;
    c.now = 5;
    expect(o.update(c)).toBeNull();
    c.inBuyZone = true;
    c.now = 10;
    v = o.update(c)!;
    expect(o.step).toBe('upgrade');
    expect(v.highlight).toBe('kevlar');
    expect(v.title).toMatch(/Kevlar/);

    // Buying brings up the briefing: one card at a time, with a pause between, held during fights.
    o.onEvent({ type: 'buy', actorId: 1, item: 'kevlar', ok: true }, 1);
    expect(o.step).toBe('briefing');
    c.player.armor = 100;
    v = o.update(c)!;
    expect(v.kicker).toBe('How the city works · 1/5');
    expect(v.title).toBe('Clear areas to take the city');
    c.inCombat = true;
    c.now = 60;
    expect(o.update(c)).toBeNull();
    c.inCombat = false;
    c.now = 70;
    expect(o.update(c)?.kicker).toMatch(/1\/5/);
    // Step through at frame-ish rate, noting what shows.
    const seen: string[] = [];
    let gaps = 0;
    let last: string | null = 'x';
    for (let t = 70; t < 130; t += 0.25) {
      c.now = t;
      const card = o.update(c);
      const title = card?.title ?? null;
      if (title && title !== last) seen.push(title);
      if (!title && last) gaps++;
      last = title;
    }
    expect(seen).toEqual(BRIEFING.map((b) => b.title));
    expect(gaps).toBe(BRIEFING.length);
    expect(o.step).toBe('done');
    c.player.money = 5000;
    expect(o.update(c)).toBeNull();
    o.onEvent({ type: 'chunkCleared', chunkKey: 6, bonus: 700, level: 1 }, 1);
    expect(o.update(c)).toBeNull();
  });

  it('points at the captured officer with a countdown, then says if they shot him', () => {
    const o = new Objectives('ambush');
    const c = context({ captive: at(2, 42) });
    // No hostage event yet (an old save, or no room for him): the plain ambush line.
    expect(o.update(c)!.title).toMatch(/Two gang members/);
    // Held, before the fuse is lit: no clock yet.
    o.onEvent({ type: 'captive', actorId: 9, phase: 'held', executeAt: -1 }, 1);
    let v = o.update(c)!;
    expect(v.title).toMatch(/execute a captured officer/);
    expect(v.target).toBe(c.captive);
    expect(v.sub).not.toMatch(/0:/);
    o.onEvent({ type: 'captive', actorId: 9, phase: 'held', executeAt: 40 }, 1);
    c.now = 3;
    v = o.update(c)!;
    expect(v.sub).toMatch(/0:37/);
    expect(v.urgent).toBe(false);
    c.now = 30.5;
    v = o.update(c)!;
    expect(v.sub).toMatch(/0:10.*gunman/);
    expect(v.urgent).toBe(true);
    o.onEvent({ type: 'captive', actorId: 9, phase: 'executed', executeAt: 40 }, 1);
    c.captive = null;
    v = o.update(c)!;
    expect(v.title).toBe('They killed the officer');
    expect(v.target).toMatchObject({ x: 2, z: 40 });
    expect(v.urgent).toBeFalsy();
  });

  it('moves on to the MP9 once the officer is freed', () => {
    const o = new Objectives('ambush');
    const c = context({ captive: at(2, 42) });
    o.onEvent({ type: 'captive', actorId: 9, phase: 'freed', executeAt: 40 }, 1);
    c.openingCleared = true;
    c.openingBots = [];
    c.mp9 = at(3, 41);
    o.update(c);
    expect(o.step).toBe('loot');
  });

  it('skips steps with nothing to point at, and ends without an upgrade if there is nothing to buy', () => {
    const o = new Objectives('ambush');
    const c = context({ openingCleared: true, openingBots: [], car: null });
    o.update(c);
    // No MP9 around, no car: on to the next area.
    expect(o.step).toBe('hunt');
    o.onEvent({ type: 'chunkCleared', chunkKey: 5, bonus: 700, level: 1 }, 1);
    c.player.money = 100;
    c.inBuyZone = true;
    // Nothing to buy: straight to the briefing once out of the fight.
    c.now = 1;
    expect(o.update(c)!.title).toBe(BRIEFING[0].title);
    expect(o.step).toBe('briefing');
  });

  it('a clear before getting in a car still ends the tour, and the upgrade prompt times out', () => {
    const o = new Objectives('car');
    o.onEvent({ type: 'chunkCleared', chunkKey: 5, bonus: 700, level: 1 }, 1);
    expect(o.step).toBe('wrapup');
    // A save taken now comes back at the same point.
    const loaded = new Objectives(o.saved);
    const c = context({ inBuyZone: true });
    c.player.money = 1000;
    c.now = 100;
    loaded.update(c);
    expect(loaded.step).toBe('upgrade');
    c.now = 150;
    loaded.update(c);
    expect(loaded.step).toBe('briefing');
  });
});

describe('tips', () => {
  it('shows each tip once and remembers it', () => {
    let stored: TipId[] = [];
    const tips = new Tips(new Set(['ladder']), (s) => (stored = [...s]));
    expect(tips.check({ door: null, nearLadder: true })).toBeNull();
    expect(tips.check({ door: { locked: false }, nearLadder: false })).toMatch(/Doors/);
    expect(tips.check({ door: { locked: false }, nearLadder: false })).toBeNull();
    expect(tips.check({ door: { locked: true }, nearLadder: false })).toMatch(/Locked/);
    expect(stored.sort()).toEqual(['door', 'ladder', 'locked']);
  });
});
