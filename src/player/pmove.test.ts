import { describe, expect, it } from 'vitest';
import { HU, TICK } from '../core/config';
import { length2D } from '../core/math';
import { Buttons, makeCmd, type UserCmd } from '../input/UserCmd';
import { Contents, Ramp } from '../physics/brush';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { FLOOR, worldFrom } from '../physics/testUtil';
import { makeMoveState, playerMove, type MoveState } from './pmove';

const toHU = (m: number) => m / HU;

function settle(s: MoveState, w: CollisionWorld) {
  const c = makeCmd();
  for (let i = 0; i < 16; i++) playerMove(s, c, w, TICK);
}

function run(s: MoveState, w: CollisionWorld, cmd: UserCmd, ticks: number, each?: (i: number) => void) {
  for (let i = 0; i < ticks; i++) {
    playerMove(s, cmd, w, TICK);
    cmd.pressed = 0;
    each?.(i);
  }
}

describe('pmove ground movement', () => {
  const w = worldFrom([FLOOR]);

  it('reaches but never exceeds 250 HU/s running', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    expect(s.onGround).toBe(true);
    const cmd = makeCmd();
    cmd.forward = 1;
    let max = 0;
    run(s, w, cmd, 192, () => (max = Math.max(max, toHU(length2D(s.vel)))));
    expect(toHU(length2D(s.vel))).toBeCloseTo(250, 0);
    expect(max).toBeLessThanOrEqual(250.001);
  });

  it('diagonal is not faster', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.forward = 1;
    cmd.side = 1;
    run(s, w, cmd, 192);
    expect(toHU(length2D(s.vel))).toBeLessThanOrEqual(250.001);
  });

  it('walks at 130 and crouch-walks at 85', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.forward = 1;
    cmd.buttons = Buttons.WALK;
    run(s, w, cmd, 192);
    expect(toHU(length2D(s.vel))).toBeCloseTo(130, 0);

    const d = makeMoveState(0, 0.01, 0);
    settle(d, w);
    cmd.buttons = Buttons.DUCK;
    run(d, w, cmd, 192);
    expect(d.ducked).toBe(true);
    expect(toHU(length2D(d.vel))).toBeCloseTo(85, 0);
  });

  it('friction stops a running player in about 0.4 s', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.forward = 1;
    run(s, w, cmd, 192);
    cmd.forward = 0;
    let ticks = 0;
    while (length2D(s.vel) > 0 && ticks < 100) {
      playerMove(s, cmd, w, TICK);
      ticks++;
    }
    expect(ticks).toBeGreaterThan(18);
    expect(ticks).toBeLessThan(32);
  });

  it('counter-strafing drops below 34% of max speed within 6 ticks', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.side = 1;
    run(s, w, cmd, 192);
    cmd.side = -1;
    let ticks = 0;
    while (toHU(length2D(s.vel)) > 250 * 0.34) {
      playerMove(s, cmd, w, TICK);
      ticks++;
    }
    expect(ticks).toBeLessThanOrEqual(6);
  });

  it('walks across coplanar floor seams without snagging', () => {
    const sw = worldFrom([
      { min: [-10, -1, -10], max: [0, 0, 10] },
      { min: [0, -1, -10], max: [10, 0, 10] },
      { min: [10, -1, -10], max: [30, 0, 10] },
    ]);
    const s = makeMoveState(-8, 0.01, 0);
    s.pos.x = -8;
    settle(s, sw);
    const cmd = makeCmd();
    cmd.yaw = -Math.PI / 2; // face +X
    cmd.forward = 1;
    run(s, sw, cmd, 128);
    const minSpeed = { v: Infinity };
    run(s, sw, cmd, 64, () => (minSpeed.v = Math.min(minSpeed.v, toHU(length2D(s.vel)))));
    expect(minSpeed.v).toBeGreaterThan(249);
    expect(s.pos.x).toBeGreaterThan(10);
  });
});

describe('pmove jumping and air control', () => {
  const w = worldFrom([FLOOR]);

  it('jump apex is ~57 HU', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const y0 = s.pos.y;
    const cmd = makeCmd();
    cmd.buttons = Buttons.JUMP;
    cmd.pressed = Buttons.JUMP;
    let apex = 0;
    run(s, w, cmd, 64, () => (apex = Math.max(apex, s.pos.y - y0)));
    expect(toHU(apex)).toBeGreaterThan(56);
    expect(toHU(apex)).toBeLessThan(58);
  });

  it('holding jump does not re-jump (no pogo) unless auto-bhop is on', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.buttons = Buttons.JUMP;
    cmd.pressed = Buttons.JUMP;
    let jumps = 0;
    for (let i = 0; i < 200; i++) {
      playerMove(s, cmd, w, TICK);
      cmd.pressed = 0;
      if (s.jumped) jumps++;
    }
    expect(jumps).toBe(1);

    const b = makeMoveState(0, 0.01, 0);
    settle(b, w);
    jumps = 0;
    for (let i = 0; i < 200; i++) {
      playerMove(b, cmd, w, TICK, { autoBhop: true });
      if (b.jumped) jumps++;
    }
    expect(jumps).toBeGreaterThan(3);
  });

  it('skips friction on the jump tick', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.forward = 1;
    run(s, w, cmd, 192);
    cmd.buttons = Buttons.JUMP;
    cmd.pressed = Buttons.JUMP;
    playerMove(s, cmd, w, TICK);
    expect(s.jumped).toBe(true);
    expect(toHU(length2D(s.vel))).toBeCloseTo(250, 0);
  });

  it('W-only in the air gains no speed; synchronized strafing does', () => {
    const tall = worldFrom([{ min: [-2000, -1001, -2000], max: [2000, -1000, 2000] }]);
    const s = makeMoveState(0, 0, 0);
    s.vel.z = -250 * HU;
    const cmd = makeCmd();
    cmd.forward = 1;
    run(s, tall, cmd, 64);
    expect(toHU(length2D(s.vel))).toBeLessThanOrEqual(250.001);

    const a = makeMoveState(0, 0, 0);
    a.vel.z = -250 * HU;
    const sc = makeCmd();
    sc.side = 1;
    for (let i = 0; i < 64; i++) {
      // Keep the strafe (right) direction perpendicular to velocity, like turning the mouse.
      const l = length2D(a.vel);
      const px = a.vel.z / l;
      const pz = -a.vel.x / l;
      sc.yaw = Math.atan2(-pz, px);
      playerMove(a, sc, tall, TICK);
    }
    expect(toHU(length2D(a.vel))).toBeGreaterThan(300);
  });

  it('crouch-jumping reaches higher than a plain jump', () => {
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const y0 = s.pos.y;
    const cmd = makeCmd();
    cmd.buttons = Buttons.JUMP;
    cmd.pressed = Buttons.JUMP;
    let apex = 0;
    run(s, w, cmd, 64, (i) => {
      if (i === 10) cmd.buttons |= Buttons.DUCK;
      apex = Math.max(apex, s.pos.y - y0);
    });
    expect(toHU(apex)).toBeGreaterThan(64);
  });
});

describe('pmove steps, ramps and ceilings', () => {
  function walkInto(boxHeightHU: number) {
    const w = worldFrom([FLOOR, { min: [2, 0, -5], max: [6, boxHeightHU * HU, 5] }]);
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.yaw = -Math.PI / 2;
    cmd.forward = 1;
    run(s, w, cmd, 96);
    return s;
  }

  it('steps up 17.5 HU but not 19 HU', () => {
    expect(walkInto(17.5).pos.x).toBeGreaterThan(3);
    expect(walkInto(19).pos.x).toBeLessThan(2);
  });

  it('walks up a 30° ramp and slides off a 50° ramp', () => {
    const run30 = 4;
    const h30 = run30 * Math.tan((30 * Math.PI) / 180);
    const w = worldFrom([FLOOR, { min: [1, 0, -5], max: [1 + run30, h30, 5], ramp: Ramp.PosX }]);
    const s = makeMoveState(0, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.yaw = -Math.PI / 2;
    cmd.forward = 1;
    run(s, w, cmd, 96);
    expect(s.pos.x).toBeGreaterThan(1 + run30 - 0.5);

    const run50 = 2;
    const h50 = run50 * Math.tan((50 * Math.PI) / 180);
    const w2 = worldFrom([FLOOR, { min: [0, 0, -5], max: [run50, h50, 5], ramp: Ramp.PosX }]);
    const r = makeMoveState(1, h50 / 2 + 0.1, 0);
    const idle = makeCmd();
    run(r, w2, idle, 8);
    expect(r.onGround).toBe(false);
    run(r, w2, idle, 128);
    expect(r.pos.x).toBeLessThan(0.1);
  });

  it('cannot stand up under a low ceiling', () => {
    const w = worldFrom([FLOOR, { min: [-5, 60 * HU, -5], max: [5, 70 * HU, 5] }]);
    const s = makeMoveState(0, 0.01, 0);
    s.ducked = true;
    s.duckAmount = 1;
    settle(s, w);
    const cmd = makeCmd();
    run(s, w, cmd, 32);
    expect(s.ducked).toBe(true);
  });

  it('never ends inside solid during random input (fuzz)', () => {
    const w = worldFrom([
      FLOOR,
      { min: [2, 0, -2], max: [3, 1, 2] },
      { min: [-3, 0, 1], max: [-1, 0.4, 3] },
      { min: [-6, 0, -6], max: [-2, 1.5, -2], ramp: Ramp.NegZ },
      { min: [4, 0, 4], max: [8, 2.5, 4.3] },
      { min: [-10, 0, -10], max: [10, 4, -9.7] },
      { min: [-10, 0, 9.7], max: [10, 4, 10] },
      { min: [-10, 0, -10], max: [-9.7, 4, 10] },
      { min: [9.7, 0, -10], max: [10, 4, 10] },
      { min: [0, 1.2, 4], max: [3, 1.5, 7] },
    ]);
    const s = makeMoveState(0, 0.01, 0);
    const cmd = makeCmd();
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    let stuckStart = 0;
    for (let i = 0; i < 20000; i++) {
      if (i % 16 === 0) {
        cmd.forward = Math.floor(rnd() * 3) - 1;
        cmd.side = Math.floor(rnd() * 3) - 1;
        cmd.buttons = (rnd() < 0.3 ? Buttons.DUCK : 0) | (rnd() < 0.2 ? Buttons.WALK : 0);
        cmd.pressed = rnd() < 0.4 ? Buttons.JUMP : 0;
      } else cmd.pressed = 0;
      cmd.yaw += (rnd() - 0.5) * 0.3;
      if (i === 0) stuckStart = s.stuckEvents;
      playerMove(s, cmd, w, TICK);
      expect(Number.isFinite(s.pos.x + s.pos.y + s.pos.z)).toBe(true);
      expect(Math.abs(s.pos.x)).toBeLessThan(10);
      expect(Math.abs(s.pos.z)).toBeLessThan(10);
      expect(s.pos.y).toBeGreaterThan(-0.01);
    }
    expect(s.stuckEvents - stuckStart).toBe(0);
  });
});

describe('pmove ladders', () => {
  // A 6 m building from x = 2, with a ladder volume on its -X face.
  const building = { min: [2, 0, -5] as [number, number, number], max: [10, 6, 5] as [number, number, number] };
  const ladder = { min: [1.7, 0, -0.4] as [number, number, number], max: [2, 7, 0.4] as [number, number, number], contents: Contents.LADDER };
  const w = worldFrom([FLOOR, building, ladder]);

  function atLadder(): MoveState {
    const s = makeMoveState(1.5, 0.01, 0);
    settle(s, w);
    return s;
  }

  it('climbs to the top and steps onto the roof', () => {
    const s = atLadder();
    const cmd = makeCmd();
    cmd.yaw = -Math.PI / 2; // face +X, into the wall
    cmd.forward = 1;
    let climbing = false;
    for (let i = 0; i < 64 * 4 && !(s.onGround && s.pos.y > 5); i++) {
      playerMove(s, cmd, w, TICK);
      climbing ||= s.onLadder;
    }
    expect(climbing).toBe(true);
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeCloseTo(6, 1);
    expect(s.pos.x).toBeGreaterThan(2.3);
  });

  it('holds on without input and climbs down looking down', () => {
    const s = atLadder();
    const cmd = makeCmd();
    cmd.yaw = -Math.PI / 2;
    cmd.forward = 1;
    run(s, w, cmd, 64);
    const y = s.pos.y;
    expect(y).toBeGreaterThan(2);
    cmd.forward = 0;
    run(s, w, cmd, 64);
    expect(s.pos.y).toBeCloseTo(y, 2);
    cmd.forward = 1;
    cmd.pitch = -1.5;
    run(s, w, cmd, 64 * 3);
    expect(s.pos.y).toBeLessThan(0.1);
    expect(s.onGround).toBe(true);
  });

  it('jumps off away from the wall', () => {
    const s = atLadder();
    const cmd = makeCmd();
    cmd.yaw = -Math.PI / 2;
    cmd.forward = 1;
    run(s, w, cmd, 64);
    cmd.forward = 0;
    cmd.pressed = Buttons.JUMP;
    run(s, w, cmd, 64 * 2);
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeLessThan(0.1);
    expect(s.pos.x).toBeLessThan(1);
  });
});

describe('pmove mantling', () => {
  function tryWall(height: number, extra: Parameters<typeof worldFrom>[0] = []): MoveState {
    const w = worldFrom([FLOOR, { min: [2, 0, -3], max: [40, height, 3] }, ...extra]);
    // Standing right at the wall.
    const s = makeMoveState(1.5, 0.01, 0);
    settle(s, w);
    const cmd = makeCmd();
    cmd.yaw = -Math.PI / 2;
    cmd.forward = 1;
    cmd.buttons = Buttons.JUMP;
    cmd.pressed = Buttons.JUMP;
    run(s, w, cmd, 64 * 2);
    return s;
  }

  it('pulls up onto a 1.9 m wall a jump cannot clear', () => {
    const s = tryWall(1.9);
    expect(s.pos.y).toBeCloseTo(1.9, 1);
    expect(s.pos.x).toBeGreaterThan(2);
    expect(s.mantleT).toBe(0);
  });

  it('cannot reach a 2.6 m wall', () => {
    const s = tryWall(2.6);
    expect(s.pos.y).toBeLessThan(0.1);
  });

  it('needs headroom on top', () => {
    const s = tryWall(1.9, [{ min: [2, 2.9, -3], max: [40, 3.2, 3] }]);
    expect(s.pos.y).toBeLessThan(0.1);
  });
});
